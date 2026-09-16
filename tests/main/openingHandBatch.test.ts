/**
 * `matches:openingHands` - a page of the match list's hands in one call.
 *
 * What is worth pinning here is not the join (the single-match channel already
 * has the same one) but the batching rules the renderer leans on: a match with
 * no rows is ABSENT rather than empty, an empty request never reaches SQLite,
 * and an id list longer than the internal chunk still answers for every id. The
 * absence rule in particular is the one that would fail silently - empty arrays
 * would render as "read, nothing recognised" instead of "never read".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerMatchesIpc } from '../../src/main/ipc/matches'
import { registerTagsIpc } from '../../src/main/ipc/tags'
import type { OpeningHandBatchEntry, OpeningHandView } from '../../src/shared/ipc'
import { createMigratedTestDb, insertMatch, removeTestDb, testDb, type TestDb } from '../helpers/db'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    })
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

let db: TestDb | undefined

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.handlers.get(channel)
  expect(handler, `Missing IPC handler: ${channel}`).toBeTypeOf('function')
  return (await handler!({}, ...args)) as T
}

const openingHands = (ids: unknown): Promise<OpeningHandBatchEntry[]> =>
  invoke<OpeningHandBatchEntry[]>('matches:openingHands', ids)

let clock = Date.UTC(2026, 0, 1)

/** One finished match, nothing about it but its existence mattering here. */
async function match(): Promise<number> {
  clock += 60_000
  return insertMatch({
    result: true,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    playedAt: new Date(clock)
  })
}

/**
 * Write one hand. `pre`/`post` are four entries each; `null` is a slot the
 * engine read but could not name, which is the state migration 014 calls legal.
 */
async function hand(
  matchId: number,
  pre: (number | null)[],
  post: (number | null)[],
  opts: { swapped?: boolean[] } = {}
): Promise<void> {
  const rows: Record<string, unknown>[] = []
  pre.forEach((cardId, slot) => {
    rows.push({
      matchId,
      stage: 'pre',
      slot,
      cardId,
      confidence: cardId == null ? null : 0.9,
      swapped: opts.swapped?.[slot] ? 1 : 0,
      decidedBy: cardId == null ? null : 'art-portal',
      artVector: null,
      artAlgoVersion: null
    })
  })
  post.forEach((cardId, slot) => {
    rows.push({
      matchId,
      stage: 'post',
      slot,
      cardId,
      confidence: cardId == null ? null : 0.9,
      swapped: null,
      decidedBy: cardId == null ? null : 'art-portal',
      artVector: null,
      artAlgoVersion: null
    })
  })
  await testDb()
    .insertInto('MatchOpeningCard')
    .values(rows as never)
    .execute()
}

/** A card master row, so `name`/`cost` resolve through the join. */
async function card(cardId: number, cost: number): Promise<void> {
  await testDb()
    .insertInto('Card')
    .values({
      cardId,
      name: `card-${cardId}`,
      cost,
      type: 1,
      class: 3,
      rarity: 3,
      isToken: 0,
      lang: 'cht',
      updatedAt: Date.now()
    } as never)
    .execute()
}

