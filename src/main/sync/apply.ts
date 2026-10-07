/**
 * Folding someone else's changes into this database.
 *
 * ONE TRANSACTION, AND THE FIRST STATEMENT IS A WRITE. Both halves matter.
 *
 * The suppress flag (`SyncSuppress`) is what stops the triggers from writing
 * remote changes into the outbox, where they would be uploaded straight back
 * as if this machine had made them. It works because SQLite has a single
 * writer: the engine's INSERT cannot land in the middle of this transaction -
 * it waits for the lock - so no genuine local change can ever be mistaken for
 * a remote one by the flag being up. Split the apply into several transactions
 * and a match the engine records between two of them is silently never synced.
 *
 * And the flag goes in FIRST, because that INSERT is what takes the write
 * lock. A transaction that began with reads would hold a snapshot while the
 * engine commits a row, then fail to upgrade to a writer.
 *
 * The merge rules are in `merge.ts`; this file is the part that has to know
 * what the tables look like.
 */
import { sql } from 'kysely'

import type { Db } from './ledger.js'
import { KEY_HLC, cursorKey, snapshotKey } from './ledger.js'
import {
  nameWinner,
  pickDefault,
  remoteWins,
  resolveAlias,
  type SyncTable,
  type Version
} from './merge.js'
import {
  CATEGORY_COLUMNS,
  DECK_COLUMNS,
  MATCH_COLUMNS,
  TAG_COLUMNS,
  fromBase64,
  isSyncable
} from './rows.js'
import type { Entry, Segment } from './segment.js'
import { nowMs } from '../data/db/client.js'

export interface ApplyStats {
  applied: number
  /** Skipped because this machine's version of the row is newer (or identical). */
  kept: number
  deleted: number
  /** Skipped because a unique name already belongs to a row with a smaller uid. */
  mergedByName: number
  /** References left empty until the row they point at arrives. */
  pending: number
}

export const emptyStats = (): ApplyStats => ({
  applied: 0,
  kept: 0,
  deleted: 0,
  mergedByName: 0,
  pending: 0
})

export interface ApplyOptions {
  /** This machine's device id: what a still-unsent local change is attributed to. */
  selfDevice: string
  /**
   * Record progress in the same transaction as the changes, so "applied" and
   * "remembered as applied" cannot disagree after a crash. Absent for a snapshot
   * restore that is not tied to a cursor.
   */
  cursor?: { device: string; seq: number; kind: 'segment' | 'snapshot' }
}

type Tx = Db

/** The builtin categories exist on every machine under the same id and are never removed by sync. */
const BUILTIN_CATEGORIES = new Set(['aggro', 'midrange', 'control'])

const TABLE_ORDER: Record<SyncTable, number> = { DeckCategory: 0, Tag: 1, Deck: 2, Match: 3 }

export async function applySegment(
  db: Db,
  segment: Segment,
  options: ApplyOptions
): Promise<ApplyStats> {
  const stats = emptyStats()
  const device = segment.header.device
  // Parents before children, so a reference found in the same segment resolves
  // immediately and `SyncPending` is only for what genuinely arrives later.
  const ordered = [...segment.entries].sort(
    (a, b) => TABLE_ORDER[a.tbl] - TABLE_ORDER[b.tbl] || a.ts - b.ts
  )

  await db.transaction().execute(async (tx) => {
    // First statement, and a write. See the header.
    await tx
      .insertInto('SyncSuppress')
      .values({ one: 1 })
      .onConflict((oc) => oc.doNothing())
      .execute()

    let highWater = await readHlc(tx)
    for (const entry of ordered) {
      await applyEntry(tx, entry, device, options.selfDevice, stats)
      if (entry.ts > highWater) highWater = entry.ts
    }
    await resolvePending(tx, stats)
    await convergeDefaults(tx, options.selfDevice)

    if (segment.header.hlc > highWater) highWater = segment.header.hlc
    await setStateIn(tx, KEY_HLC, String(highWater))
    if (options.cursor) {
      const key =
        options.cursor.kind === 'snapshot'
          ? snapshotKey(options.cursor.device)
          : cursorKey(options.cursor.device)
      await setStateIn(tx, key, String(options.cursor.seq))
      // A snapshot stands in for every segment up to its seq.
      if (options.cursor.kind === 'snapshot') {
        const cur = Number((await getStateIn(tx, cursorKey(options.cursor.device))) ?? 0)
        if (cur < options.cursor.seq) {
          await setStateIn(tx, cursorKey(options.cursor.device), String(options.cursor.seq))
        }
      }
    }

    await tx.deleteFrom('SyncSuppress').execute()
  })
  return stats
}

