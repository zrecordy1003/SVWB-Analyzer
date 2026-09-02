/**
 * Card-level statistics, stage 3 of docs/deck-versioning-plan.md.
 *
 * With `my_deckId` pointing at an immutable card list, "which cards was this
 * game played with" is a join. These tests pin the three things the join has
 * to get right: a fork's two versions attribute their own games to their own
 * cards, the coverage line counts what the join can and cannot see, and a card
 * whose master row is missing from the cache still comes back (as `#<id>`).
 * Plus the per-card deck breakdown the 卡片 page's drill-down is built on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  aggregateCardStats,
  deckMetaFromRows,
  registerCardStatsIpc
} from '../../src/main/ipc/cardStats'
import { registerDecksIpc } from '../../src/main/ipc/decks'
import type { CardStatsResult } from '../../src/shared/cardStats'
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
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  clipboard: { readText: vi.fn(() => '') }
}))

type Res<T> = { ok: true; data: T } | { ok: false; error: string }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.handlers.get(channel)
  expect(handler, `Missing IPC handler: ${channel}`).toBeTypeOf('function')
  return (await handler!({}, ...args)) as T
}

const expectOk = <T>(res: Res<T>): T => {
  if (!res.ok) throw new Error(`expected ok, got error: ${res.error}`)
  return res.data
}

const WITCH = 3
const DRAGON = 4

const A = 900001
const B = 900002
const C = 900003

const CARDS_V1 = [
  { cardId: A, count: 3 },
  { cardId: B, count: 2 }
]
// B swapped for C, and A trimmed to two copies.
const CARDS_V2 = [
  { cardId: A, count: 2 },
  { cardId: C, count: 3 }
]

async function saveLocal(input: Record<string, unknown>): Promise<{ id: number }> {
  return expectOk(
    await invoke<Res<{ id: number }>>('decks:saveLocal', {
      name: 'Aggro',
      classId: WITCH,
      cards: CARDS_V1,
      ...input
    })
  )
}

async function play(
  deckId: number | null,
  win: boolean,
  extra: { my_class?: string; mode?: string; playedAt?: Date } = {}
): Promise<number> {
  return insertMatch({
    result: win,
    play_order: 'first',
    my_class: extra.my_class ?? 'witch',
    oppo_class: 'dragon',
    mode: extra.mode ?? 'ranked',
    my_deckId: deckId,
    playedAt: extra.playedAt ?? new Date('2026-05-10T12:00:00Z')
  })
}

async function insertCardMaster(card: {
  cardId: number
  name: string
  cost: number | null
  type?: number | null
}): Promise<void> {
  await testDb()
    .insertInto('Card')
    .values({
      cardId: card.cardId,
      name: card.name,
      cost: card.cost,
      type: card.type ?? 1,
      class: 0,
      rarity: 1,
      atk: null,
      life: null,
      skillText: null,
      tribes: null,
      deckEnabledNum: 3,
      imageHash: `img-${card.cardId}`,
      bannerHash: `ban-${card.cardId}`,
      isToken: 0,
      lang: 'cht',
      updatedAt: Date.now()
    })
    .execute()
}

async function stats(params: Record<string, unknown> = {}): Promise<CardStatsResult> {
  return expectOk(await invoke<Res<CardStatsResult>>('cards:stats', { rangeKey: 'all', ...params }))
}

const cardOf = (result: CardStatsResult, cardId: number, cls = 'witch') =>
  result.groups.find((g) => g.myClass === cls)?.cards.find((c) => c.cardId === cardId)

let db: TestDb | undefined

beforeAll(async () => {
  db = await createMigratedTestDb()
})

afterAll(async () => {
  await removeTestDb(db)
  db = undefined
})

beforeEach(async () => {
  electronMock.handlers.clear()
  await testDb().deleteFrom('MatchTag').execute()
  await testDb().deleteFrom('Match').execute()
  await testDb().deleteFrom('DeckCard').execute()
  await testDb().deleteFrom('Deck').execute()
  await testDb().deleteFrom('Card').execute()
  registerDecksIpc()
  registerCardStatsIpc()
})

/** v1 (A x3, B x2): two games, one won. v2 (A x2, C x3): one game, won. */
async function seedFork(): Promise<{ v1: number; v2: number }> {
  const v1 = await saveLocal({})
  await play(v1.id, true)
  await play(v1.id, false)
  const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
  await play(v2.id, true)
  return { v1: v1.id, v2: v2.id }
}

