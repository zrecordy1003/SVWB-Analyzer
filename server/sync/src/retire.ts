/**
 * The nightly job: retire idle devices (folding their log) and prune.
 *
 * "Idle" is 90 days with no push - measured from `lastPushAt`, or from
 * `createdAt` if the device never pushed (docs/sync-protocol.md), and
 * restarted by `revivedAt` when a retired device signs back in. Without that
 * last term a revived device would be retired again the very next night.
 *
 * What retirement does to a device with data:
 *   1. merge its snapshot and segments into ONE snapshot (fold.ts),
 *   2. swap that in, delete the segments, stamp `retiredAt` - one D1 batch,
 *   3. its refresh is refused from then on (auth.ts reads `retiredAt`).
 * It stays in GET /v1/segments as `retired: true` with no segments and one
 * snapshot, so a brand-new machine still receives its rows.
 *
 * Budget. A Worker invocation has a hard cap on subrequests (50 on the free
 * plan), and every R2 and D1 call counts. So each run spends at most
 * `OPS_PER_RUN` of them and leaves the rest of the backlog for tomorrow; a
 * retirement being a day late costs nothing. A device that could never fit in
 * one run (hundreds of segments) is retired WITHOUT folding rather than
 * wedging the queue - its segments stay and are still served; the fold is an
 * optimisation of what a newcomer downloads, not of correctness.
 */
import { foldJsonl } from './fold'
import { RETIRE_AFTER_MS, utcDay } from './limits'
import { replaceSnapshot, segmentKey, snapshotKey } from './segments'
import type { Deps } from './types'

const OPS_PER_RUN = 40
const CANDIDATES_PER_RUN = 100
/** Beyond this, folding in memory is riskier than leaving the segments be. */
const FOLD_MAX_BYTES = 32 * 1024 * 1024
/** D1 round trips one retirement costs, beside its R2 calls. */
const D1_OPS_PER_DEVICE = 3

export interface RetireReport {
  retired: number
  folded: number
  /** Retired without a fold because it could not fit the budget or memory bound. */
  retiredUnfolded: number
  /** Left for tomorrow's run. */
  deferred: number
}

export async function retireIdleDevices(deps: Deps): Promise<RetireReport> {
  const report: RetireReport = { retired: 0, folded: 0, retiredUnfolded: 0, deferred: 0 }
  const now = deps.now()
  const idle = await deps.db
    .prepare(
      `SELECT sub, id, snapshotSeq, snapshotBytes FROM devices
       WHERE retiredAt IS NULL
         AND MAX(COALESCE(lastPushAt, 0), COALESCE(revivedAt, 0), createdAt) < ?1
       ORDER BY MAX(COALESCE(lastPushAt, 0), COALESCE(revivedAt, 0), createdAt)
       LIMIT ?2`
    )
    .bind(now - RETIRE_AFTER_MS, CANDIDATES_PER_RUN)
    .all<{ sub: string; id: string; snapshotSeq: number | null; snapshotBytes: number }>()

  let ops = 1
  for (const device of idle.results) {
    const segments = await deps.db
      .prepare(`SELECT seq, bytes FROM segments WHERE sub = ?1 AND device = ?2 ORDER BY seq`)
      .bind(device.sub, device.id)
      .all<{ seq: number; bytes: number }>()
    ops += 1

    const markRetired = async (): Promise<void> => {
      await deps.db
        .prepare(`UPDATE devices SET retiredAt = ?3 WHERE sub = ?1 AND id = ?2`)
        .bind(device.sub, device.id, now)
        .run()
      ops += 1
      report.retired++
    }

    // Nothing to fold: either no data at all, or only a snapshot already.
    if (segments.results.length === 0) {
      await markRetired()
      continue
    }

    const total = segments.results.reduce((sum, s) => sum + s.bytes, 0) + device.snapshotBytes
    // Snapshot get (if any) + one get per segment + the put + one batched
    // delete + the D1 calls.
    const cost =
      segments.results.length + (device.snapshotSeq === null ? 0 : 1) + 2 + D1_OPS_PER_DEVICE
    if (total > FOLD_MAX_BYTES || cost > OPS_PER_RUN - 1) {
      await markRetired()
      report.retiredUnfolded++
      continue
    }
    if (ops + cost > OPS_PER_RUN) {
      report.deferred++
      continue
    }

    const texts: string[] = []
    const decoder = new TextDecoder()
    const read = async (key: string): Promise<void> => {
      const object = await deps.bucket.get(key)
      ops += 1
      if (object) texts.push(decoder.decode(await object.arrayBuffer()))
    }
    if (device.snapshotSeq !== null) await read(snapshotKey(device.sub, device.id))
    for (const segment of segments.results)
      await read(segmentKey(device.sub, device.id, segment.seq))

    const upToSeq = segments.results[segments.results.length - 1].seq
    const folded = foldJsonl(texts, { device: device.id, seq: upToSeq })
    await replaceSnapshot(
      deps,
      { sub: device.sub, id: device.id, snapshotBytes: device.snapshotBytes },
      upToSeq,
      new TextEncoder().encode(folded.text),
      { enforceQuota: false, markPush: false, retire: true }
    )
    ops += D1_OPS_PER_DEVICE + 2
    report.retired++
    report.folded++
  }

  // Housekeeping: both are tiny, and unbounded without it.
  await deps.db.prepare(`DELETE FROM grants WHERE expiresAt < ?1`).bind(now).run()
  await deps.db
    .prepare(`DELETE FROM rounds WHERE day < ?1`)
    .bind(utcDay(now - 3 * 24 * 3600_000))
    .run()
  return report
}
