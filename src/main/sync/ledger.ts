/**
 * Small facts sync must not lose, kept in the database.
 *
 * Not in `electron-store`: `settings:clear` wipes that file, and the database
 * survives it. A lost device id mints a phantom device (and the server's idle
 * retirement and rate limits count devices); a lost cursor turns the next pull
 * into a full replay. Same argument as `012_add_telemetry_state.sql`.
 */
import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'

import { nowMs, type Database } from '../data/db/client.js'

/** Anything that can run queries: the database, or a transaction on it. */
export type Db = Kysely<Database>

export const KEY_DEVICE_ID = 'deviceId'
export const KEY_ENABLED = 'enabled'
/** The next segment number this device will write. */
export const KEY_NEXT_SEQ = 'nextSeq'
/** The highest seq already folded into this device's snapshot on the server. */
export const KEY_SNAPSHOT_UP_TO = 'snapshotUpTo'
/** The hybrid-logical-clock high-water mark: the largest timestamp issued or seen. */
export const KEY_HLC = 'hlc'
export const KEY_LAST_SYNC_AT = 'lastSyncAt'
export const KEY_LAST_ERROR = 'lastError'
export const KEY_LAST_APPLIED = 'lastApplied'
/** Set once the first-login question has been answered and the first merge done. */
export const KEY_INITIALISED = 'initialised'
/** Someone else's segments need a newer build than this one. */
export const KEY_NEEDS_UPDATE = 'needsUpdate'

/** One cursor per remote device: the highest seq already applied from it. */
export const cursorKey = (device: string): string => `cursor:${device}`
/** And the `upToSeq` of the snapshot of theirs already applied. */
export const snapshotKey = (device: string): string => `snapshot:${device}`

export async function getState(db: Db, key: string): Promise<string | null> {
  const row = await db
    .selectFrom('SyncState')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
  return row?.value ?? null
}

export async function getNumber(db: Db, key: string, fallback = 0): Promise<number> {
  const raw = await getState(db, key)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export async function setState(db: Db, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.deleteFrom('SyncState').where('key', '=', key).execute()
    return
  }
  await db
    .insertInto('SyncState')
    .values({ key, value, updatedAt: nowMs() })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updatedAt: nowMs() }))
    .execute()
}

/**
 * This machine's identity to the sync server, minted on first use.
 *
 * Random and unrelated to anything else on the machine - in particular to the
 * telemetry install id. The two systems share no join key on purpose: one is
 * anonymous counting, the other is a Google account's data.
 */
export async function ensureDeviceId(db: Db): Promise<string> {
  const held = await getState(db, KEY_DEVICE_ID)
  if (held) return held
  const minted = `d-${randomBytes(12).toString('hex')}`
  await setState(db, KEY_DEVICE_ID, minted)
  return minted
}

/** The newest migration this build has applied: what a segment's `schemaVersion` means. */
export async function schemaVersion(db: Db): Promise<number> {
  const { rows } = await sql<{ v: number | null }>`
    SELECT MAX(version) AS v FROM schema_migrations
  `.execute(db)
  return Number(rows[0]?.v ?? 0)
}