describe('cards:stats attributes each version’s games to its own cards', () => {
  it('sums a card across the versions that carry it, and only those', async () => {
    const { v2 } = await seedFork()
    const result = await stats({ myDeckIds: [v2] })

    expect(result.groups).toHaveLength(1)
    const group = result.groups[0]
    expect(group).toMatchObject({ myClass: 'witch', total: 3, wins: 2, versions: 2 })

    // A is in both versions: all three games, two wins, average copies
    // weighted by games (3,3,2) / 3 = 2.67.
    expect(cardOf(result, A)).toMatchObject({ total: 3, wins: 2, winRate: 66.67, copies: 2.67 })
    // B only in v1; C only in v2.
    expect(cardOf(result, B)).toMatchObject({ total: 2, wins: 1, winRate: 50, copies: 2 })
    expect(cardOf(result, C)).toMatchObject({ total: 1, wins: 1, winRate: 100, copies: 3 })
  })

  it('reports the "without" side as the complement within the family', async () => {
    const { v2 } = await seedFork()
    const result = await stats({ myDeckIds: [v2] })

    expect(cardOf(result, C)?.without).toEqual({ total: 2, wins: 1 })
    expect(cardOf(result, B)?.without).toEqual({ total: 1, wins: 1 })
    // Carried by every version: nothing to compare against.
    expect(cardOf(result, A)?.without).toEqual({ total: 0, wins: 0 })
  })

  it("scope 'deck' isolates one version's card list", async () => {
    const { v1 } = await seedFork()
    const result = await stats({ myDeckIds: [v1], myDeckScope: 'deck' })

    expect(result.groups[0]).toMatchObject({ total: 2, versions: 1 })
    expect(cardOf(result, A)).toMatchObject({ total: 2, wins: 1, copies: 3 })
    expect(cardOf(result, C)).toBeUndefined()
  })

  it('orders cards by games played, then win rate', async () => {
    const { v2 } = await seedFork()
    const result = await stats({ myDeckIds: [v2] })
    expect(result.groups[0].cards.map((c) => c.cardId)).toEqual([A, B, C])
  })
})

describe('coverage: what the card join can and cannot see', () => {
  it('counts every finished match, and separately the ones with a card list', async () => {
    const { v2 } = await seedFork()
    // No deck at all.
    await play(null, true)
    // A deck row with a name but no card list.
    const bare = expectOk(
      await invoke<Res<{ id: number }>>('decks:create', { name: 'Named only', class: 'witch' })
    )
    await play(bare.id, false)
    // Unfinished: not a match anyone won or lost.
    await insertMatch({
      result: null,
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'dragon',
      mode: 'ranked',
      my_deckId: v2,
      playedAt: new Date('2026-05-10T12:00:00Z')
    })

    const result = await stats()
    expect(result.coverage).toEqual({ total: 5, covered: 3 })
    // The bare deck contributes no card row and no group of its own.
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].total).toBe(3)
  })

  it('is empty, not an error, when nothing matches', async () => {
    const result = await stats({ mode: 'unranked' })
    expect(result).toEqual({ coverage: { total: 0, covered: 0 }, groups: [] })
  })
})

describe('card master cache', () => {
  it('still returns a card with no cached master, named #<cardId>', async () => {
    const { v2 } = await seedFork()
    const result = await stats({ myDeckIds: [v2] })
    expect(cardOf(result, A)).toMatchObject({ name: `#${A}`, cost: null, bannerHash: null })
  })

  it('joins name, cost and art when the master row exists', async () => {
    const { v2 } = await seedFork()
    await insertCardMaster({ cardId: A, name: 'Alpha', cost: 2 })
    const result = await stats({ myDeckIds: [v2] })
    expect(cardOf(result, A)).toMatchObject({
      name: 'Alpha',
      cost: 2,
      kind: 'follower',
      bannerHash: `ban-${A}`
    })
  })
})

