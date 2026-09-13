/**
 * Whether the demo seeder's hands are hands.
 *
 * The seeder writes into the production database, so the interesting properties
 * cannot be checked by reading rows back out of it afterwards. They are checked
 * here instead, against the pure half of `tools/seed-opening-demo.mjs`, which
 * takes a seeded RNG and a deck list and returns plain objects.
 *
 * Two of these assertions are load-bearing rather than decorative. If the draw
 * is not hypergeometric, every card's observed deal rate disagrees with its
 * expectation, `dealRateSuspect` fires on the whole table at once, and the one
 * alarm the 起手 page exists to raise says nothing. And if the same seed stops
 * producing the same data, "remove the demo data and put it back" stops being a
 * thing the user can do.
 */
import { describe, expect, it } from 'vitest'

import {
  DEMO_SEED,
  HAND_SIZE,
  choosePlants,
  expandDeck,
  generateHand,
  generateMatches,
  keepProbability,
  makeRng,
  recordHand
} from '../../tools/seed-opening-demo.mjs'

type DeckEntry = { cardId: number; count: number; cost: number }

/**
 * The user's real deck 43, "witch go": 17 distinct cards summing to 40, with
 * three 1-ofs and a cost-18 card. Copied verbatim rather than invented, because
 * the shapes that break a draw are the awkward real ones — a singleton, a
 * duplicate cost, a cost outside any sane range.
 */
const WITCH_DECK: DeckEntry[] = [
  { cardId: 10031210, count: 3, cost: 1 },
  { cardId: 10031310, count: 3, cost: 1 },
  { cardId: 10831310, count: 3, cost: 1 },
  { cardId: 10131120, count: 1, cost: 2 },
  { cardId: 10231110, count: 3, cost: 2 },
  { cardId: 10132310, count: 3, cost: 3 },
  { cardId: 10133310, count: 3, cost: 3 },
  { cardId: 10304120, count: 2, cost: 3 },
  { cardId: 10133130, count: 1, cost: 4 },
  { cardId: 10134120, count: 3, cost: 5 },
  { cardId: 10232110, count: 1, cost: 5 },
  { cardId: 10132130, count: 1, cost: 6 },
  { cardId: 10234120, count: 3, cost: 6 },
  { cardId: 10133320, count: 3, cost: 7 },
  { cardId: 10134110, count: 3, cost: 7 },
  { cardId: 10104120, count: 1, cost: 10 },
  { cardId: 10134310, count: 3, cost: 18 }
]

const COST_OF = new Map<number, number>(WITCH_DECK.map((e) => [e.cardId, e.cost]))

const THREE_OF = 10031210
const ONE_OF = 10104120

/** The plant configuration the seeder builds for the witch set, rebuilt here. */
function witchPlan(): Record<string, unknown> {
  const plants = choosePlants(WITCH_DECK)
  return {
    ...plants,
    suppressRate: 0.62,
    lowRecogNullRate: 0.45,
    keepArtVector: false,
    substituteInto: WITCH_DECK.map((e) => e.cardId).filter(
      (id) =>
        id !== plants.suppressed &&
        id !== plants.lowRecog &&
        id !== plants.signal &&
        id !== plants.neverDealt
    )
  }
}

/** How often `cardId` turns up in `n` hands drawn from `pool`, as a percentage. */
function dealRate(pool: number[], cardId: number, n: number, seed: number): number {
  const rng = makeRng(seed)
  let hits = 0
  for (let i = 0; i < n; i += 1) {
    if (generateHand(rng, { pool, costOf: COST_OF }).pre.includes(cardId)) hits += 1
  }
  return (100 * hits) / n
}

describe('the opening hand as dealt', () => {
  it('never puts more copies of a card in a hand than the deck holds', () => {
    const pool = expandDeck(WITCH_DECK)
    const rng = makeRng(DEMO_SEED)
    const limit = new Map(WITCH_DECK.map((e) => [e.cardId, e.count]))

    for (let i = 0; i < 20_000; i += 1) {
      const hand = generateHand(rng, { pool, costOf: COST_OF })
      // The two stages are counted separately: a kept card is the SAME physical
      // copy in both, so pooling them would flag a legitimate 1-of as a
      // duplicate rather than catching a real draw-with-replacement bug.
      for (const stage of [hand.pre, hand.post]) {
        const seen = new Map<number, number>()
        for (const cardId of stage) seen.set(cardId, (seen.get(cardId) ?? 0) + 1)
        for (const [cardId, count] of seen) {
          expect(count).toBeLessThanOrEqual(limit.get(cardId) as number)
        }
      }
    }
  })

  it('deals a 3-of into about 27.7% of hands, as the hypergeometric says it must', () => {
    // 1 - C(37,4)/C(40,4). If this drifts, the deal-rate health check on the
    // page is measuring the seeder rather than the recogniser.
    expect(dealRate(expandDeck(WITCH_DECK), THREE_OF, 60_000, 99)).toBeCloseTo(27.7, 0)
  })

  it('deals a 1-of into about 10% of hands', () => {
    // 4/40 exactly, and the reason a flat draw over the 17 distinct cards would
    // not do: that would give this card the same chance as a 3-of.
    expect(dealRate(expandDeck(WITCH_DECK), ONE_OF, 60_000, 99)).toBeCloseTo(10, 0)
  })

  it('keeps a card in the hand exactly when the deck has room to draw', () => {
    const pool = expandDeck(WITCH_DECK)
    expect(pool).toHaveLength(40)
    const hand = generateHand(makeRng(1), { pool, costOf: COST_OF })
    expect(hand.pre).toHaveLength(HAND_SIZE)
  })
})

