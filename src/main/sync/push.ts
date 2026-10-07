/**
 * Sending this machine's changes.
 *
 * The outbox says WHO is dirty; this reads their current state and ships it.
 * Nothing about the change itself is stored in the outbox - the row is read at
 * upload time - so a match edited fifty times costs one entry, and an edit made
 * while an upload is in flight is simply picked up by the next one.
 */
import { sql } from 'kysely'

import { nowMs } from '../data/db/client.js'
import {
  KEY_HLC,
  KEY_NEXT_SEQ,
  KEY_SNAPSHOT_UP_TO,
  getNumber,
  getState,
  setState,
  type Db
} from './ledger.js'
import { nextTs, type SyncTable } from './merge.js'
import { buildUpsert } from './rows.js'
import {
  SEGMENT_FORMAT,
  contentHash,
  serializeSegment,
  splitEntries,
  type Entry,
  type SegmentHeader
} from './segment.js'
import { SyncError, type Transport } from './transport.js'

/** How many outbox rows one pass reads. Several segments' worth. */
const READ_BATCH = 2000
/** A runaway ceiling, so one sync cannot upload a database's worth in a loop. */
const MAX_PASSES = 25
/** Own segments before the history is folded into a snapshot (plan: ~200). */
export const COMPACT_AFTER_SEGMENTS = 200

export interface PushResult {
  segments: number
  entries: number
}

export async function push(
  db: Db,
  transport: Transport,
  ctx: { deviceId: string; schemaVersion: number }
): Promise<PushResult> {
  const result: PushResult = { segments: 0, entries: 0 }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const pending = await db
      .selectFrom('SyncOutbox')
      .selectAll()
      .orderBy('changedAt')
      .limit(READ_BATCH)
      .execute()
    if (pending.length === 0) break

    let highWater = await getNumber(db, KEY_HLC)
    const built: Array<{ entry: Entry; changedAt: number }> = []
    const unsendable: Array<{ tbl: string; uid: string; changedAt: number }> = []
    for (const row of pending) {
      const tbl = row.tbl as SyncTable
      const ts = nextTs(row.changedAt, highWater)
      if (row.op === 'delete') {
        highWater = ts
        built.push({ entry: { tbl, uid: row.uid, op: 'delete', ts }, changedAt: row.changedAt })
        continue
      }
      const entry = await buildUpsert(db, tbl, row.uid, ts)
      if (entry === null) {
        // Gone, or not allowed to leave. Either way there is nothing to send;
        // a deletion would have its own `delete` entry.
        unsendable.push(row)
        continue
      }
      highWater = ts
      built.push({ entry, changedAt: row.changedAt })
    }

    // Entries that can never be sent must still leave the outbox, or this loop
    // would read them again forever.
    for (const row of unsendable) await clearOutbox(db, row.tbl, row.uid, row.changedAt)

    const byKey = new Map(built.map((b) => [`${b.entry.tbl}\0${b.entry.uid}`, b.changedAt]))
    for (const part of splitEntries(built.map((b) => b.entry))) {
      const seq = await uploadSegment(db, transport, ctx, part)
      await db.transaction().execute(async (tx) => {
        for (const entry of part) {
          await tx
            .insertInto('SyncRowMeta')
            .values({
              tbl: entry.tbl,
              uid: entry.uid,
              ts: entry.ts,
              device: ctx.deviceId,
              deletedAt: entry.op === 'delete' ? entry.ts : null
            })
            .onConflict((oc) =>
              oc.columns(['tbl', 'uid']).doUpdateSet({
                ts: entry.ts,
                device: ctx.deviceId,
                deletedAt: entry.op === 'delete' ? entry.ts : null
              })
            )
            .execute()
          // Only if it has not changed again since it was read: a newer edit
          // stays queued for the next pass.
          const changedAt = byKey.get(`${entry.tbl}\0${entry.uid}`)
          if (changedAt !== undefined) await clearOutbox(tx, entry.tbl, entry.uid, changedAt)
        }
        await setStateTx(tx, KEY_NEXT_SEQ, String(seq + 1))
        await setStateTx(tx, KEY_HLC, String(Math.max(highWater, ...part.map((e) => e.ts))))
      })
      result.segments++
      result.entries += part.length
    }
  }
  return result
}