describe('per-card deck breakdown (the drill-down)', () => {
  it('lists every version that carried the card with its own copies and record', async () => {
    const { v1, v2 } = await seedFork()
    const result = await stats({ myDeckIds: [v2] })

    // A is in both versions: two deck rows, most played first, v1 numbered
    // before v2 by id.
    expect(cardOf(result, A)?.decks).toEqual([
      {
        deckId: v1,
        familyId: v1,
        name: 'Aggro',
        versionLabel: 'v1',
        copies: 3,
        total: 2,
        wins: 1,
        archivedAt: null
      },
      {
        deckId: v2,
        familyId: v1,
        name: 'Aggro',
        versionLabel: 'v2',
        copies: 2,
        total: 1,
        wins: 1,
        archivedAt: null
      }
    ])
    // C only ever sat in v2.
    expect(cardOf(result, C)?.decks.map((d) => [d.deckId, d.versionLabel])).toEqual([[v2, 'v2']])
    expect(result.groups[0]).toMatchObject({ versions: 2, families: 1 })
  })

  it('numbers versions across the whole family even when only one was played', async () => {
    const { v2 } = await seedFork()
    // Only v2's games: v2 is still "v2", not "v1 of the ones in range".
    const result = await stats({ myDeckIds: [v2], myDeckScope: 'deck' })
    expect(cardOf(result, C)?.decks[0]).toMatchObject({ versionLabel: 'v2', total: 1 })
  })

  it('carries the archived flag through', async () => {
    const { v1 } = await seedFork()
    // Discarding a version with matches archives it rather than deleting it.
    await testDb()
      .updateTable('Deck')
      .set({ archivedAt: 1_700_000_000_000 })
      .where('id', '=', v1)
      .execute()

    const result = await stats()
    const rows = cardOf(result, A)?.decks ?? []
    expect(rows.find((d) => d.deckId === v1)?.archivedAt).toBe(1_700_000_000_000)
    expect(rows.find((d) => d.deckId !== v1)?.archivedAt).toBeNull()
  })

  it('counts families separately from versions across unrelated decks', async () => {
    const { v2 } = await seedFork()
    const other = await saveLocal({ name: 'Other', cards: [{ cardId: A, count: 1 }] })
    await play(other.id, true)

    const result = await stats()
    expect(result.groups[0]).toMatchObject({ versions: 3, families: 2 })
    const a = cardOf(result, A)!
    expect(new Set(a.decks.map((d) => d.familyId)).size).toBe(2)
    expect(a.decks.find((d) => d.deckId === other.id)).toMatchObject({
      name: 'Other',
      versionLabel: 'v1',
      copies: 1
    })
    expect(a.decks.find((d) => d.deckId === v2)?.familyId).not.toBe(other.id)
  })

  it('joins the card text and stats the drill-down shows', async () => {
    const { v2 } = await seedFork()
    await testDb()
      .insertInto('Card')
      .values({
        cardId: A,
        name: 'Alpha',
        cost: 2,
        type: 1,
        class: 0,
        rarity: 3,
        atk: 2,
        life: 3,
        skillText: '<color=Keyword>疾馳</color>',
        tribes: null,
        deckEnabledNum: 3,
        imageHash: 'img-a',
        bannerHash: 'ban-a',
        isToken: 0,
        lang: 'cht',
        updatedAt: Date.now()
      })
      .execute()
    expect(cardOf(await stats({ myDeckIds: [v2] }), A)).toMatchObject({
      rarity: 3,
      atk: 2,
      life: 3,
      skillText: '<color=Keyword>疾馳</color>',
      imageHash: 'img-a'
    })
  })
})

