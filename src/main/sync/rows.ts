/**
 * A database row as a sync entry, and back the other way's columns.
 *
 * The two shapes differ in exactly one respect that matters: in the database a
 * reference to another row is a local integer (`Match.my_deckId = 41`), and in
 * an entry it is that row's uid. Integer ids are per machine; uids are the same
 * everywhere. Translation happens at this boundary and nowhere else.
 *
 * What an entry carries is decided here, by listing columns rather than by
 * "everything except": a column added by a later migration does not start
 * leaving the machine until somebody has read this file and said so.
 */
import type { Selectable } from 'kysely'

import { TABLE_COLUMNS, type Database, type DeckRow, type MatchRow } from '../data/db/client.js'
import type { Db } from './ledger.js'
import type { SyncTable } from './merge.js'
import type { Entry } from './segment.js'

/** The `source` of the demo seeder's matches, and the `sourceRef` of its decks. */
export const DEMO_SOURCE = 'demo-seed'

type Columns<T extends keyof typeof TABLE_COLUMNS> = Array<(typeof TABLE_COLUMNS)[T][number]>

const without = <T extends string>(all: readonly T[], drop: readonly string[]): T[] =>
  all.filter((c) => !drop.includes(c))

/**
 * Plain columns: copied as they are.
 *
 * Match drops the three that are not plain - the two deck references become
 * uids, and the nameplate picture becomes base64. `uid` is the entry's own
 * key and `id` is local.
 */
export const MATCH_COLUMNS = without(TABLE_COLUMNS.Match, [
  'id',
  'uid',
  'my_deckId',
  'oppo_deckId',
  'oppo_name_crop'
]) as Columns<'Match'>

/**
 * `rawJson` stays home: it is the whole portal response, tens of kilobytes per
 * imported deck, kept for a feature that does not exist yet. A restored deck
 * simply has none, which is what a hand-made one has too.
 */
export const DECK_COLUMNS = without(TABLE_COLUMNS.Deck, [
  'id',
  'uid',
  'rawJson',
  'familyId'
]) as Columns<'Deck'>

export const TAG_COLUMNS = without(TABLE_COLUMNS.Tag, ['id', 'uid']) as Columns<'Tag'>
export const CATEGORY_COLUMNS = without(TABLE_COLUMNS.DeckCategory, [
  'id'
]) as Columns<'DeckCategory'>

/**
 * Whether a row may leave the machine at all.
 *
 * The triggers already refuse to record demo rows, so this is the second lock on
 * the same door: it is cheap, and the first lock was the one that failed in
 * telemetry on 2026-09-17.
 */
export function isSyncable(
  tbl: SyncTable,
  row: { source?: unknown; sourceRef?: unknown }
): boolean {
  if (tbl === 'Match') return row.source !== DEMO_SOURCE
  if (tbl === 'Deck') return row.sourceRef !== DEMO_SOURCE
  return true
}

const pick = (
  source: Record<string, unknown>,
  columns: readonly string[]
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const c of columns) out[c] = source[c] ?? null
  return out
}

/** Bytes as they come out of the driver: a Buffer, or a Uint8Array after a trip through the worker. */
export function toBase64(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return null
}

export function fromBase64(value: unknown): Buffer | null {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : null
}

/**
 * The current state of one row, as an upsert entry.
 *
 * `null` means there is nothing to send: the row is gone (a later delete will
 * have its own entry) or it must not leave the machine.
 */
export async function buildUpsert(
  db: Db,
  tbl: SyncTable,
  uid: string,
  ts: number
): Promise<Entry | null> {
  switch (tbl) {
    case 'Match':
      return buildMatch(db, uid, ts)
    case 'Deck':
      return buildDeck(db, uid, ts)
    case 'Tag': {
      const row = await db.selectFrom('Tag').selectAll().where('uid', '=', uid).executeTakeFirst()
      if (!row) return null
      return { tbl, uid, op: 'upsert', ts, row: pick(row, TAG_COLUMNS) }
    }
    case 'DeckCategory': {
      const row = await db
        .selectFrom('DeckCategory')
        .selectAll()
        .where('id', '=', uid)
        .executeTakeFirst()
      if (!row) return null
      return { tbl, uid, op: 'upsert', ts, row: pick(row, CATEGORY_COLUMNS) }
    }
  }
}

async function buildMatch(db: Db, uid: string, ts: number): Promise<Entry | null> {
  const row = await db
    .selectFrom('Match as m')
    .leftJoin('Deck as d1', 'd1.id', 'm.my_deckId')
    .leftJoin('Deck as d2', 'd2.id', 'm.oppo_deckId')
    .selectAll('m')
    .select(['d1.uid as my_deckUid', 'd2.uid as oppo_deckUid'])
    .where('m.uid', '=', uid)
    .executeTakeFirst()
  if (!row || !isSyncable('Match', row)) return null
  const tags = await db
    .selectFrom('MatchTag')
    .innerJoin('Tag', 'Tag.id', 'MatchTag.tagId')
    .select('Tag.uid')
    .where('MatchTag.matchId', '=', row.id)
    .execute()
  const source = row as unknown as Selectable<MatchRow> & Record<string, unknown>
  return {
    tbl: 'Match',
    uid,
    op: 'upsert',
    ts,
    row: {
      ...pick(source, MATCH_COLUMNS),
      my_deckUid: row.my_deckUid ?? null,
      oppo_deckUid: row.oppo_deckUid ?? null,
      oppo_name_crop: toBase64(row.oppo_name_crop)
    },
    tagUids: tags
      .map((t) => t.uid)
      .filter((t): t is string => t !== null)
      .sort()
  }
}

async function buildDeck(db: Db, uid: string, ts: number): Promise<Entry | null> {
  const row = await db
    .selectFrom('Deck as d')
    .leftJoin('Deck as f', 'f.id', 'd.familyId')
    .selectAll('d')
    .select('f.uid as familyUid')
    .where('d.uid', '=', uid)
    .executeTakeFirst()
  if (!row || !isSyncable('Deck', row)) return null
  const cards = await db
    .selectFrom('DeckCard')
    .select(['cardId', 'count'])
    .where('deckId', '=', row.id)
    .orderBy('cardId')
    .execute()
  const source = row as unknown as Selectable<DeckRow> & Record<string, unknown>
  return {
    tbl: 'Deck',
    uid,
    op: 'upsert',
    ts,
    row: { ...pick(source, DECK_COLUMNS), familyUid: row.familyUid ?? null },
    cards
  }
}

/** Every table sync owns, for tests that want to look at the lot. */
export type SyncedTables = Pick<Database, 'Match' | 'Deck' | 'Tag' | 'DeckCategory'>
