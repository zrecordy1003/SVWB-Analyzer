/**
 * `cards:openingStats` - the 起手 page's numbers.
 *
 * What is worth pinning here is not the arithmetic (that lives in
 * `shared/stats.ts` and has its own tests) but the three rules that decide
 * which rows the arithmetic ever sees: completeness is derived rather than
 * stored, an unread slot removes a hand from some numbers and not others, and
 * a missing number has to say which kind of missing it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerOpeningStatsIpc } from '../../src/main/ipc/openingStats'
import { OPENING_THRESHOLDS, type OpeningStatsResult } from '../../src/shared/openingStats'
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

async function openingStats(payload: Record<string, unknown> = {}): Promise<OpeningStatsResult> {
  const handler = electronMock.handlers.get('cards:openingStats')
  expect(handler, 'Missing IPC handler: cards:openingStats').toBeTypeOf('function')
  const res = (await handler!({}, payload)) as { ok: boolean; data?: OpeningStatsResult }
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return res.data!
}

let clock = Date.UTC(2026, 0, 1)

/** One finished match, most-recent-first ordering taken care of. */
async function match(opts: {
  won?: boolean
  playOrder?: string
  deckId?: number | null
}): Promise<number> {
  clock += 60_000
  return insertMatch({
    result: opts.won ?? true,
    play_order: opts.playOrder ?? 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    my_deckId: opts.deckId ?? null,
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
  opts: { swapped?: boolean[]; artOn?: number[] } = {}
): Promise<void> {
  const rows: Record<string, unknown>[] = []
  const artOn = new Set(opts.artOn ?? [])
  pre.forEach((cardId, slot) => {
    rows.push({
      matchId,
      stage: 'pre',
      slot,
      cardId,
      confidence: cardId == null ? null : 0.9,
      swapped: opts.swapped?.[slot] ? 1 : 0,
      decidedBy: cardId == null ? null : 'art-portal',
      artVector: cardId == null && artOn.has(slot) ? new Uint8Array(8) : null,
      artAlgoVersion: cardId == null && artOn.has(slot) ? 1 : null
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

/** A deck version with a card list, as the importer would have left it. */
async function deck(id: number, cards: [cardId: number, count: number][]): Promise<number> {
  const now = Date.now()
  await testDb()
    .insertInto('Deck')
    .values({
      id,
      name: `deck-${id}`,
      class: 'witch',
      createdAt: now,
      updatedAt: now
    } as never)
    .execute()
  if (cards.length) {
    await testDb()
      .insertInto('DeckCard')
      .values(cards.map(([cardId, count]) => ({ deckId: id, cardId, count })))
      .execute()
  }
  return id
}

/** A card master row, so `name`/`cost`/`class` resolve. */
async function card(cardId: number, cost: number, classId = 3): Promise<void> {
  await testDb()
    .insertInto('Card')
    .values({
      cardId,
      name: `card-${cardId}`,
      cost,
      type: 1,
      class: classId,
      rarity: 3,
      isToken: 0,
      lang: 'cht',
      updatedAt: Date.now()
    } as never)
    .execute()
}

const byId = (result: OpeningStatsResult, cardId: number) =>
  result.cards.find((c) => c.cardId === cardId)

beforeEach(async () => {
  electronMock.handlers.clear()
  clock = Date.UTC(2026, 0, 1)
  db = await createMigratedTestDb()
  registerOpeningStatsIpc()
})

afterEach(async () => {
  await removeTestDb(db)
  db = undefined
})

describe('cards:openingStats keep rate', () => {
  it('counts a card kept when it is in the post hand and swapped when it is not', async () => {
    await card(100, 2)
    await card(200, 3)
    // Ten hands so the keep-rate threshold is met exactly: 100 survives seven
    // of them, 200 all ten.
    for (let i = 0; i < 10; i++) {
      const id = await match({})
      const kept = i < 7
      await hand(id, [100, 200, 300, 400], kept ? [100, 200, 300, 400] : [999, 200, 300, 400])
    }

    const result = await openingStats()
    const stat = byId(result, 100)!
    expect(stat.dealt).toBe(10)
    expect(stat.kept).toBe(7)
    expect(stat.keepRate?.rate).toBeCloseTo(70, 5)
    expect(stat.keepRate?.total).toBe(10)
  })

  it('withholds the keep rate until the card has been dealt enough times', async () => {
    await card(100, 2)
    for (let i = 0; i < OPENING_THRESHOLDS.keepRate - 1; i++) {
      const id = await match({})
      await hand(id, [100, 200, 300, 400], [100, 200, 300, 400])
    }

    const result = await openingStats()
    const stat = byId(result, 100)!
    expect(stat.dealt).toBe(OPENING_THRESHOLDS.keepRate - 1)
    expect(stat.kept).toBe(OPENING_THRESHOLDS.keepRate - 1)
    expect(stat.keepRate).toBeNull()
  })

  it('counts a card dealt once when the hand holds two copies of it', async () => {
    await card(100, 2)
    const id = await match({})
    await hand(id, [100, 100, 300, 400], [100, 100, 300, 400])

    const result = await openingStats()
    expect(byId(result, 100)!.dealt).toBe(1)
    expect(byId(result, 100)!.kept).toBe(1)
  })
})

describe('cards:openingStats missing states', () => {
  it('says no-deck when nothing that held the card had a deck attached', async () => {
    await card(100, 2)
    const id = await match({ deckId: null })
    await hand(id, [100, 200, 300, 400], [100, 200, 300, 400])

    const stat = byId(await openingStats(), 100)!
    expect(stat.missing).toBe('no-deck')
    expect(stat.eligible).toBe(0)
    expect(stat.copies).toBeNull()
    expect(stat.recognisedShare).toBeNull()
  })

  it('says unidentified when the deck is known but no hand was ever read in full', async () => {
    await card(100, 2)
    const deckId = await deck(1, [
      [100, 3],
      [200, 3]
    ])
    // A deck is attached, so the denominator exists in principle; every hand
    // has an unread slot, so none of them may enter it.
    for (let i = 0; i < 5; i++) {
      const id = await match({ deckId })
      await hand(id, [100, 200, null, 400], [100, 200, 300, 400])
    }

    const stat = byId(await openingStats(), 100)!
    expect(stat.missing).toBe('unidentified')
    expect(stat.eligible).toBe(0)
    expect(stat.recognisedShare).toBe(0)
  })

  it('says never-dealt when the deck list holds the card and a real hand never did', async () => {
    await card(100, 2)
    await card(200, 3)
    const deckId = await deck(1, [
      [100, 3],
      [200, 3]
    ])
    for (let i = 0; i < 5; i++) {
      const id = await match({ deckId })
      await hand(id, [200, 300, 400, 500], [200, 300, 400, 500])
    }

    const stat = byId(await openingStats(), 100)!
    expect(stat.missing).toBe('never-dealt')
    expect(stat.eligible).toBe(5)
    expect(stat.dealt).toBe(0)
    expect(stat.observedDealRate).toBe(0)
  })

  it('says low-sample when everything is known and there is simply not enough of it', async () => {
    await card(100, 2)
    const deckId = await deck(1, [[100, 3]])
    for (let i = 0; i < 3; i++) {
      const id = await match({ deckId })
      await hand(id, [100, 200, 300, 400], [100, 200, 300, 400])
    }

    const stat = byId(await openingStats(), 100)!
    expect(stat.missing).toBe('low-sample')
    expect(stat.eligible).toBe(3)
    expect(stat.dealt).toBe(3)
    expect(stat.confidence).toBe('hidden')
    expect(stat.dealtWr).toBeNull()
    expect(stat.diff).toBeNull()
  })
})

describe('cards:openingStats incomplete hands', () => {
  it('keeps an unread hand out of the curve and the deal rate but not out of the keep rate', async () => {
    await card(100, 2)
    await card(200, 3)
    await card(300, 4)
    await card(400, 5)
    const deckId = await deck(1, [
      [100, 3],
      [200, 3]
    ])

    // Enough complete hands to clear the curve threshold, plus one hand with a
    // slot nobody could name.
    for (let i = 0; i < OPENING_THRESHOLDS.curve; i++) {
      const id = await match({ deckId })
      await hand(id, [200, 300, 400, 400], [200, 300, 400, 400])
    }
    const broken = await match({ deckId })
    await hand(broken, [100, null, 300, 400], [100, 200, 300, 400])

    const result = await openingStats()
    expect(result.summary.matches).toBe(OPENING_THRESHOLDS.curve + 1)
    expect(result.summary.preComplete).toBe(OPENING_THRESHOLDS.curve)
    expect(result.summary.complete).toBe(OPENING_THRESHOLDS.curve)

    // The broken hand did hold 100, and that observation is still good enough
    // to say the user kept it - the keep rate needs no denominator.
    const stat = byId(result, 100)!
    expect(stat.dealt).toBe(1)
    expect(stat.kept).toBe(1)
    // But it may not enter either arm: the unread slot could have been 100.
    expect(stat.eligible).toBe(OPENING_THRESHOLDS.curve)
    expect(stat.observedDealRate).toBe(0)

    // Curve: every counted hand is 3/4/5/5, so the 2-drop never appears and
    // the 5-drop bar is two cards tall. The one hand holding a 2-drop is the
    // one that was not read in full.
    expect(result.summary.curve.find((point) => point.cost === 2)!.pre).toBe(0)
    expect(result.summary.curve.find((point) => point.cost === 4)!.pre).toBeCloseTo(1, 5)
    expect(result.summary.curve.find((point) => point.cost === 5)!.pre).toBeCloseTo(2, 5)
  })

  it('counts only the unnamed slots that kept a picture as pending retry', async () => {
    const id = await match({})
    // Two unnamed slots, one of which the engine kept an art vector for.
    await hand(id, [100, null, null, 400], [100, 200, 300, 400], { artOn: [1] })

    const result = await openingStats()
    expect(result.summary.pendingRetry).toBe(1)
  })
})

describe('cards:openingStats completeness', () => {
  it('includes a match as soon as a background retry names its last slot', async () => {
    await card(100, 2)
    const deckId = await deck(1, [[100, 3]])
    const id = await match({ deckId })
    await hand(id, [100, 200, null, 400], [100, 200, 300, 400], { artOn: [2] })

    const before = await openingStats()
    expect(before.summary.preComplete).toBe(0)
    expect(byId(before, 100)!.eligible).toBe(0)
    expect(before.summary.pendingRetry).toBe(1)

    // Exactly what `Command::RetryUnnamedCards` does: fill the name in and drop
    // the picture. Nothing else is touched - no flag to update, because there
    // is no flag.
    await testDb()
      .updateTable('MatchOpeningCard')
      .set({ cardId: 300, decidedBy: 'art-observed', artVector: null, artAlgoVersion: null })
      .where('matchId', '=', id)
      .where('stage', '=', 'pre')
      .where('slot', '=', 2)
      .execute()

    const after = await openingStats()
    expect(after.summary.preComplete).toBe(1)
    expect(byId(after, 100)!.eligible).toBe(1)
    expect(after.summary.pendingRetry).toBe(0)
  })
})

describe('cards:openingStats curve', () => {
  it('draws no curve until there are enough hands read in full', async () => {
    await card(100, 1)
    await card(200, 2)
    await card(300, 3)
    await card(400, 4)
    for (let i = 0; i < OPENING_THRESHOLDS.curve - 1; i++) {
      const id = await match({})
      await hand(id, [100, 200, 300, 400], [100, 200, 300, 400])
    }

    const short = await openingStats()
    expect(short.summary.complete).toBe(OPENING_THRESHOLDS.curve - 1)
    expect(short.summary.curve).toEqual([])
    expect(short.summary.avgCostPre).toBeNull()
    expect(short.summary.avgCostPost).toBeNull()

    const id = await match({})
    await hand(id, [100, 200, 300, 400], [100, 200, 300, 400])

    const full = await openingStats()
    expect(full.summary.curve).toHaveLength(8)
    expect(full.summary.curve.find((point) => point.cost === 3)!.pre).toBeCloseTo(1, 5)
    expect(full.summary.avgCostPre).toBeCloseTo(2.5, 5)
    expect(full.summary.avgCostPost).toBeCloseTo(2.5, 5)
  })
})

describe('cards:openingStats deal rate check', () => {
  it('flags a card the deck says should turn up far more often than it does', async () => {
    await card(100, 2)
    await card(200, 3)
    const deckId = await deck(1, [
      [100, 3],
      [200, 3]
    ])
    // A 3-of should show up in about 27.7% of hands. It shows up in one of
    // eighty, which is what a card whose illustration nothing recognises looks
    // like from here.
    for (let i = 0; i < 80; i++) {
      const id = await match({ deckId })
      const held = i === 0
      await hand(id, [held ? 100 : 500, 200, 300, 400], [held ? 100 : 500, 200, 300, 400])
    }

    const stat = byId(await openingStats(), 100)!
    expect(stat.eligible).toBe(80)
    expect(stat.expectedDealRate).toBeCloseTo(27.73, 1)
    expect(stat.observedDealRate).toBeCloseTo(1.25, 2)
    expect(stat.dealRateSuspect).toBe(true)
  })

  it('accuses nothing when the same shortfall is seen over too few matches', async () => {
    await card(100, 2)
    await card(200, 3)
    const deckId = await deck(1, [
      [100, 3],
      [200, 3]
    ])
    for (let i = 0; i < OPENING_THRESHOLDS.dealCheck - 1; i++) {
      const id = await match({ deckId })
      await hand(id, [500, 200, 300, 400], [500, 200, 300, 400])
    }

    const stat = byId(await openingStats(), 100)!
    expect(stat.eligible).toBe(OPENING_THRESHOLDS.dealCheck - 1)
    expect(stat.observedDealRate).toBe(0)
    expect(stat.dealRateSuspect).toBe(false)
  })
})

describe('cards:openingStats swap bands', () => {
  it('splits the swap record on which side went first', async () => {
    await card(100, 2)
    // Going first: two swaps, twice, one win. Going second: no swaps, once.
    const a = await match({ playOrder: 'first', won: true })
    await hand(a, [100, 200, 300, 400], [100, 200, 500, 600], {
      swapped: [false, false, true, true]
    })
    const b = await match({ playOrder: 'first', won: false })
    await hand(b, [100, 200, 300, 400], [100, 200, 500, 600], {
      swapped: [false, false, true, true]
    })
    const c = await match({ playOrder: 'second', won: true })
    await hand(c, [100, 200, 300, 400], [100, 200, 300, 400])

    const { summary } = await openingStats()
    expect(summary.avgSwapped).toBeCloseTo(4 / 3, 2)
    expect(summary.swapBands).toEqual([
      { swapped: 0, total: 1, wins: 1, rate: 100 },
      { swapped: 2, total: 2, wins: 1, rate: 50 }
    ])
    expect(summary.swapByPlayOrder.first).toEqual([{ swapped: 2, total: 2, wins: 1, rate: 50 }])
    expect(summary.swapByPlayOrder.second).toEqual([{ swapped: 0, total: 1, wins: 1, rate: 100 }])
  })

  it('counts a hand whose cards were never named, because the swap count did not need them', async () => {
    // The swap count comes off the panel's geometry, so it survives a hand where
    // not one card could be identified. Dropping these would put selection into
    // the only measurement on the page that had none - and not at random: the
    // hands that fail to be named are the ones full of unusual illustrations.
    const named = await match({ won: true })
    await hand(named, [100, 200, 300, 400], [100, 200, 500, 600], {
      swapped: [false, false, true, true]
    })
    const unnamed = await match({ won: false })
    await hand(unnamed, [null, null, null, null], [null, null, null, null], {
      swapped: [true, true, true, true]
    })

    const { summary } = await openingStats()
    expect(summary.preComplete).toBe(1)
    expect(summary.avgSwapped).toBeCloseTo(3, 5)
    expect(summary.swapBands).toEqual([
      { swapped: 2, total: 1, wins: 1, rate: 100 },
      { swapped: 4, total: 1, wins: 0, rate: 0 }
    ])
  })
})