// ----------------------------------------------------------------- one entry

async function applyEntry(
  tx: Tx,
  entry: Entry,
  sourceDevice: string,
  selfDevice: string,
  stats: ApplyStats
): Promise<void> {
  const tbl = entry.tbl
  let uid = entry.uid

  // An entry about a row this machine already merged away (a tag whose name was
  // taken by a smaller uid) is about the survivor now.
  if (tbl === 'Tag' || tbl === 'DeckCategory') {
    uid = resolveAlias(await aliasMap(tx, tbl), uid)
  }

  const remote: Version = { ts: entry.ts, device: sourceDevice, deleted: entry.op === 'delete' }
  const local = await localVersion(tx, tbl, uid, selfDevice)
  if (!remoteWins(local, remote)) {
    stats.kept++
    return
  }

  if (entry.op === 'delete') {
    if (tbl === 'DeckCategory' && BUILTIN_CATEGORIES.has(uid)) {
      stats.kept++
      return
    }
    await deleteRow(tx, tbl, uid)
    await clearPending(tx, tbl, uid)
    await writeMeta(tx, tbl, uid, entry.ts, sourceDevice, true)
    await dropOutbox(tx, tbl, uid)
    stats.deleted++
    return
  }

  const row = entry.row ?? {}
  let outcome: 'applied' | 'merged'
  switch (tbl) {
    case 'DeckCategory':
      outcome = await upsertNamed(tx, 'DeckCategory', uid, row, entry, stats)
      break
    case 'Tag':
      outcome = await upsertNamed(tx, 'Tag', uid, row, entry, stats)
      break
    case 'Deck':
      await upsertDeck(tx, uid, row, entry, stats)
      outcome = 'applied'
      break
    case 'Match':
      await upsertMatch(tx, uid, row, entry, stats)
      outcome = 'applied'
      break
  }
  if (outcome === 'merged') {
    stats.mergedByName++
    return
  }
  await writeMeta(tx, tbl, uid, entry.ts, sourceDevice, false)
  await dropOutbox(tx, tbl, uid)
  stats.applied++
}

// -------------------------------------------------------------- local lookups

async function localVersion(
  tx: Tx,
  tbl: SyncTable,
  uid: string,
  selfDevice: string
): Promise<Version | null> {
  // A change made here and not yet uploaded is the freshest thing this machine
  // knows. It is compared by WHEN it happened, like everything else.
  const pending = await tx
    .selectFrom('SyncOutbox')
    .select(['op', 'changedAt'])
    .where('tbl', '=', tbl)
    .where('uid', '=', uid)
    .executeTakeFirst()
  if (pending) {
    return { ts: pending.changedAt, device: selfDevice, deleted: pending.op === 'delete' }
  }
  const meta = await tx
    .selectFrom('SyncRowMeta')
    .select(['ts', 'device', 'deletedAt'])
    .where('tbl', '=', tbl)
    .where('uid', '=', uid)
    .executeTakeFirst()
  if (meta) return { ts: meta.ts, device: meta.device, deleted: meta.deletedAt !== null }
  // A row that exists but sync has never heard of: older than anything remote.
  if ((await localId(tx, tbl, uid)) !== null) return { ts: 0, device: '', deleted: false }
  return null
}

async function localId(tx: Tx, tbl: SyncTable, uid: string): Promise<number | string | null> {
  switch (tbl) {
    case 'Match':
      return (
        (await tx.selectFrom('Match').select('id').where('uid', '=', uid).executeTakeFirst())?.id ??
        null
      )
    case 'Deck':
      return (
        (await tx.selectFrom('Deck').select('id').where('uid', '=', uid).executeTakeFirst())?.id ??
        null
      )
    case 'Tag':
      return (
        (await tx.selectFrom('Tag').select('id').where('uid', '=', uid).executeTakeFirst())?.id ??
        null
      )
    case 'DeckCategory':
      return (
        (await tx.selectFrom('DeckCategory').select('id').where('id', '=', uid).executeTakeFirst())
          ?.id ?? null
      )
  }
}

async function aliasMap(tx: Tx, tbl: SyncTable): Promise<Map<string, string>> {
  const rows = await tx
    .selectFrom('SyncAlias')
    .select(['fromUid', 'toUid'])
    .where('tbl', '=', tbl)
    .execute()
  return new Map(rows.map((r) => [r.fromUid, r.toUid]))
}

