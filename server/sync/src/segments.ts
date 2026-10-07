/**
 * Segments and snapshots: the data plane.
 *
 * Storage is two-layered and the split is deliberate:
 *   - R2 holds the bytes, at keys the SERVER builds from the token's `sub`, the
 *     token's device and a validated integer. A client never supplies a path,
 *     so there is nothing to traverse.
 *   - D1 holds an index of them (`segments` rows, the snapshot columns on
 *     `devices`). A sync round lists from D1: reads are the cheap budget, and
 *     R2 `list` is a Class A operation, the metered one that
 *     docs/account-sync-plan.md names as the real cost bottleneck.
 *
 * Consistency, since two stores cannot share a transaction: the D1 row is
 * claimed FIRST, then the object is written, and a failed write releases the
 * claim. A crash in between leaves a row whose object is missing - a reader
 * gets 404 until the client retries the push, and the retry (same hash)
 * re-writes the object rather than just saying "already there" - or an orphan
 * object, which account deletion sweeps by prefix.
 */
import { ApiError, json, readCapped } from './http'
import { hex, sha256 } from './jwt'
import { MAX_SEGMENT_BYTES, MAX_SEQ, MAX_SNAPSHOT_BYTES, DEVICE_ID_RE } from './limits'
import { countRound } from './limits'
import { getDevice, type DeviceRow } from './devices'
import type { Deps, Session } from './types'

export const accountPrefix = (sub: string): string => `users/${sub}/`
export const devicePrefix = (sub: string, device: string): string =>
  `users/${sub}/devices/${device}/`
export const segmentKey = (sub: string, device: string, seq: number): string =>
  `${devicePrefix(sub, device)}${String(seq).padStart(6, '0')}.jsonl`
export const snapshotKey = (sub: string, device: string): string =>
  `${devicePrefix(sub, device)}snapshot.jsonl`

const NDJSON = 'application/x-ndjson'

export function parseSeq(raw: string): number {
  if (!/^\d{1,6}$/.test(raw))
    throw new ApiError(422, 'invalid', 'seq must be an integer from 0 to 999999.')
  const seq = Number(raw)
  if (seq > MAX_SEQ) throw new ApiError(422, 'invalid', 'seq must be an integer from 0 to 999999.')
  return seq
}

const quotaError = (): ApiError =>
  new ApiError(413, 'quota', 'This account is over its storage quota.')

