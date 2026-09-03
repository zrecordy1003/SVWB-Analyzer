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
import { Kysely, SqliteDialect, type Dialect, type Generated, type Selectable } from 'kysely'

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
  /**
   * Provenance. See `resources/migrations/008_add_provenance.sql`.
   *
   * `source` / `mode_confidence` / `engine_version` / `recog_flags` are written
   * by the engine; `observed` / `edited_fields` by this side. `source` is null
   * on rows that predate the migration - unknown, not assumed.
   */
  source: string | null
  observed: string | null
  edited_fields: string | null
  mode_confidence: string | null
  engine_version: string | null
  recog_flags: string | null
}

export interface DeckRow {
  id: Generated<number>
  name: string
  class: string
  createdAt: number
  updatedAt: number | null
  isDefault: number
  categoryId: string | null
  /**
   * Import provenance and contents. See `resources/migrations/009_add_deck_import.sql`.
   *
   * All nullable: a deck created by hand has none of them, and NULL means "not
   * imported" the same way migration 008's NULL means "provenance unknown".
   * `sourceRef` holds the long hash only - a 4-character deck code expires
   * three minutes after issue and is then reused, so storing one as an
   * identifier would be storing someone else's deck.
   */
  sourceKind: string | null
  sourceRef: string | null
  fingerprint: string | null
  battleFormat: number | null
  keyCardId: number | null
  importedAt: number | null
  rawJson: string | null
  /**
   * Deck versioning. See `resources/migrations/011_add_deck_family.sql`.
   *
   * `familyId` links the generations of one deck; after migration 011 it is
   * never NULL (writers backfill `familyId = id` right after insert, in the
   * same transaction). `archivedAt` NULL means "not archived": archived rows
   * keep their matches and stats but leave the pickers.
   */
  familyId: number | null
  archivedAt: number | null
}

export interface DeckCardRow {
  deckId: number
  cardId: number
  count: number
}