describe('the mulligan', () => {
  it('produces a post hand of exactly four, made only of kept cards and replacements', () => {
    const pool = expandDeck(WITCH_DECK)
    const rng = makeRng(DEMO_SEED)

    for (let i = 0; i < 5_000; i += 1) {
      const { pre, post, swapped } = generateHand(rng, { pool, costOf: COST_OF })
      expect(post).toHaveLength(HAND_SIZE)

      for (let slot = 0; slot < HAND_SIZE; slot += 1) {
        if (swapped[slot]) {
          // A replacement comes from the rest of the deck, so it was not one of
          // the four already on the table.
          expect(post[slot]).toBeTypeOf('number')
        } else {
          // A kept card is the same card in the same column - the panel moves a
          // discarded card between rows without changing its slot.
          expect(post[slot]).toBe(pre[slot])
        }
      }

      const kept = post.filter((_: number, slot: number) => !swapped[slot])
      for (const cardId of kept) expect(pre).toContain(cardId)
    }
  })

  it('keeps cheap cards more often than expensive ones, so the column reads as a gradient', () => {
    expect(keepProbability(1)).toBeGreaterThan(keepProbability(3))
    expect(keepProbability(3)).toBeGreaterThan(keepProbability(6))
    expect(keepProbability(6)).toBeGreaterThan(keepProbability(10))
    // A card the master cache has no row for still has to get an answer.
    expect(keepProbability(null)).toBeGreaterThan(0)
  })
})

describe('the planted anomalies', () => {
  it('records the suppressed card in about 12% of hands, well under its 27.7% expectation', () => {
    const plan = witchPlan()
    const pool = expandDeck(WITCH_DECK).filter((id) => id !== plan.neverDealt)
    const rng = makeRng(DEMO_SEED)

    let eligible = 0
    let recorded = 0
    for (let i = 0; i < 40_000; i += 1) {
      const hand = generateHand(rng, { pool, costOf: COST_OF })
      const pre = recordHand(rng, hand, plan).pre.map((c: { cardId: number | null }) => c.cardId)
      // Only fully identified hands count - that is the `eligible` denominator
      // `observedDealRate` is computed over.
      if (pre.some((id: number | null) => id == null)) continue
      eligible += 1
      if (pre.includes(plan.suppressed)) recorded += 1
    }

    const observed = (100 * recorded) / eligible
    expect(observed).toBeGreaterThan(10)
    expect(observed).toBeLessThan(15)
  })

  it('leaves the never-dealt card in the deck list but out of every hand', () => {
    const plan = witchPlan()
    const pool = expandDeck(WITCH_DECK).filter((id) => id !== plan.neverDealt)
    const rng = makeRng(DEMO_SEED)

    expect(WITCH_DECK.map((e) => e.cardId)).toContain(plan.neverDealt)
    for (let i = 0; i < 10_000; i += 1) {
      expect(generateHand(rng, { pool, costOf: COST_OF }).pre).not.toContain(plan.neverDealt)
    }
  })

  it('picks four distinct cards to plant on, and picks them the same way every time', () => {
    const a = choosePlants(WITCH_DECK)
    const b = choosePlants(WITCH_DECK)
    expect(a).toEqual(b)
    const ids = [a.suppressed, a.lowRecog, a.signal, a.neverDealt]
    expect(new Set(ids).size).toBe(4)
    for (const id of ids) expect(WITCH_DECK.map((e) => e.cardId)).toContain(id)
  })
})

describe('the seed', () => {
  it('produces identical matches on two runs, so the demo can be removed and put back', () => {
    const decks = { witch: { deckId: 43, deckName: 'witch go', deckList: WITCH_DECK } }
    const opts = { decks, now: 1_789_000_000_000, seed: DEMO_SEED }

    const once = generateMatches({
      rng: makeRng(DEMO_SEED),
      count: 200,
      myClass: 'witch',
      deckId: 43,
      deckList: WITCH_DECK,
      plan: witchPlan(),
      now: opts.now,
      signalDealtWinP: 0.575,
      signalNotDealtWinP: 0.495
    })
    const twice = generateMatches({
      rng: makeRng(DEMO_SEED),
      count: 200,
      myClass: 'witch',
      deckId: 43,
      deckList: WITCH_DECK,
      plan: witchPlan(),
      now: opts.now,
      signalDealtWinP: 0.575,
      signalNotDealtWinP: 0.495
    })

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('writes eight opening slots per match, with swapped set on the pre rows only', () => {
    const matches = generateMatches({
      rng: makeRng(DEMO_SEED),
      count: 50,
      myClass: 'witch',
      deckId: 43,
      deckList: WITCH_DECK,
      plan: witchPlan(),
      now: 1_789_000_000_000
    })

    for (const m of matches) {
      expect(m.openingCards).toHaveLength(HAND_SIZE * 2)
      expect(m.source).toBe('demo-seed')
      for (const row of m.openingCards) {
        if (row.stage === 'pre') expect([0, 1]).toContain(row.swapped)
        else expect(row.swapped).toBeNull()
        // "cardId is NULL" and "decidedBy names a layer" are the same fact.
        if (row.cardId == null) expect(row.decidedBy).toBeNull()
        else expect(row.decidedBy).toBe('art-portal')
      }
    }
  })

  it('gives a deckless class no opening rows at all, rather than inventing a hand for it', () => {
    // `'no-deck'` is about a denominator that cannot exist. A seeded hand would
    // have handed the page a keep rate it has no right to compute.
    const matches = generateMatches({
      rng: makeRng(DEMO_SEED),
      count: 20,
      myClass: 'elf',
      deckId: null,
      now: 1_789_000_000_000
    })
    for (const m of matches) {
      expect(m.my_deckId).toBeNull()
      expect(m.openingCards).toHaveLength(0)
    }
  })
})