describe('grouping and filters', () => {
  it('groups by my_class even when two classes share a card', async () => {
    const witch = await saveLocal({ name: 'W', cards: [{ cardId: A, count: 3 }] })
    const dragon = await saveLocal({
      name: 'D',
      classId: DRAGON,
      cards: [{ cardId: A, count: 1 }]
    })
    await play(witch.id, true)
    await play(dragon.id, false, { my_class: 'dragon' })

    const result = await stats()
    expect(result.groups.map((g) => g.myClass).sort()).toEqual(['dragon', 'witch'])
    expect(cardOf(result, A, 'witch')).toMatchObject({ total: 1, wins: 1, copies: 3 })
    expect(cardOf(result, A, 'dragon')).toMatchObject({ total: 1, wins: 0, copies: 1 })

    const onlyWitch = await stats({ myClassIds: ['witch'] })
    expect(onlyWitch.groups.map((g) => g.myClass)).toEqual(['witch'])
  })

  it("honours mode, treating 'all' as no mode filter", async () => {
    const deck = await saveLocal({})
    await play(deck.id, true, { mode: 'ranked' })
    await play(deck.id, false, { mode: 'unranked' })

    expect((await stats({ mode: 'ranked' })).coverage.total).toBe(1)
    expect((await stats({ mode: 'all' })).coverage.total).toBe(2)
    expect((await stats({ mode: null })).coverage.total).toBe(2)
  })

  it('applies "most recent N" before aggregating', async () => {
    const deck = await saveLocal({})
    await play(deck.id, false, { playedAt: new Date('2026-05-01T00:00:00Z') })
    await play(deck.id, true, { playedAt: new Date('2026-05-02T00:00:00Z') })
    await play(deck.id, true, { playedAt: new Date('2026-05-03T00:00:00Z') })

    const result = await stats({ limit: 2 })
    expect(result.coverage).toEqual({ total: 2, covered: 2 })
    expect(cardOf(result, A)).toMatchObject({ total: 2, wins: 2 })
  })
})

describe('aggregateCardStats (pure)', () => {
  const bareCard = (deckId: number, cardId: number, count: number) => ({
    deckId,
    cardId,
    count,
    name: null,
    cost: null,
    type: null,
    rarity: null,
    atk: null,
    life: null,
    skillText: null,
    imageHash: null,
    bannerHash: null
  })

  it('leaves matches on deck rows without a card list out of every group', () => {
    const result = aggregateCardStats(
      [
        { my_class: 'witch', my_deckId: 1, total: 4, wins: 3 },
        { my_class: 'witch', my_deckId: 2, total: 5, wins: 1 }
      ],
      [bareCard(1, A, 3)],
      12
    )
    expect(result.coverage).toEqual({ total: 12, covered: 4 })
    expect(result.groups[0]).toMatchObject({ total: 4, wins: 3, versions: 1, families: 1 })
    expect(result.groups[0].cards[0]).toMatchObject({
      cardId: A,
      name: `#${A}`,
      total: 4,
      wins: 3,
      winRate: 75,
      without: { total: 0, wins: 0 },
      // No meta handed in: the row is its own one-version family.
      decks: [
        { deckId: 1, familyId: 1, name: '#1', versionLabel: 'v1', copies: 3, archivedAt: null }
      ]
    })
  })

  it('derives version numbers from id order within a family', () => {
    const meta = deckMetaFromRows([
      { id: 7, familyId: 5, name: 'X', archivedAt: null },
      { id: 5, familyId: 5, name: 'X', archivedAt: 123 },
      { id: 9, familyId: null, name: 'Y', archivedAt: null }
    ])
    expect(meta.get(5)).toEqual({ familyId: 5, name: 'X', version: 1, archivedAt: 123 })
    expect(meta.get(7)).toEqual({ familyId: 5, name: 'X', version: 2, archivedAt: null })
    expect(meta.get(9)).toEqual({ familyId: 9, name: 'Y', version: 1, archivedAt: null })
  })
})
