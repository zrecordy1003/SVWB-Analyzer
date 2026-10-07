/** /v1/me, account deletion and export. */
import { activeDeviceCount } from './devices'
import { ApiError, json, noContent } from './http'
import { roundsToday } from './limits'
import { accountPrefix, segmentKey, snapshotKey } from './segments'
import type { Deps, Session } from './types'

export async function me(deps: Deps, session: Session): Promise<Response> {
  const account = await deps.db
    .prepare(`SELECT email, name, bytesUsed FROM accounts WHERE sub = ?1`)
    .bind(session.sub)
    .first<{ email: string; name: string | null; bytesUsed: number }>()
  // The token was valid and the device exists, so an account row is a given;
  // a missing one means it was deleted mid-request.
  if (!account) throw new ApiError(401, 'unknown_device', 'This account no longer exists.')
  return json({
    email: account.email,
    name: account.name,
    bytesUsed: account.bytesUsed,
    quotaBytes: deps.config.quotaBytes,
    activeDevices: await activeDeviceCount(deps, session.sub),
    syncRoundsToday: await roundsToday(deps, session.sub),
    roundsPerDay: deps.config.roundsPerDay
  })
}

/**
 * Erase the account: every object under `users/{sub}/`, then every D1 row.
 *
 * R2 first. If it dies halfway, the D1 rows are still there and the client
 * simply calls again; the other order would strand objects nothing points to
 * and nobody can find. Deleting the device rows is also what kills every token:
 * each request re-reads its device row, so the access JWTs (up to 15 minutes
 * left) and refresh tokens all stop working at once.
 *
 * The listing is by PREFIX, not from the D1 index, so it also removes orphans
 * left by a crashed push - "delete my data" has to mean all of it.
 */
export async function deleteAccount(deps: Deps, session: Session): Promise<Response> {
  const prefix = accountPrefix(session.sub)
  let cursor: string | undefined
  do {
    const page = await deps.bucket.list({ prefix, cursor, limit: 1000 })
    if (page.objects.length > 0) await deps.bucket.delete(page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  const sub = session.sub
  await deps.db.batch([
    deps.db.prepare(`DELETE FROM segments WHERE sub = ?1`).bind(sub),
    deps.db.prepare(`DELETE FROM devices WHERE sub = ?1`).bind(sub),
    deps.db.prepare(`DELETE FROM grants WHERE sub = ?1`).bind(sub),
    deps.db.prepare(`DELETE FROM rounds WHERE sub = ?1`).bind(sub),
    deps.db.prepare(`DELETE FROM accounts WHERE sub = ?1`).bind(sub)
  ])
  return noContent()
}

/**
 * Everything, as one NDJSON stream: per device, its snapshot and then its
 * segments in order. Each part carries its own header line (that is the
 * format), so the concatenation needs no framing of ours - only a newline
 * where a part did not end with one, so two parts can never fuse into one line.
 *
 * Objects are pulled one at a time as the client reads, so memory stays at one
 * object (at most 8 MB) however large the account is.
 */
export async function exportAccount(deps: Deps, session: Session): Promise<Response> {
  const sub = session.sub
  const devices = await deps.db
    .prepare(`SELECT id, snapshotSeq FROM devices WHERE sub = ?1 ORDER BY createdAt, id`)
    .bind(sub)
    .all<{ id: string; snapshotSeq: number | null }>()
  const segments = await deps.db
    .prepare(`SELECT device, seq FROM segments WHERE sub = ?1 ORDER BY device, seq`)
    .bind(sub)
    .all<{ device: string; seq: number }>()

  const keys: string[] = []
  for (const device of devices.results) {
    if (device.snapshotSeq !== null) keys.push(snapshotKey(sub, device.id))
    for (const segment of segments.results) {
      if (segment.device === device.id) keys.push(segmentKey(sub, device.id, segment.seq))
    }
  }

  let next = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (next < keys.length) {
        const object = await deps.bucket.get(keys[next++])
        if (!object) continue
        const bytes = new Uint8Array(await object.arrayBuffer())
        if (bytes.length === 0) continue
        controller.enqueue(bytes)
        if (bytes[bytes.length - 1] !== 10) controller.enqueue(new Uint8Array([10]))
        return
      }
      controller.close()
    }
  })
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson',
      'content-disposition': 'attachment; filename="svwb-sync-export.ndjson"',
      'cache-control': 'private, no-store'
    }
  })
}