export interface CardRow {
  cardId: number
  name: string
  cost: number | null
  type: number | null
  class: number | null
  rarity: number | null
  atk: number | null
  life: number | null
  skillText: string | null
  /** JSON array as stored. */
  tribes: string | null
  deckEnabledNum: number | null
  imageHash: string | null
  bannerHash: string | null
  isToken: number
  lang: string
  updatedAt: number
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

/**
 * Card pool membership. See `resources/migrations/010_add_card_pool.sql`.
 *
 * Keyed by format because legality belongs to the (card, format) pair - the
 * same card is in Unlimited and out of Rotation.
 */
export interface CardPoolRow {
  battleFormat: number
  cardId: number
  sortIndex: number
}

/**
 * Which (class, format, language) slices of the pool have been fetched.
 *
 * Distinguishes "nothing to fetch" from "nothing fetched yet", which Card rows
 * alone cannot: a user who imported one witch deck has witch cards on disk but
 * not the witch pool.
 */
export interface CardPoolSyncRow {
  classId: number
  battleFormat: number
  lang: string
  cardCount: number
  syncedAt: number
}

/**
 * Key/value state for the telemetry uploader. See
 * `resources/migrations/012_add_telemetry_state.sql`.
 */
export interface TelemetryStateRow {
  key: string
  value: string
  updatedAt: number
}

export interface Database {
  Match: MatchRow
  Deck: DeckRow
  DeckCategory: DeckCategoryRow
  Tag: TagRow
  MatchTag: MatchTagRow
  DeckCard: DeckCardRow
  Card: CardRow
  CardPool: CardPoolRow
  CardPoolSync: CardPoolSyncRow
  TelemetryState: TelemetryStateRow
}

// ------------------------------------------------------- the schema, as values

/**
 * Every column this file claims each table has, as VALUES rather than types.
 *
 * `resources/migrations/*.sql` is the schema's single source of truth, and it
 * was hand-mirrored in two places: `tools/engine/src/store.rs` for the engine's
 * writes, and the `Row` interfaces above for the UI's reads. The Rust side has
 * a cargo test against the shipped migrations. This side had a comment saying
 * to keep them in sync, which is not a mechanism - a column could land in a
 * migration and in Rust and simply never appear here, and nothing would say so
 * until a query returned undefined at runtime.
 *
 * The chain is closed in two hops. The `satisfies` below refuses a name that is
 * not a real key of its Row type, and `NoUncheckedColumn` refuses a Row key
 * that is missing from this table - both at compile time, in the typecheck that
 * already runs. `tests/main/dbSchemaMirror.test.ts` then compares these arrays
 * against `PRAGMA table_info` on a database brought up through the real
 * migrations. So migrations, this list, and the interfaces must all agree.
 *
 * Order does not matter; membership does. Add a column here when you add it to
 * a migration, or the test will tell you.
 */
export const TABLE_COLUMNS = {
  Match: [
    'id',
    'result',
    'play_order',
    'my_class',
    'oppo_class',
    'my_deckId',
    'oppo_deckId',
    'mode',
    'bp',
    'mp',
    'delta_mp',
    'current_cr',
    'delta_cr',
    'durationTime',
    'playedAt',
    'endedAt',
    'year',
    'month',
    'day',
    'note',
    'updatedAt',
    'source',
    'observed',
    'edited_fields',
    'mode_confidence',
    'engine_version',
    'recog_flags'
  ],
  Deck: [
    'id',
    'name',
    'class',
    'createdAt',
    'updatedAt',
    'isDefault',
    'categoryId',
    'sourceKind',
    'sourceRef',
    'fingerprint',
    'battleFormat',
    'keyCardId',
    'importedAt',
    'rawJson',
    'familyId',
    'archivedAt'
  ],
  DeckCategory: ['id', 'name', 'sort', 'createdAt', 'updatedAt'],
  Tag: ['id', 'name', 'createdAt', 'updatedAt'],
  MatchTag: ['matchId', 'tagId'],
  DeckCard: ['deckId', 'cardId', 'count'],
  Card: [
    'cardId',
    'name',
    'cost',
    'type',
    'class',
    'rarity',
    'atk',
    'life',
    'skillText',
    'tribes',
    'deckEnabledNum',
    'imageHash',
    'bannerHash',
    'isToken',
    'lang',
    'updatedAt'
  ],
  CardPool: ['battleFormat', 'cardId', 'sortIndex'],
  CardPoolSync: ['classId', 'battleFormat', 'lang', 'cardCount', 'syncedAt'],
  TelemetryState: ['key', 'value', 'updatedAt']
} as const satisfies { [T in keyof Database]: readonly (keyof Database[T])[] }

/**
 * Any Row key missing from `TABLE_COLUMNS`, as a type.
 *
 * `satisfies` only checks the names that ARE listed. This is the other
 * direction: it collapses to `never` when every key of every Row type appears
 * in its table's array, and to the offending column names when one does not -
 * which makes the assignment below fail to compile, naming the column.
 */
type NoUncheckedColumn = {
  [T in keyof Database]: Exclude<keyof Database[T], (typeof TABLE_COLUMNS)[T][number]>
}[keyof Database]

/** Fails to compile if a `Row` interface declares a column this file does not list. */
const _everyColumnIsListed: NoUncheckedColumn extends never ? true : NoUncheckedColumn = true
void _everyColumnIsListed

// -------------------------------------------------------------------- the client

let _db: Kysely<Database> | null = null

/** Set by `initDatabase()`, which runs the engine's migrations first. */
let _dbPath: string | null = null
let _dialect: Dialect | null = null

/**
 * Where the database is, and how to reach it.
 *
 * The dialect is REQUIRED, and that is the point. The app passes
 * `RemoteSqliteDialect` so its queries run in `src/dbworker` rather than on
 * the main process's event loop - and if this took an optional dialect,
 * forgetting it would fall back to an in-process connection that works
 * perfectly while quietly undoing the whole reason the worker exists. A
 * regression that still passes every test is the worst kind, so the loud
 * option is the default one and the quiet one has to be asked for by name.
 */
export function configureDbPath(path: string, dialect: Dialect): void {
  _dbPath = path
  _dialect = dialect
}

/**
 * An in-process connection, for tests.
 *
 * `tests/helpers/db.ts` brings up a scratch file and reads it directly;
 * making 34 test files fork a utility process to check a query would be a
 * poor trade, and the driver has its own cases
 * (`tests/main/remoteDriver.test.ts`) plus the whole E2E suite running
 * through the real one.
 *
 * Named for what it is so it cannot be reached for by accident.
 */
export function configureDbPathInProcess(path: string): void {
  _dbPath = path
  _dialect = null
}

/**
 * The raw handle, held separately from the Kysely instance.
 *
 * `getDb` opens the file itself so it can set the pragmas, which means the OS
 * handle exists from that moment - but Kysely's SQLite driver only picks the
 * database up on its first query, and `destroy()` closes nothing before then.
 * So a `Kysely` that was built and never queried used to leave the file open
 * for good: harmless at app shutdown, and in tests a locked `app.db` that the
 * next case could not delete.
 */
let _sqlite: SQLite.Database | null = null

export function getDb(): Kysely<Database> {
  if (_db) return _db
  if (!_dbPath) {
    throw new Error('database path not set. Call initDatabase() first.')
  }
  if (_dialect) {
    // Out of process. Nothing else in this file applies: the pragmas and the
    // handle live with the driver that owns them.
    _db = new Kysely<Database>({ dialect: _dialect })
    return _db
  }
  // In-process, which only `configureDbPathInProcess` can arrange.
  const sqlite = new SQLite(_dbPath)
  // WAL matches the engine's writer side; busy_timeout covers the moment a user
  // edit lands while the engine is mid-commit. The worker sets the same three.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  _sqlite = sqlite
  _db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  return _db
}

/** Tests swap databases between cases; production never calls this. */
export async function resetDbForTests(): Promise<void> {
  await closeDb()
  _dbPath = null
  // Dropped as well, or a case that configured a remote dialect would leave
  // the next one talking to a worker that is gone.
  _dialect = null
}

export async function closeDb(): Promise<void> {
  const db = _db
  const sqlite = _sqlite
  _db = null
  _sqlite = null
  if (db) await db.destroy()
  // Belt and braces: `destroy()` closes the handle once the driver has taken
  // ownership of it, and does nothing at all if it never did. `close()` on an
  // already-closed database is a no-op, so calling both is safe either way.
  if (sqlite?.open) sqlite.close()
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
    source: row.source as Match['source'],
    mode_confidence: row.mode_confidence as Match['mode_confidence'],
    playedAt: toDate(row.playedAt),
    endedAt: toDateOrNull(row.endedAt),
    updatedAt: toDateOrNull(row.updatedAt)
  }
}

/**
 * `rawJson` is dropped here rather than passed through.
 *
 * It is the whole portal response - tens of kilobytes per imported deck - kept
 * so a later feature can read a field this schema did not model. Nothing above
 * the data layer wants it, and `decks:all` sends its result to the renderer on
 * every reference-data refresh, so letting it ride along would put megabytes
 * through IPC to be thrown away.
 */
export function deckFromRow(row: Selectable<DeckRow>): Deck {
  const { rawJson: _rawJson, ...rest } = row
  return {
    ...rest,
    isDefault: row.isDefault === 1,
    sourceKind: row.sourceKind as Deck['sourceKind'],
    createdAt: toDate(row.createdAt),
    updatedAt: toDateOrNull(row.updatedAt),
    importedAt: toDateOrNull(row.importedAt),
    archivedAt: toDateOrNull(row.archivedAt)
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