async function writeMeta(
  tx: Tx,
  tbl: SyncTable,
  uid: string,
  ts: number,
  device: string,
  deleted: boolean
): Promise<void> {
  const deletedAt = deleted ? ts : null
  await tx
    .insertInto('SyncRowMeta')
    .values({ tbl, uid, ts, device, deletedAt })
    .onConflict((oc) => oc.columns(['tbl', 'uid']).doUpdateSet({ ts, device, deletedAt }))
    .execute()
}

async function dropOutbox(tx: Tx, tbl: SyncTable, uid: string): Promise<void> {
  await tx.deleteFrom('SyncOutbox').where('tbl', '=', tbl).where('uid', '=', uid).execute()
}

async function deleteRow(tx: Tx, tbl: SyncTable, uid: string): Promise<void> {
  switch (tbl) {
    case 'Match':
      await tx.deleteFrom('Match').where('uid', '=', uid).execute()
      break
    case 'Deck':
      await tx.deleteFrom('Deck').where('uid', '=', uid).execute()
      break
    case 'Tag':
      await tx.deleteFrom('Tag').where('uid', '=', uid).execute()
      break
    case 'DeckCategory':
      await tx.deleteFrom('DeckCategory').where('id', '=', uid).execute()
      break
  }
}

// ----------------------------------------------------- tags and categories

type Named = 'Tag' | 'DeckCategory'

/**
 * Tags and categories are identified by name as far as the schema is
 * concerned (`UNIQUE`), and by uid as far as sync is. Two machines that each
 * made "practice" have two uids and one name, and only one of them can exist.
 *
 * The smaller uid keeps the name. If that is the incoming one, the local row is
 * absorbed into it - its matches or decks are repointed - and if it is the local
 * one, the incoming row is dropped and remembered as an alias. Either way every
 * machine reaches the same state from the same two uids, with no server.
 */
async function upsertNamed(
  tx: Tx,
  tbl: Named,
  uid: string,
  row: Record<string, unknown>,
  _entry: Entry,
  _stats: ApplyStats
): Promise<'applied' | 'merged'> {
  const columns = tbl === 'Tag' ? TAG_COLUMNS : CATEGORY_COLUMNS
  const name = typeof row.name === 'string' ? row.name : ''
  if (!name) return 'merged'

  const clash = await namedRowOtherThan(tx, tbl, name, uid)
  if (clash !== null) {
    const winner = nameWinner(uid, clash.uid)
    if (winner === clash.uid) {
      // The row already here keeps the name; the incoming one is its alias.
      await setAlias(tx, tbl, uid, clash.uid)
      return 'merged'
    }
    // The incoming row keeps the name. Park the local one under a name nobody
    // can have typed, so the winner can take the real one.
    await parkName(tx, tbl, clash)
  }

  const existing = await localId(tx, tbl, uid)
  const values = Object.fromEntries(columns.map((c) => [c, row[c] ?? null]))
  if (existing !== null) {
    if (tbl === 'Tag')
      await tx
        .updateTable('Tag')
        .set(values as never)
        .where('uid', '=', uid)
        .execute()
    else
      await tx
        .updateTable('DeckCategory')
        .set(values as never)
        .where('id', '=', uid)
        .execute()
  } else if (tbl === 'Tag') {
    await tx
      .insertInto('Tag')
      .values({ ...(values as never as Record<string, never>), uid } as never)
      .execute()
  } else {
    await tx
      .insertInto('DeckCategory')
      .values({ ...(values as never as Record<string, never>), id: uid } as never)
      .execute()
  }

  if (clash !== null) {
    await absorb(tx, tbl, clash, uid)
    await setAlias(tx, tbl, clash.uid, uid)
  }
  return 'applied'
}

interface NamedRow {
  uid: string
  /** Tag.id (integer) or DeckCategory.id (the uid itself). */
  id: number | string
}

async function namedRowOtherThan(
  tx: Tx,
  tbl: Named,
  name: string,
  uid: string
): Promise<NamedRow | null> {
  if (tbl === 'Tag') {
    const r = await tx
      .selectFrom('Tag')
      .select(['id', 'uid'])
      .where('name', '=', name)
      .where((eb) => eb.or([eb('uid', '!=', uid), eb('uid', 'is', null)]))
      .executeTakeFirst()
    return r ? { id: r.id, uid: r.uid ?? '' } : null
  }
  const r = await tx
    .selectFrom('DeckCategory')
    .select('id')
    .where('name', '=', name)
    .where('id', '!=', uid)
    .executeTakeFirst()
  return r ? { id: r.id, uid: r.id } : null
}

