/**
 * The UI's database access: Kysely over better-sqlite3.
 *
 * This replaces the Prisma client, and with it the 21MB query engine, the
 * generated types, and the per-call IPC to that engine - the overhead the 3s
 * stats cache existed to hide. Reads and user edits happen here; MATCH RECORDING
 * does not: the engine owns that path (see tools/engine/src/store.rs), and both
 * sides run WAL so readers never block the writer.
 *
 * # The boundary contract
 *
 * SQLite stores epoch-millisecond INTEGERs and 0/1; everything above this file
 * consumes `Date` and `boolean`, because that is what Prisma handed out and the
 * renderer was built on it. The `Row` types below are the STORED shapes; the
 * exported mappers convert at the boundary. Keep the two in sync with
 * `resources/migrations/*.sql`, which remains the schema's single source of
 * truth - this file declares no schema, it only describes the existing one.
 */
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect, type Generated, type Selectable } from 'kysely'

import type { Deck, DeckCategory, GameMode, Match, Tag } from '../../../shared/domain.js'

// ---------------------------------------------------------------- stored shapes

export interface MatchRow {
  id: Generated<number>
  result: number | null
  play_order: string
  my_class: string
  oppo_class: string
  my_deckId: number | null
  oppo_deckId: number | null
  mode: string | null
  bp: number | null
  mp: number | null
  delta_mp: number | null
  current_cr: number | null
  delta_cr: number | null
  durationTime: number | null
  playedAt: number
  endedAt: number | null
  year: number | null
  month: number | null
  day: number | null
  note: string | null
  updatedAt: number | null
}

export interface DeckRow {
  id: Generated<number>
  name: string
  class: string
  createdAt: number
  updatedAt: number | null
  isDefault: number
  categoryId: string | null
}

export interface DeckCategoryRow {
  id: string
  name: string
  sort: number | null
  createdAt: number
  updatedAt: number | null
}

export interface TagRow {
  id: Generated<number>
  name: string
  createdAt: number
  updatedAt: number | null
}

export interface MatchTagRow {
  matchId: number
  tagId: number
}

export interface Database {
  Match: MatchRow
  Deck: DeckRow
  DeckCategory: DeckCategoryRow
  Tag: TagRow
  MatchTag: MatchTagRow
}

// -------------------------------------------------------------------- the client

let _db: Kysely<Database> | null = null

/** Set by `initDatabase()`, which runs the engine's migrations first. */
let _dbPath: string | null = null

export function configureDbPath(path: string): void {
  _dbPath = path
}

export function getDb(): Kysely<Database> {
  if (_db) return _db
  if (!_dbPath) {
    throw new Error('database path not set. Call initDatabase() first.')
  }
  const sqlite = new SQLite(_dbPath)
  // WAL matches the engine's writer side; busy_timeout covers the moment a user
  // edit lands while the engine is mid-commit.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  _db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  return _db
}

/** Tests swap databases between cases; production never calls this. */
export async function resetDbForTests(): Promise<void> {
  await closeDb()
  _dbPath = null
}

export async function closeDb(): Promise<void> {
  const db = _db
  _db = null
  if (db) await db.destroy()
}

// ------------------------------------------------------------ boundary mappers

const toDate = (ms: number): Date => new Date(ms)
const toDateOrNull = (ms: number | null): Date | null => (ms === null ? null : new Date(ms))

/** What callers hand in for date columns; stored as epoch ms. */
export const toMs = (d: Date | string | number): number => new Date(d).getTime()

export function matchFromRow(row: Selectable<MatchRow>): Match {
  return {
    ...row,
    result: row.result === null ? null : row.result === 1,
    play_order: row.play_order as Match['play_order'],
    my_class: row.my_class as Match['my_class'],
    oppo_class: row.oppo_class as Match['oppo_class'],
    mode: row.mode as GameMode | null,
    playedAt: toDate(row.playedAt),
    endedAt: toDateOrNull(row.endedAt),
    updatedAt: toDateOrNull(row.updatedAt)
  }
}

export function deckFromRow(row: Selectable<DeckRow>): Deck {
  return {
    ...row,
    isDefault: row.isDefault === 1,
    createdAt: toDate(row.createdAt),
    updatedAt: toDateOrNull(row.updatedAt)
  }
}

export function deckCategoryFromRow(row: DeckCategoryRow): DeckCategory {
  return {
    ...row,
    createdAt: toDate(row.createdAt),
    updatedAt: toDateOrNull(row.updatedAt)
  }
}

export function tagFromRow(row: Selectable<TagRow>): Tag {
  return {
    ...row,
    createdAt: toDate(row.createdAt),
    updatedAt: toDateOrNull(row.updatedAt)
  }
}

/** `Date.now()`, named for what the column means. */
export const nowMs = (): number => Date.now()

/**
 * A `cuid`-shaped id for DeckCategory, whose primary key predates this file.
 * Prisma generated cuids; anything unique and the right shape keeps sorting and
 * equality working, and crypto randomness is more than the column ever needed.
 */
export function newCategoryId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 20; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `c${Date.now().toString(36)}${suffix}`
}
