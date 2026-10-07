/**
 * The triggers of migration 019: what they write down, and what they must not.
 *
 * They are the only thing that sees the engine's writes, so this is tested the
 * way the engine writes: bare INSERT/UPDATE/DELETE against the real schema, with
 * the real foreign keys and cascades. Nothing here goes through app code.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  addDeck,
  addMatch,
  addTag,
  createMachine,
  tagMatch,
  type Machine
} from '../helpers/syncMachine'

const machines: Machine[] = []
const make = async (): Promise<Machine> => {
  const m = await createMachine('t')
  machines.push(m)
  // Start from an empty outbox: the builtin categories are inserted by migration 001,
  // before the triggers exist, so there is nothing queued - but be explicit.
  await m.db.deleteFrom('SyncOutbox').execute()
  return m
}
afterEach(async () => {
  for (const m of machines.splice(0)) await m.close()
})

const outbox = async (m: Machine): Promise<Array<{ tbl: string; uid: string; op: string }>> =>
  await m.db
    .selectFrom('SyncOutbox')
    .select(['tbl', 'uid', 'op'])
    .orderBy('tbl')
    .orderBy('uid')
    .execute()

describe('every kind of row is recorded', () => {
  it('insert, update and delete of a match', async () => {
    const m = await make()
    const row = await addMatch(m)
    expect(await outbox(m)).toEqual([{ tbl: 'Match', uid: row.uid, op: 'upsert' }])

    await m.db.deleteFrom('SyncOutbox').execute()
    await m.db.updateTable('Match').set({ note: 'x' }).where('id', '=', row.id).execute()
    expect(await outbox(m)).toEqual([{ tbl: 'Match', uid: row.uid, op: 'upsert' }])

    await m.db.deleteFrom('Match').where('id', '=', row.id).execute()
    expect(await outbox(m)).toEqual([{ tbl: 'Match', uid: row.uid, op: 'delete' }])
  })

  it('decks, tags and categories', async () => {
    const m = await make()
    const deck = await addDeck(m, { name: 'd' })
    const tag = await addTag(m, 't')
    await m.db
      .insertInto('DeckCategory')
      .values({ id: 'cNEW', name: '新分類', sort: 4, createdAt: 1, updatedAt: null } as never)
      .execute()
    const got = await outbox(m)
    expect(got).toEqual(
      [
        { tbl: 'Deck', uid: deck.uid, op: 'upsert' },
        { tbl: 'DeckCategory', uid: 'cNEW', op: 'upsert' },
        { tbl: 'Tag', uid: tag.uid, op: 'upsert' }
      ].sort((a, b) => (a.tbl + a.uid).localeCompare(b.tbl + b.uid))
    )

    await m.db.deleteFrom('DeckCategory').where('id', '=', 'cNEW').execute()
    expect((await outbox(m)).find((o) => o.uid === 'cNEW')?.op).toBe('delete')
  })

  it('many edits of one row are one entry, stamped with the LAST edit', async () => {
    const m = await make()
    const row = await addMatch(m)
    const first = await m.db.selectFrom('SyncOutbox').select('changedAt').executeTakeFirstOrThrow()
    await new Promise((r) => setTimeout(r, 15))
    for (let i = 0; i < 5; i++) {
      await m.db
        .updateTable('Match')
        .set({ note: `n${i}` })
        .where('id', '=', row.id)
        .execute()
    }
    const rows = await m.db.selectFrom('SyncOutbox').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].changedAt).toBeGreaterThan(first.changedAt)
  })

  it('stamps in milliseconds, not seconds', async () => {
    const m = await make()
    await addMatch(m)
    const { changedAt } = await m.db
      .selectFrom('SyncOutbox')
      .select('changedAt')
      .executeTakeFirstOrThrow()
    expect(Math.abs(changedAt - Date.now())).toBeLessThan(5_000)
  })
})

describe('children dirty their parent', () => {
  it('a tag added to or removed from a match', async () => {
    const m = await make()
    const match = await addMatch(m)
    const tag = await addTag(m, 't')
    await m.db.deleteFrom('SyncOutbox').execute()

    await tagMatch(m, match.id, tag.id)
    expect(await outbox(m)).toEqual([{ tbl: 'Match', uid: match.uid, op: 'upsert' }])
    await m.db.deleteFrom('SyncOutbox').execute()
    await m.db.deleteFrom('MatchTag').where('matchId', '=', match.id).execute()
    expect(await outbox(m)).toEqual([{ tbl: 'Match', uid: match.uid, op: 'upsert' }])
  })

  it("a deck's card list", async () => {
    const m = await make()
    const deck = await addDeck(m, { name: 'd' })
    await m.db.deleteFrom('SyncOutbox').execute()
    await m.db.insertInto('DeckCard').values({ deckId: deck.id, cardId: 1, count: 3 }).execute()
    await m.db.updateTable('DeckCard').set({ count: 2 }).where('deckId', '=', deck.id).execute()
    expect(await outbox(m)).toEqual([{ tbl: 'Deck', uid: deck.uid, op: 'upsert' }])
  })

  it('deleting a tag marks every match that carried it, not just the tag', async () => {
    const m = await make()
    const tag = await addTag(m, 't')
    const a = await addMatch(m)
    const b = await addMatch(m)
    await tagMatch(m, a.id, tag.id)
    await tagMatch(m, b.id, tag.id)
    await m.db.deleteFrom('SyncOutbox').execute()

    await m.db.deleteFrom('Tag').where('id', '=', tag.id).execute()
    expect(await outbox(m)).toEqual(
      [
        { tbl: 'Match', uid: a.uid, op: 'upsert' },
        { tbl: 'Match', uid: b.uid, op: 'upsert' },
        { tbl: 'Tag', uid: tag.uid, op: 'delete' }
      ].sort((x, y) => (x.tbl + x.uid).localeCompare(y.tbl + y.uid))
    )
  })

  it('deleting a deck marks the matches that pointed at it (ON DELETE SET NULL fires triggers)', async () => {
    const m = await make()
    const deck = await addDeck(m, { name: 'd' })
    const match = await addMatch(m, { my_deckId: deck.id })
    await m.db.deleteFrom('SyncOutbox').execute()
    await m.db.deleteFrom('Deck').where('id', '=', deck.id).execute()
    const got = await outbox(m)
    expect(got).toContainEqual({ tbl: 'Deck', uid: deck.uid, op: 'delete' })
    expect(got).toContainEqual({ tbl: 'Match', uid: match.uid, op: 'upsert' })
    expect(got).toHaveLength(2)
  })

  it('deleting a match is one tombstone: its tag links going with it do not turn it back into an upsert', async () => {
    const m = await make()
    const tag = await addTag(m, 't')
    const match = await addMatch(m)
    await tagMatch(m, match.id, tag.id)
    await m.db.deleteFrom('SyncOutbox').execute()

    await m.db.deleteFrom('Match').where('id', '=', match.id).execute()
    expect(await outbox(m)).toEqual([{ tbl: 'Match', uid: match.uid, op: 'delete' }])
  })

  it('a delete is never downgraded by a later touch of the same uid', async () => {
    const m = await make()
    const match = await addMatch(m)
    await m.db.deleteFrom('Match').where('id', '=', match.id).execute()
    // Nothing legitimate does this (uids are never reused), but the ledger must hold.
    await m.sqlite
      .prepare(
        `INSERT INTO SyncOutbox (tbl, uid, op, changedAt) VALUES ('Match', ?, 'upsert', 1)
         ON CONFLICT(tbl, uid) DO UPDATE SET op = CASE WHEN SyncOutbox.op = 'delete' THEN 'delete' ELSE 'upsert' END`
      )
      .run(match.uid)
    expect((await outbox(m))[0].op).toBe('delete')
  })
})

describe('what is deliberately not recorded', () => {
  it('while the suppress flag is up - which is how applying remote changes stays quiet', async () => {
    const m = await make()
    await m.db.transaction().execute(async (tx) => {
      await tx.insertInto('SyncSuppress').values({ one: 1 }).execute()
      await tx
        .insertInto('Match')
        .values({
          play_order: 'first',
          my_class: 'elf',
          oppo_class: 'elf',
          playedAt: 1,
          uid: 'remote-1'
        } as never)
        .execute()
      await tx.deleteFrom('SyncSuppress').execute()
    })
    expect(await outbox(m)).toEqual([])
    // ...and the very next ordinary write is recorded again.
    await addMatch(m)
    expect(await outbox(m)).toHaveLength(1)
  })

  it('demo matches and demo decks, however they are written, including through their children', async () => {
    const m = await make()
    const fakeDeck = await addDeck(m, { name: '[demo]', sourceRef: 'demo-seed' })
    const fakeMatch = await addMatch(m, { source: 'demo-seed', my_deckId: fakeDeck.id })
    const tag = await addTag(m, 't')
    await m.db.deleteFrom('SyncOutbox').execute()

    await tagMatch(m, fakeMatch.id, tag.id)
    await m.db.insertInto('DeckCard').values({ deckId: fakeDeck.id, cardId: 1, count: 3 }).execute()
    await m.db.updateTable('Match').set({ note: 'x' }).where('id', '=', fakeMatch.id).execute()
    await m.db.deleteFrom('Match').where('id', '=', fakeMatch.id).execute()
    await m.db.deleteFrom('Deck').where('id', '=', fakeDeck.id).execute()
    expect(await outbox(m)).toEqual([])
  })

  it('a row with no uid yet (cannot be addressed) is not queued', async () => {
    const m = await make()
    await m.sqlite
      .prepare(
        `INSERT INTO Match (play_order, my_class, oppo_class, playedAt) VALUES ('first','elf','elf',1)`
      )
      .run()
    expect(await outbox(m)).toEqual([])
  })
})