async function parkName(tx: Tx, tbl: Named, row: NamedRow): Promise<void> {
  const parked = `\u0000${row.uid}`
  if (tbl === 'Tag') {
    await tx
      .updateTable('Tag')
      .set({ name: parked })
      .where('id', '=', row.id as number)
      .execute()
  } else {
    await tx
      .updateTable('DeckCategory')
      .set({ name: parked })
      .where('id', '=', row.id as string)
      .execute()
  }
}

/** Move everything that pointed at the loser to the winner, then remove the loser. */
async function absorb(tx: Tx, tbl: Named, loser: NamedRow, winnerUid: string): Promise<void> {
  if (tbl === 'Tag') {
    const winner = await tx
      .selectFrom('Tag')
      .select('id')
      .where('uid', '=', winnerUid)
      .executeTakeFirstOrThrow()
    await sql`
      INSERT OR IGNORE INTO MatchTag (matchId, tagId)
      SELECT matchId, ${winner.id} FROM MatchTag WHERE tagId = ${loser.id}
    `.execute(tx)
    await tx
      .deleteFrom('Tag')
      .where('id', '=', loser.id as number)
      .execute()
  } else {
    await tx
      .updateTable('Deck')
      .set({ categoryId: winnerUid })
      .where('categoryId', '=', loser.id as string)
      .execute()
    await tx
      .deleteFrom('DeckCategory')
      .where('id', '=', loser.id as string)
      .execute()
  }
}

async function setAlias(tx: Tx, tbl: Named, fromUid: string, toUid: string): Promise<void> {
  if (fromUid === toUid || fromUid === '') return
  await tx
    .insertInto('SyncAlias')
    .values({ tbl, fromUid, toUid })
    .onConflict((oc) => oc.columns(['tbl', 'fromUid']).doUpdateSet({ toUid }))
    .execute()
}

// --------------------------------------------------------------------- decks

async function upsertDeck(
  tx: Tx,
  uid: string,
  row: Record<string, unknown>,
  entry: Entry,
  stats: ApplyStats
): Promise<void> {
  const values: Record<string, unknown> = Object.fromEntries(
    DECK_COLUMNS.map((c) => [c, row[c] ?? null])
  )

  // The category is a plain string id, so it can be checked for existence
  // directly - and the foreign key would refuse an unknown one.
  const wantedCategory = typeof row.categoryId === 'string' ? row.categoryId : null
  let categoryId: string | null = null
  if (wantedCategory !== null) {
    const resolved = resolveAlias(await aliasMap(tx, 'DeckCategory'), wantedCategory)
    const exists = await tx
      .selectFrom('DeckCategory')
      .select('id')
      .where('id', '=', resolved)
      .executeTakeFirst()
    if (exists) categoryId = resolved
    else {
      await addPending(tx, 'Deck', uid, 'categoryId', 'DeckCategory', resolved, stats)
    }
  }
  values.categoryId = categoryId

  let id = (await localId(tx, 'Deck', uid)) as number | null
  await clearPendingField(
    tx,
    'Deck',
    uid,
    'categoryId',
    wantedCategory === null || categoryId !== null
  )
  await clearPendingField(tx, 'Deck', uid, 'familyId', true)
  if (id !== null) {
    await tx
      .updateTable('Deck')
      .set(values as never)
      .where('id', '=', id)
      .execute()
  } else {
    const inserted = await tx
      .insertInto('Deck')
      .values({ ...(values as Record<string, never>), uid } as never)
      .returning('id')
      .executeTakeFirstOrThrow()
    id = inserted.id
  }

  // The family: the deck whose id every version of it points at.
  const familyUid = typeof row.familyUid === 'string' ? row.familyUid : null
  let familyId: number | null = null
  if (familyUid === null || familyUid === uid) familyId = id
  else {
    familyId = ((await localId(tx, 'Deck', familyUid)) as number | null) ?? null
    if (familyId === null) await addPending(tx, 'Deck', uid, 'familyId', 'Deck', familyUid, stats)
  }
  await tx.updateTable('Deck').set({ familyId }).where('id', '=', id).execute()

  if (entry.cards) {
    await tx.deleteFrom('DeckCard').where('deckId', '=', id).execute()
    if (entry.cards.length > 0) {
      await tx
        .insertInto('DeckCard')
        .values(
          entry.cards.map((c) => ({ deckId: id as number, cardId: c.cardId, count: c.count }))
        )
        .execute()
    }
  }
}

