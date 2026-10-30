/**
 * The moments around a sync that are not a sync: turning it on, answering the
 * first-login question, backing up before anything is rewritten, and going back.
 *
 * Merging is irreversible in the ways that matter: this machine's test data does
 * not just stay here, it is pushed up and scattered to every other device. So
 * everything that rewrites local rows takes a copy of the database first
 * (`VACUUM INTO`, which is consistent while the engine is writing), keeps the
 * last three, and `restoreBackup` can put it back.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'kysely'

import { nowMs } from '../data/db/client.js'
import {
  KEY_ENABLED,
  KEY_HLC,
  KEY_INITIALISED,
  KEY_LAST_APPLIED,
  KEY_NEEDS_UPDATE,
  KEY_NEXT_SEQ,
  KEY_SNAPSHOT_UP_TO,
  type Db
} from './ledger.js'

export const BACKUP_DIR_NAME = 'sync-backup'
export const KEEP_BACKUPS = 3
/** Rolling pre-apply backups are their own pool, so they cannot push out the one taken before the first merge. */
export const KEEP_APPLY_BACKUPS = 2
export const APPLY_BACKUP_REASON = 'before-apply'

/**
 * Queue every row that could be sent, so that "turn sync on" uploads what was
 * already there and not only what changes from now on.
 *
 * `INSERT OR IGNORE`, so a pending deletion is not turned back into an upsert.
 * The demo-data guard is repeated here because this is the one place that
 * enqueues rows in bulk rather than through the triggers.
 */
export async function seedOutbox(db: Db): Promise<void> {
  const now = nowMs()
  await sql`
    INSERT OR IGNORE INTO SyncOutbox (tbl, uid, op, changedAt)
    SELECT 'Match', uid, 'upsert', ${now} FROM Match WHERE uid IS NOT NULL AND source IS NOT 'demo-seed'
  `.execute(db)
  await sql`
    INSERT OR IGNORE INTO SyncOutbox (tbl, uid, op, changedAt)
    SELECT 'Deck', uid, 'upsert', ${now} FROM Deck WHERE uid IS NOT NULL AND sourceRef IS NOT 'demo-seed'
  `.execute(db)
  await sql`
    INSERT OR IGNORE INTO SyncOutbox (tbl, uid, op, changedAt)
    SELECT 'Tag', uid, 'upsert', ${now} FROM Tag WHERE uid IS NOT NULL
  `.execute(db)
  await sql`
    INSERT OR IGNORE INTO SyncOutbox (tbl, uid, op, changedAt)
    SELECT 'DeckCategory', id, 'upsert', ${now} FROM DeckCategory
  `.execute(db)
}

/** Whether this machine has any games of its own - the condition for the first-login question. */
export async function hasLocalMatches(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('Match')
    .select('id')
    .where((eb) => eb.or([eb('source', 'is', null), eb('source', '!=', 'demo-seed')]))
    .limit(1)
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Forget everything sync knew, and stop. Keeps the device id: it identifies the
 * machine, not the account, and a new one would be a phantom device.
 */
export async function resetLedger(db: Db): Promise<void> {
  for (const table of ['SyncOutbox', 'SyncRowMeta', 'SyncAlias', 'SyncPending'] as const) {
    await db.deleteFrom(table).execute()
  }
  await db
    .deleteFrom('SyncState')
    .where((eb) =>
      eb.or([
        eb('key', 'like', 'cursor:%'),
        eb('key', 'like', 'snapshot:%'),
        eb('key', 'in', [
          KEY_ENABLED,
          KEY_HLC,
          KEY_INITIALISED,
          KEY_LAST_APPLIED,
          KEY_NEEDS_UPDATE,
          KEY_NEXT_SEQ,
          KEY_SNAPSHOT_UP_TO,
          'lastApplyBackup',
          'backoffUntil'
        ])
      ])
    )
    .execute()
}

/** The tables the user owns, parents before children. */
const OWNED = [
  'DeckCategory',
  'Tag',
  'Deck',
  'Match',
  'MatchTag',
  'DeckCard',
  'MatchOpeningCard'
] as const

/**
 * Throw away local games, decks and tags - the "cloud wins" answer.
 *
 * Suppressed, so none of it is recorded as a deletion to send: this is not the
 * user deleting things, it is this machine adopting someone else's state.
 */
export async function wipeLocal(db: Db): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('SyncSuppress')
      .values({ one: 1 })
      .onConflict((oc) => oc.doNothing())
      .execute()
    await tx.deleteFrom('Match').execute()
    await tx.deleteFrom('Deck').execute()
    await tx.deleteFrom('Tag').execute()
    // Builtin categories are not the user's to lose: every machine has them.
    await tx
      .deleteFrom('DeckCategory')
      .where('id', 'not in', ['aggro', 'midrange', 'control'])
      .execute()
    await tx.deleteFrom('SyncSuppress').execute()
  })
}