/** `schemaVersion` from the header line, if there is a parseable one. Never throws. */
function schemaVersionOf(body: Uint8Array): number | null {
  const firstLine = new TextDecoder()
    .decode(body.subarray(0, Math.min(body.length, 4096)))
    .split('\n')[0]
  try {
    const parsed = JSON.parse(firstLine) as { schemaVersion?: unknown }
    const value = parsed?.schemaVersion
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

async function bytesUsed(deps: Deps, sub: string): Promise<number> {
  const row = await deps.db
    .prepare(`SELECT bytesUsed FROM accounts WHERE sub = ?1`)
    .bind(sub)
    .first<{ bytesUsed: number }>()
  return row?.bytesUsed ?? 0
}

// ---------------------------------------------------------------- GET /v1/segments

/**
 * The other devices' state. Counts as one sync round.
 *
 * Retired devices stay in the list - that is the point of the fold: a new
 * machine can still pull the data of a computer that was retired for being
 * idle. Revoked ones stay too: revoking stops a device WRITING, it does not
 * un-own the data it already contributed.
 */
export async function listSegments(deps: Deps, session: Session): Promise<Response> {
  await countRound(deps, session.sub)

  const devices = await deps.db
    .prepare(
      `SELECT id, retiredAt, schemaVersion, snapshotSeq, snapshotBytes FROM devices
       WHERE sub = ?1 AND id != ?2 ORDER BY createdAt, id`
    )
    .bind(session.sub, session.deviceId)
    .all<Pick<DeviceRow, 'id' | 'retiredAt' | 'schemaVersion' | 'snapshotSeq' | 'snapshotBytes'>>()
  const segments = await deps.db
    .prepare(
      `SELECT s.device AS device, s.seq AS seq, s.bytes AS bytes
       FROM segments s JOIN devices d ON d.sub = s.sub AND d.id = s.device
       WHERE s.sub = ?1 AND s.device != ?2 AND s.seq > COALESCE(d.snapshotSeq, -1)
       ORDER BY s.device, s.seq`
    )
    .bind(session.sub, session.deviceId)
    .all<{ device: string; seq: number; bytes: number }>()

  const byDevice = new Map<string, Array<{ seq: number; bytes: number }>>()
  for (const row of segments.results) {
    const list = byDevice.get(row.device) ?? []
    list.push({ seq: row.seq, bytes: row.bytes })
    byDevice.set(row.device, list)
  }
  return json({
    devices: devices.results.map((d) => ({
      device: d.id,
      retired: d.retiredAt !== null,
      schemaVersion: d.schemaVersion,
      snapshot: d.snapshotSeq === null ? null : { upToSeq: d.snapshotSeq, bytes: d.snapshotBytes },
      segments: byDevice.get(d.id) ?? []
    }))
  })
}

// ---------------------------------------------------------------- PUT /v1/segments/{seq}

export async function putSegment(
  deps: Deps,
  session: Session,
  rawSeq: string,
  request: Request
): Promise<Response> {
  const seq = parseSeq(rawSeq)
  const claimed = (request.headers.get('x-content-sha256') ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(claimed)) {
    throw new ApiError(422, 'invalid', 'X-Content-SHA256 must be 64 hex characters.')
  }
  const { sub, deviceId } = session
  const device = await getDevice(deps, sub, deviceId)
  if (!device) throw new ApiError(401, 'unknown_device', 'This device is not registered.')

  const existing = await deps.db
    .prepare(`SELECT sha256 FROM segments WHERE sub = ?1 AND device = ?2 AND seq = ?3`)
    .bind(sub, deviceId, seq)
    .first<{ sha256: string }>()
  // A different hash for a seq that exists is refused before the body is read.
  if (existing && existing.sha256 !== claimed) throw conflictingSeq()
  // Folded into a snapshot already; the row is gone, the bytes are in there.
  // Re-creating the segment would double-apply history and re-spend quota, and
  // saying "ok" would silently lose a client that REUSED the number. Refuse.
  if (!existing && device.snapshotSeq !== null && seq <= device.snapshotSeq) {
    throw new ApiError(409, 'conflict', "That seq is already covered by this device's snapshot.")
  }

  const body = await readCapped(
    request,
    MAX_SEGMENT_BYTES,
    () => new ApiError(413, 'too_large', 'A segment may not exceed 1 MB.')
  )
  if (body.length === 0) throw new ApiError(422, 'invalid', 'A segment cannot be empty.')
  if (hex(await sha256(body)) !== claimed) {
    throw new ApiError(422, 'invalid', 'X-Content-SHA256 does not match the body.')
  }
  if (existing) {
    // The retry of a push that may have died between the index row and the
    // object. Writing identical bytes again is harmless and heals that case.
    await deps.bucket.put(segmentKey(sub, deviceId, seq), body)
    return json({ bytesUsed: await bytesUsed(deps, sub) })
  }

  // Reserve quota atomically: the UPDATE only applies while the sum still fits,
  // so parallel pushes cannot each pass a check and jointly overshoot.
  const reserved = await deps.db
    .prepare(
      `UPDATE accounts SET bytesUsed = bytesUsed + ?2 WHERE sub = ?1 AND bytesUsed + ?2 <= ?3`
    )
    .bind(sub, body.length, deps.config.quotaBytes)
    .run()
  if (reserved.meta.changes === 0) throw quotaError()
  const release = (): Promise<unknown> =>
    deps.db
      .prepare(`UPDATE accounts SET bytesUsed = MAX(0, bytesUsed - ?2) WHERE sub = ?1`)
      .bind(sub, body.length)
      .run()

  const now = deps.now()
  const inserted = await deps.db
    .prepare(
      `INSERT OR IGNORE INTO segments (sub, device, seq, bytes, sha256, createdAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(sub, deviceId, seq, body.length, claimed, now)
    .run()
  if (inserted.meta.changes === 0) {
    // Lost a race with a parallel PUT of the same seq.
    await release()
    const winner = await deps.db
      .prepare(`SELECT sha256 FROM segments WHERE sub = ?1 AND device = ?2 AND seq = ?3`)
      .bind(sub, deviceId, seq)
      .first<{ sha256: string }>()
    if (!winner) throw new ApiError(409, 'conflict', 'Try again.')
    if (winner.sha256 !== claimed) throw conflictingSeq()
    return json({ bytesUsed: await bytesUsed(deps, sub) })
  }

  try {
    await deps.bucket.put(segmentKey(sub, deviceId, seq), body)
  } catch (error) {
    await deps.db
      .prepare(`DELETE FROM segments WHERE sub = ?1 AND device = ?2 AND seq = ?3`)
      .bind(sub, deviceId, seq)
      .run()
    await release()
    throw error
  }

  const schemaVersion = schemaVersionOf(body)
  await deps.db
    .prepare(
      `UPDATE devices SET lastPushAt = ?3, maxSeq = MAX(maxSeq, ?4),
         schemaVersion = COALESCE(?5, schemaVersion)
       WHERE sub = ?1 AND id = ?2`
    )
    .bind(sub, deviceId, now, seq, schemaVersion)
    .run()
  return json({ bytesUsed: await bytesUsed(deps, sub) })
}

const conflictingSeq = (): ApiError =>
  new ApiError(409, 'conflict', 'That seq already exists with different content.')

// ---------------------------------------------------------------- PUT /v1/snapshot

export interface ReplaceOptions {
  /** The cron fold shrinks or preserves size and must not be refused for it. */
  enforceQuota: boolean
  /** A client push counts as activity; the cron's fold must not. */
  markPush: boolean
  /** Stamp `retiredAt` in the same transaction that swaps the snapshot in. */
  retire: boolean
}

/**
 * Replace a device's snapshot and drop the segments it now covers.
 *
 * Order matters and is the reverse of what reads best: write the new snapshot
 * object, THEN commit the index (one D1 batch), THEN delete the covered
 * objects. A crash after step one leaves the old index pointing at an
 * overwritten snapshot - which is a valid, newer snapshot of the same device -
 * and a crash after step two leaves orphan objects. Neither loses data; the
 * reverse order could.
 */
export async function replaceSnapshot(
  deps: Deps,
  device: Pick<DeviceRow, 'sub' | 'id' | 'snapshotBytes'>,
  upToSeq: number,
  body: Uint8Array,
  options: ReplaceOptions
): Promise<number> {
  const { sub, id } = device
  const covered = await deps.db
    .prepare(`SELECT seq, bytes FROM segments WHERE sub = ?1 AND device = ?2 AND seq <= ?3`)
    .bind(sub, id, upToSeq)
    .all<{ seq: number; bytes: number }>()
  const freed = covered.results.reduce((sum, row) => sum + row.bytes, 0) + device.snapshotBytes
  const delta = body.length - freed

  if (
    options.enforceQuota &&
    delta > 0 &&
    (await bytesUsed(deps, sub)) + delta > deps.config.quotaBytes
  ) {
    throw quotaError()
  }

  await deps.bucket.put(snapshotKey(sub, id), body)
  const now = deps.now()
  await deps.db.batch([
    deps.db
      .prepare(`DELETE FROM segments WHERE sub = ?1 AND device = ?2 AND seq <= ?3`)
      .bind(sub, id, upToSeq),
    deps.db
      .prepare(
        `UPDATE devices SET snapshotSeq = ?3, snapshotBytes = ?4,
           maxSeq = MAX(maxSeq, ?3),
           schemaVersion = COALESCE(?5, schemaVersion),
           lastPushAt = CASE WHEN ?6 = 1 THEN ?7 ELSE lastPushAt END,
           retiredAt = CASE WHEN ?8 = 1 THEN ?7 ELSE retiredAt END
         WHERE sub = ?1 AND id = ?2`
      )
      .bind(
        sub,
        id,
        upToSeq,
        body.length,
        schemaVersionOf(body),
        options.markPush ? 1 : 0,
        now,
        options.retire ? 1 : 0
      ),
    deps.db
      .prepare(`UPDATE accounts SET bytesUsed = MAX(0, bytesUsed + ?2) WHERE sub = ?1`)
      .bind(sub, delta)
  ])

  const keys = covered.results.map((row) => segmentKey(sub, id, row.seq))
  for (let i = 0; i < keys.length; i += 1000) await deps.bucket.delete(keys.slice(i, i + 1000))
  return bytesUsed(deps, sub)
}

export async function putSnapshot(
  deps: Deps,
  session: Session,
  rawUpTo: string | null,
  request: Request
): Promise<Response> {
  if (rawUpTo === null) throw new ApiError(422, 'invalid', 'upToSeq is required.')
  const upToSeq = parseSeq(rawUpTo)
  const device = await getDevice(deps, session.sub, session.deviceId)
  if (!device) throw new ApiError(401, 'unknown_device', 'This device is not registered.')
  // A snapshot may not claim LESS than the last one: the segments below it are
  // already gone, so a smaller claim would describe data that no longer exists.
  if (device.snapshotSeq !== null && upToSeq < device.snapshotSeq) {
    throw new ApiError(409, 'conflict', 'upToSeq may not move backwards.')
  }
  const body = await readCapped(
    request,
    MAX_SNAPSHOT_BYTES,
    () => new ApiError(413, 'too_large', 'A snapshot may not exceed 8 MB.')
  )
  if (body.length === 0) throw new ApiError(422, 'invalid', 'A snapshot cannot be empty.')
  const used = await replaceSnapshot(deps, device, upToSeq, body, {
    enforceQuota: true,
    markPush: true,
    retire: false
  })
  return json({ bytesUsed: used })
}

// ---------------------------------------------------------------- downloads

function ndjsonResponse(object: { body: ReadableStream<Uint8Array>; size: number }): Response {
  return new Response(object.body, {
    headers: {
      'content-type': NDJSON,
      'content-length': String(object.size),
      'cache-control': 'private, no-store'
    }
  })
}

/**
 * The device must be one of THIS account's. The existence check is a D1 read
 * keyed on `(sub, device)`, so another account's device is indistinguishable
 * from one that never existed: 404 either way.
 */
export async function getSegment(
  deps: Deps,
  session: Session,
  device: string,
  rawSeq: string
): Promise<Response> {
  const seq = parseSeq(rawSeq)
  const row = DEVICE_ID_RE.test(device)
    ? await deps.db
        .prepare(`SELECT 1 AS ok FROM segments WHERE sub = ?1 AND device = ?2 AND seq = ?3`)
        .bind(session.sub, device, seq)
        .first()
    : null
  if (!row) throw new ApiError(404, 'not_found', 'No such segment.')
  const object = await deps.bucket.get(segmentKey(session.sub, device, seq))
  if (!object) throw new ApiError(404, 'not_found', 'No such segment.')
  return ndjsonResponse(object)
}

export async function getSnapshot(deps: Deps, session: Session, device: string): Promise<Response> {
  const row = await getDevice(deps, session.sub, device)
  if (!row || row.snapshotSeq === null) throw new ApiError(404, 'not_found', 'No such snapshot.')
  const object = await deps.bucket.get(snapshotKey(session.sub, device))
  if (!object) throw new ApiError(404, 'not_found', 'No such snapshot.')
  return ndjsonResponse(object)
}