// ------------------------------------------------------------------- matches

async function upsertMatch(
  tx: Tx,
  uid: string,
  row: Record<string, unknown>,
  entry: Entry,
  stats: ApplyStats
): Promise<void> {
  if (!isSyncable('Match', row as { source?: unknown })) return
  const values: Record<string, unknown> = Object.fromEntries(
    MATCH_COLUMNS.map((c) => [c, row[c] ?? null])
  )
  values.oppo_name_crop = fromBase64(row.oppo_name_crop)

  const refs: Array<[string, string]> = [
    ['my_deckId', 'my_deckUid'],
    ['oppo_deckId', 'oppo_deckUid']
  ]
  for (const [column, source] of refs) {
    const refUid = typeof row[source] === 'string' ? (row[source] as string) : null
    await clearPendingField(tx, 'Match', uid, column, true)
    if (refUid === null) {
      values[column] = null
      continue
    }
    const deck = await tx
      .selectFrom('Deck')
      .select('id')
      .where('uid', '=', refUid)
      .executeTakeFirst()
    values[column] = deck?.id ?? null
    if (!deck) await addPending(tx, 'Match', uid, column, 'Deck', refUid, stats)
  }

  let id = (await localId(tx, 'Match', uid)) as number | null
  if (id !== null) {
    await tx
      .updateTable('Match')
      .set(values as never)
      .where('id', '=', id)
      .execute()
  } else {
    const inserted = await tx
      .insertInto('Match')
      .values({ ...(values as Record<string, never>), uid } as never)
      .returning('id')
      .executeTakeFirstOrThrow()
    id = inserted.id
  }

  if (entry.tagUids) {
    await tx
      .deleteFrom('SyncPending')
      .where('tbl', '=', 'Match')
      .where('uid', '=', uid)
      .where('field', '=', 'tag')
      .execute()
    await tx.deleteFrom('MatchTag').where('matchId', '=', id).execute()
    const aliases = await aliasMap(tx, 'Tag')
    for (const raw of new Set(entry.tagUids)) {
      const tagUid = resolveAlias(aliases, raw)
      const tag = await tx
        .selectFrom('Tag')
        .select('id')
        .where('uid', '=', tagUid)
        .executeTakeFirst()
      if (tag) {
        await tx
          .insertInto('MatchTag')
          .values({ matchId: id, tagId: tag.id })
          .onConflict((oc) => oc.doNothing())
          .execute()
      } else {
        await addPending(tx, 'Match', uid, 'tag', 'Tag', tagUid, stats)
      }
    }
  }
}

// ----------------------------------------------------------- pending parents

async function addPending(
  tx: Tx,
  tbl: SyncTable,
  uid: string,
  field: string,
  refTbl: SyncTable,
  refUid: string,
  stats: ApplyStats
): Promise<void> {
  await tx
    .insertInto('SyncPending')
    .values({ tbl, uid, field, refTbl, refUid })
    .onConflict((oc) => oc.doNothing())
    .execute()
  stats.pending++
}

async function clearPending(tx: Tx, tbl: SyncTable, uid: string): Promise<void> {
  await tx.deleteFrom('SyncPending').where('tbl', '=', tbl).where('uid', '=', uid).execute()
}

async function clearPendingField(
  tx: Tx,
  tbl: SyncTable,
  uid: string,
  field: string,
  when: boolean
): Promise<void> {
  if (!when) return
  await tx
    .deleteFrom('SyncPending')
    .where('tbl', '=', tbl)
    .where('uid', '=', uid)
    .where('field', '=', field)
    .execute()
}

/**
 * Fill in the references that were waiting for a row, now that rows may have arrived.
 *
 * Runs at the end of every apply rather than only when a parent shows up,
 * because that is the one place it is certain to see them all - and the pending
 * table is empty almost always, so the common cost is one query.
 */