async function clearOutbox(db: Db, tbl: string, uid: string, changedAt: number): Promise<void> {
  await db
    .deleteFrom('SyncOutbox')
    .where('tbl', '=', tbl)
    .where('uid', '=', uid)
    .where('changedAt', '=', changedAt)
    .execute()
}

async function setStateTx(tx: Db, key: string, value: string): Promise<void> {
  await tx
    .insertInto('SyncState')
    .values({ key, value, updatedAt: nowMs() })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updatedAt: nowMs() }))
    .execute()
}

/**
 * Upload one segment and return the seq it landed at.
 *
 * A `409` means this seq already holds DIFFERENT content - which happens when an
 * earlier attempt reached the server and this machine crashed before it
 * recorded that. Taking the next seq is correct, not merely convenient: the
 * earlier segment is a valid (older) record of the same rows, and applying both
 * is harmless because every row is decided by its timestamp.
 */
async function uploadSegment(
  db: Db,
  transport: Transport,
  ctx: { deviceId: string; schemaVersion: number },
  entries: Entry[]
): Promise<number> {
  let seq = await getNumber(db, KEY_NEXT_SEQ, 1)
  for (let attempt = 0; attempt < 4; attempt++) {
    const header: SegmentHeader = {
      v: SEGMENT_FORMAT,
      schemaVersion: ctx.schemaVersion,
      device: ctx.deviceId,
      seq,
      hlc: Math.max(...entries.map((e) => e.ts))
    }
    const body = serializeSegment(header, entries)
    try {
      await transport.putSegment(seq, body, contentHash(body))
      return seq
    } catch (e) {
      if (e instanceof SyncError && e.status === 409) {
        seq++
        continue
      }
      throw e
    }
  }
  throw new SyncError(409, 'conflict', 'could not find a free segment number')
}

/**
 * Fold this device's history into one snapshot, once it has grown long enough.
 *
 * What goes in is not the log but the CURRENT state of every row this machine
 * was last to write (`SyncRowMeta.device`), tombstones included: anything
 * another device wrote since is that device's to carry, and anything older of
 * ours has been superseded. A new device then reads one snapshot per peer
 * instead of replaying every segment.
 */
export async function compactIfNeeded(
  db: Db,
  transport: Transport,
  ctx: { deviceId: string; schemaVersion: number },
  threshold = COMPACT_AFTER_SEGMENTS
): Promise<boolean> {
  const next = await getNumber(db, KEY_NEXT_SEQ, 1)
  const upTo = await getNumber(db, KEY_SNAPSHOT_UP_TO, 0)
  if (next - 1 - upTo < threshold) return false

  // Nothing may be in flight: a row dirtied since the last push is not part of
  // `upTo`, and would be lost if the snapshot claimed to cover it.
  const dirty = await db
    .selectFrom('SyncOutbox')
    .select(sql<number>`1`.as('one'))
    .limit(1)
    .execute()
  if (dirty.length > 0) return false

  const own = await db
    .selectFrom('SyncRowMeta')
    .selectAll()
    .where('device', '=', ctx.deviceId)
    .execute()
  const entries: Entry[] = []
  for (const m of own) {
    const tbl = m.tbl as SyncTable
    if (m.deletedAt !== null) {
      entries.push({ tbl, uid: m.uid, op: 'delete', ts: m.ts })
      continue
    }
    const entry = await buildUpsert(db, tbl, m.uid, m.ts)
    if (entry) entries.push(entry)
  }
  const upToSeq = next - 1
  const header: SegmentHeader = {
    v: SEGMENT_FORMAT,
    schemaVersion: ctx.schemaVersion,
    device: ctx.deviceId,
    seq: upToSeq,
    hlc: Math.max(0, ...entries.map((e) => e.ts))
  }
  await transport.putSnapshot(upToSeq, serializeSegment(header, entries))
  await setState(db, KEY_SNAPSHOT_UP_TO, String(upToSeq))
  return true
}

/** Whether anything is waiting to be sent. Cheap: used to decide if a sync is worth a request. */
export async function hasPending(db: Db): Promise<boolean> {
  const row = await db.selectFrom('SyncOutbox').select('tbl').limit(1).executeTakeFirst()
  return row !== undefined
}

/** Used by status screens: how many changes have not left yet. */
export async function pendingCount(db: Db): Promise<number> {
  const row = await db
    .selectFrom('SyncOutbox')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

export { getState }