describe('matches:openingHands', () => {
  beforeEach(async () => {
    electronMock.handlers.clear()
    db = await createMigratedTestDb()
    registerTagsIpc()
    registerMatchesIpc()
  })

  afterEach(async () => {
    await removeTestDb(db)
    db = undefined
  })

  it('answers for several matches at once, each with its own pre and post', async () => {
    for (const id of [101, 102, 103, 201, 202, 203]) await card(id, 2)
    const a = await match()
    const b = await match()
    await hand(a, [101, 102, 103, null], [101, 201, 202, 203])
    await hand(b, [201, 202, null, null], [203, 202, 201, 101])

    const out = await openingHands([a, b])

    expect(out.map((e) => e.matchId)).toEqual([a, b])
    const byId = new Map(out.map((e) => [e.matchId, e.hand]))
    expect(byId.get(a)!.pre.map((s) => [s.slot, s.cardId])).toEqual([
      [0, 101],
      [1, 102],
      [2, 103],
      [3, null]
    ])
    expect(byId.get(a)!.post.map((s) => [s.slot, s.cardId])).toEqual([
      [0, 101],
      [1, 201],
      [2, 202],
      [3, 203]
    ])
    expect(byId.get(b)!.pre.map((s) => s.cardId)).toEqual([201, 202, null, null])
    expect(byId.get(b)!.post.map((s) => s.cardId)).toEqual([203, 202, 201, 101])
    // The join is the reason this channel exists at all rather than the
    // renderer looking cards up itself.
    expect(byId.get(a)!.pre[0]).toMatchObject({ name: 'card-101', cost: 2 })
  })

  it('leaves a match with no rows out of the result entirely', async () => {
    await card(101, 1)
    const withHand = await match()
    const withoutHand = await match()
    await hand(withHand, [101, null, null, null], [101, null, null, null])

    const out = await openingHands([withHand, withoutHand])

    // Absence, asserted as absence: an entry with two empty arrays would pass a
    // length check on `pre` and still be the wrong answer, because the renderer
    // reads "present" as "this match was read".
    expect(out.map((e) => e.matchId)).toEqual([withHand])
    expect(out.find((e) => e.matchId === withoutHand)).toBeUndefined()
  })

  it('returns an empty array for an empty request without asking the database', async () => {
    // `WHERE matchId IN ()` is a SQLite syntax error and Kysely will build it,
    // so the short-circuit is the only thing keeping this from throwing.
    await expect(openingHands([])).resolves.toEqual([])
  })

  it('keeps the slots nothing could name, rather than dropping them', async () => {
    await card(101, 1)
    await card(102, 3)
    await card(103, 5)
    const m = await match()
    await hand(m, [101, 102, null, 103], [101, 102, null, 103])

    const [entry] = await openingHands([m])

    // Four slots, three of them named. The gap is drawn, so losing the row
    // would silently shift every card after it one position to the left.
    expect(entry.hand.pre).toHaveLength(4)
    expect(entry.hand.pre[2]).toMatchObject({
      slot: 2,
      cardId: null,
      name: null,
      cost: null,
      decidedBy: null
    })
    expect(entry.hand.post).toHaveLength(4)
  })

  it('carries the thrown-away flag on the dealt hand', async () => {
    for (const id of [101, 102, 103, 104]) await card(id, 2)
    const m = await match()
    await hand(m, [101, 102, 103, 104], [101, 102, 103, 104], {
      swapped: [false, true, true, false]
    })

    const [entry] = await openingHands([m])

    expect(entry.hand.pre.map((s) => s.swapped)).toEqual([false, true, true, false])
    // `post` rows have no such column: null there is "not applicable", not false.
    expect(entry.hand.post.map((s) => s.swapped)).toEqual([null, null, null, null])
  })

  it('answers once for an id asked for twice', async () => {
    await card(101, 1)
    const m = await match()
    await hand(m, [101, null, null, null], [101, null, null, null])

    const out = await openingHands([m, m, m])

    expect(out).toHaveLength(1)
    expect(out[0].matchId).toBe(m)
  })

  it('answers for every id in a batch bigger than one chunk', async () => {
    // 300 > the 256-id chunk, so this only passes if the handler chunks rather
    // than truncating - truncation would come back with 256 hands and no error.
    await card(101, 1)
    const ids: number[] = []
    for (let i = 0; i < 300; i++) {
      const m = await match()
      ids.push(m)
      await hand(m, [101, null, null, null], [101, null, null, null])
    }

    const out = await openingHands(ids)

    expect(out).toHaveLength(300)
    expect(out.map((e) => e.matchId)).toEqual(ids)
    expect(out.every((e) => (e.hand as OpeningHandView).pre.length === 4)).toBe(true)
  })

  it('drops ids that are not ids instead of binding them into the query', async () => {
    await card(101, 1)
    const m = await match()
    await hand(m, [101, null, null, null], [101, null, null, null])

    const out = await openingHands([m, Number.NaN, 1.5, Infinity])

    expect(out.map((e) => e.matchId)).toEqual([m])
    // Nothing but junk is the same question as nothing at all.
    await expect(openingHands([Number.NaN, 2.5])).resolves.toEqual([])
  })
})