async function resolvePending(tx: Tx, stats: ApplyStats): Promise<void> {
  const rows = await tx.selectFrom('SyncPending').selectAll().execute()
  if (rows.length === 0) return
  const tagAliases = await aliasMap(tx, 'Tag')
  const categoryAliases = await aliasMap(tx, 'DeckCategory')
  for (const p of rows) {
    const done = async (): Promise<void> => {
      await tx
        .deleteFrom('SyncPending')
        .where('tbl', '=', p.tbl)
        .where('uid', '=', p.uid)
        .where('field', '=', p.field)
        .where('refUid', '=', p.refUid)
        .execute()
      stats.pending = Math.max(0, stats.pending - 1)
    }
    if (p.tbl === 'Match' && (p.field === 'my_deckId' || p.field === 'oppo_deckId')) {
      const deck = await tx
        .selectFrom('Deck')
        .select('id')
        .where('uid', '=', p.refUid)
        .executeTakeFirst()
      if (!deck) continue
      await tx
        .updateTable('Match')
        .set({ [p.field]: deck.id } as never)
        .where('uid', '=', p.uid)
        .execute()
      await done()
    } else if (p.tbl === 'Match' && p.field === 'tag') {
      const tag = await tx
        .selectFrom('Tag')
        .select('id')
        .where('uid', '=', resolveAlias(tagAliases, p.refUid))
        .executeTakeFirst()
      const match = await tx
        .selectFrom('Match')
        .select('id')
        .where('uid', '=', p.uid)
        .executeTakeFirst()
      if (!tag || !match) {
        if (!match) await done()
        continue
      }
      await tx
        .insertInto('MatchTag')
        .values({ matchId: match.id, tagId: tag.id })
        .onConflict((oc) => oc.doNothing())
        .execute()
      await done()
    } else if (p.tbl === 'Deck' && p.field === 'familyId') {
      const family = await tx
        .selectFrom('Deck')
        .select('id')
        .where('uid', '=', p.refUid)
        .executeTakeFirst()
      if (!family) continue
      await tx.updateTable('Deck').set({ familyId: family.id }).where('uid', '=', p.uid).execute()
      await done()
    } else if (p.tbl === 'Deck' && p.field === 'categoryId') {
      const id = resolveAlias(categoryAliases, p.refUid)
      const category = await tx
        .selectFrom('DeckCategory')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!category) continue
      await tx
        .updateTable('Deck')
        .set({ categoryId: category.id })
        .where('uid', '=', p.uid)
        .execute()
      await done()
    } else {
      // A shape this build does not know. Leave it alone rather than guess.
      continue
    }
  }
}

// -------------------------------------------------------------- the invariant

/**
 * "At most one default deck per class" lives in `decks.ts`, not in the schema,
 * so merging two machines that each chose one leaves two.
 *
 * Whichever was set last keeps it. The comparison uses what sync recorded
 * about when each deck last changed, and the uid breaks a tie, so every machine
 * picks the same one. The demotions are not recorded: both machines make the
 * same call independently, so there is nothing to tell the other about.
 */
async function convergeDefaults(tx: Tx, selfDevice: string): Promise<void> {
  const defaults = await tx
    .selectFrom('Deck')
    .select(['id', 'uid', 'class'])
    .where('isDefault', '=', 1)
    .execute()
  const byClass = new Map<string, typeof defaults>()
  for (const d of defaults) byClass.set(d.class, [...(byClass.get(d.class) ?? []), d])

  for (const group of byClass.values()) {
    if (group.length < 2) continue
    const scored = await Promise.all(
      group.map(async (d) => ({
        id: d.id,
        uid: d.uid ?? '',
        ts: (await localVersion(tx, 'Deck', d.uid ?? '', selfDevice))?.ts ?? 0
      }))
    )
    const keep = pickDefault(scored)
    for (const d of scored) {
      if (d.id !== keep.id)
        await tx.updateTable('Deck').set({ isDefault: 0 }).where('id', '=', d.id).execute()
    }
  }
}

// ------------------------------------------------------------ state, in a tx

async function getStateIn(tx: Tx, key: string): Promise<string | null> {
  const row = await tx
    .selectFrom('SyncState')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
  return row?.value ?? null
}

async function setStateIn(tx: Tx, key: string, value: string): Promise<void> {
  await tx
    .insertInto('SyncState')
    .values({ key, value, updatedAt: nowMs() })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updatedAt: nowMs() }))
    .execute()
}

async function readHlc(tx: Tx): Promise<number> {
  const raw = await getStateIn(tx, KEY_HLC)
  const n = Number(raw ?? 0)
  return Number.isFinite(n) ? n : 0
}