// ------------------------------------------------------------------- backups

export interface BackupInfo {
  file: string
  createdAt: number
  reason: string
  bytes: number
}

/** `app-<ms>-<reason>.db`: sorts by time, and says why it exists. */
export async function backUp(
  db: Db,
  dir: string,
  reason: string,
  opts: { prune?: boolean } = {}
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `app-${nowMs()}-${reason.replace(/[^a-z0-9-]/gi, '')}.db`)
  await sql`VACUUM INTO ${target}`.execute(db)
  if (opts.prune === false) return target
  // Two pools. The backup taken before the first merge is the one a user is
  // most likely to need, and a rolling one made every few hours would otherwise
  // age it out within a day.
  const isApply = reason === APPLY_BACKUP_REASON
  const pool = (await listBackups(dir)).filter(
    (b) => (b.reason === APPLY_BACKUP_REASON) === isApply
  )
  for (const old of pool.slice(isApply ? KEEP_APPLY_BACKUPS : KEEP_BACKUPS)) {
    await fs.rm(old.file, { force: true }).catch(() => undefined)
  }
  return target
}

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: BackupInfo[] = []
  for (const name of names) {
    const m = /^app-(\d+)-(.*)\.db$/.exec(name)
    if (!m) continue
    const file = path.join(dir, name)
    const stat = await fs.stat(file).catch(() => null)
    if (stat) out.push({ file, createdAt: Number(m[1]), reason: m[2], bytes: stat.size })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Put the database's contents back as they were in a backup, and turn sync off.
 *
 * It restores rows rather than swapping the file: the database is open in a
 * worker and in the engine, and replacing a file under two processes is how
 * corruption happens. Sync is turned off and its ledger cleared because the
 * ledger describes a state that no longer exists; signing in again re-runs the
 * first-login question against whatever is in the cloud by then.
 */
export async function restoreBackup(db: Db, file: string): Promise<void> {
  await sql`ATTACH DATABASE ${file} AS bak`.execute(db)
  try {
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('SyncSuppress')
        .values({ one: 1 })
        .onConflict((oc) => oc.doNothing())
        .execute()
      await tx.deleteFrom('Match').execute()
      await tx.deleteFrom('Deck').execute()
      await tx.deleteFrom('Tag').execute()
      await tx.deleteFrom('DeckCategory').execute()
      for (const table of OWNED) {
        // Column lists, not `SELECT *`: a backup made by an older build has
        // fewer columns, and positional copying would shift every one of them.
        const cols = await sql<{ name: string }>`
          SELECT name FROM pragma_table_info(${table}, 'bak')
        `.execute(tx)
        const names = cols.rows.map((r) => `"${r.name}"`).join(', ')
        if (names === '') continue
        await sql
          .raw(
            `INSERT OR IGNORE INTO main."${table}" (${names}) SELECT ${names} FROM bak."${table}"`
          )
          .execute(tx)
      }
      await tx.deleteFrom('SyncSuppress').execute()
    })
  } finally {
    await sql`DETACH DATABASE bak`.execute(db).catch(() => undefined)
  }
  await resetLedger(db)
}
