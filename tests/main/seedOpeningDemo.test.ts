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
  ADVISOR_CLASS,
  ADVISOR_CLASSES,
  ADVISOR_DECK_PROFILE,
  ADVISOR_FAST_CLASSES,
  ADVISOR_MATCHES,
  ADVISOR_OPPO_WEIGHTS,
  ADVISOR_PER_OPPO_MATCHES,
  ADVISOR_PRIMARY_OPPO,
  ADVISOR_SLOW_CLASSES,
  CLASS_POOL_PROFILE,
  DECK_SIZE,
  DEMO_DECK_PROFILE,
  DEMO_SEED,
  DEMO_SOURCE,
  HAND_SIZE,
  REST_BANDS,
  advisorKeepProbability,
  advisorWinProbability,
  chooseAdvisorPlants,
  choosePlants,
  generateAll,
  expandDeck,
  generateHand,
  generateMatches,
  keepProbability,
  makeRng,
  recordHand,
  restBandOf
} from '../../tools/seed-opening-demo.mjs'
import { KEEP_THRESHOLDS } from '../../src/shared/openingStats'
import { classifyRow, rollup, type RollupRow } from '../../src/main/telemetry/rollup'

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

/**
 * The advisor deck, with synthetic ids.
 *
 * `buildAdvisorDeckList` needs a database to find real royal cards in, and
 * nothing in the generator depends on WHICH card an id names — only on its cost
 * and its count, both of which come from `ADVISOR_DECK_PROFILE`. So the fixture
 * below is the same deck the seeder builds against the user's `Card` table, with
 * the ids replaced. Ascending ids in profile order also make
 * `chooseAdvisorPlants`, which sorts by cost then id, pick the row the profile's
 * comment says it picks.
 */
const ADVISOR_DECK: DeckEntry[] = (ADVISOR_DECK_PROFILE as [number, number][]).map(
  ([cost, count], i) => ({ cardId: 900_001 + i, count, cost })
)

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

  it('gives the no-deck cohort real four-card hands while leaving my_deckId null', () => {
    // The point of the no-deck set, and the thing an earlier version got exactly
    // backwards. A match with no `MatchOpeningCard` rows does not reach the
    // `'no-deck'` branch - it is invisible to the page, counted nowhere. The
    // state worth showing is a hand that WAS read beside a deck that was never
    // attached: `keepRate` computable from recognition alone, `copies` and the
    // deal rates unknowable. So the draw list must be present and the deck id
    // must not.
    const matches = generateMatches({
      rng: makeRng(DEMO_SEED),
      count: 60,
      myClass: 'elf',
      deckId: null,
      deckList: WITCH_DECK, // stands in for the in-memory class pool
      now: 1_789_000_000_000
    })

    for (const m of matches) {
      // Never attached - this is what sends the page down the 'no-deck' branch.
      expect(m.my_deckId).toBeNull()

      // ...and yet the panel was read, completely.
      const pre = m.openingCards.filter((c) => c.stage === 'pre')
      const post = m.openingCards.filter((c) => c.stage === 'post')
      expect(pre).toHaveLength(HAND_SIZE)
      expect(post).toHaveLength(HAND_SIZE)
      for (const row of pre) {
        expect(row.cardId).not.toBeNull()
        expect(row.decidedBy).toBe('art-portal')
        // `keepRate` is kept/dealt, so every pre row needs a swap decision.
        expect([0, 1]).toContain(row.swapped)
      }
    }

    // At least one card must be kept and one thrown away across the cohort, or
    // the keep-rate column would be a constant rather than a rate.
    const swaps = matches.flatMap((m) =>
      m.openingCards.filter((c) => c.stage === 'pre').map((c) => c.swapped)
    )
    expect(swaps).toContain(0)
    expect(swaps).toContain(1)
  })

  it('draws no-deck hands from the pool rather than scattering across every class', () => {
    // The in-memory pool exists only so the hands are coherent. If a card can
    // turn up that was never in the draw list, the page would show elf matches
    // holding witch cards and the demo would read as corruption.
    const inPool = new Set(WITCH_DECK.map((e) => e.cardId))
    const matches = generateMatches({
      rng: makeRng(DEMO_SEED),
      count: 60,
      myClass: 'elf',
      deckId: null,
      deckList: WITCH_DECK,
      now: 1_789_000_000_000
    })
    for (const m of matches) {
      for (const row of m.openingCards) {
        if (row.cardId != null) expect(inPool.has(row.cardId)).toBe(true)
      }
    }
  })

  it('gives every seeded class opening rows, so no set is invisible to the page', () => {
    // The regression guard for the bug the two tests above describe. Checked at
    // the whole-plan level rather than per set, because the failure was not that
    // one generator was wrong - it was that one set was wired up without a draw
    // source and nothing downstream noticed.
    const entry = (drawOnly: boolean) => ({
      deckId: drawOnly ? null : 1,
      deckName: 'x',
      deckList: WITCH_DECK,
      created: false,
      drawOnly
    })
    const sets = generateAll({
      decks: {
        witch: entry(false),
        royal: entry(false),
        nightmare: entry(false),
        dragon: entry(false),
        elf: entry(true)
      },
      now: 1_789_000_000_000
    })

    expect(sets.length).toBeGreaterThan(0)
    for (const set of sets) {
      expect(set.matches.length).toBeGreaterThan(0)
      const withHands = set.matches.filter(
        (m: { openingCards: unknown[] }) => m.openingCards.length === HAND_SIZE * 2
      )
      expect(withHands).toHaveLength(set.matches.length)
    }

    // ...and the one that carries hands without a deck is still deckless.
    const elf = sets.find((s: { label: string }) => s.label === 'elf')
    for (const m of elf.matches) expect(m.my_deckId).toBeNull()
  })

  it('builds draw pools and demo decks that both come to exactly 40 cards', () => {
    const sum = (p: number[]): number => p.reduce((a, b) => a + b, 0)
    expect(sum(CLASS_POOL_PROFILE)).toBe(DECK_SIZE)
    expect(sum(DEMO_DECK_PROFILE)).toBe(DECK_SIZE)
    // The pool is the broader one: more distinct cards, so hands look like hands.
    expect(CLASS_POOL_PROFILE.length).toBeGreaterThan(DEMO_DECK_PROFILE.length)
  })
})

// ---------------------------------------------------------------------------
// The one that matters most: seeded rows must be unable to reach the server.
// ---------------------------------------------------------------------------

/**
 * A `Match` row exactly as `insertSets` writes one, reduced to the columns
 * `rollup.ts` reads.
 *
 * Built from the generator's own output rather than typed out by hand, so that
 * a future change to what the seeder writes is a change to what this test
 * feeds `classifyRow`. A hand-written fixture would keep passing while the
 * seeder started writing something else — which is precisely how the original
 * accident survived review.
 */
function rollupRowsFromSeeder(playedAt: number): RollupRow[] {
  const sets = generateAll({
    decks: {
      witch: { deckId: 43, deckName: 'witch go', deckList: WITCH_DECK, created: false },
      royal: { deckId: 44, deckName: 'demo', deckList: ADVISOR_DECK, created: true },
      nightmare: { deckId: 45, deckName: 'demo', deckList: WITCH_DECK, created: true },
      dragon: { deckId: 46, deckName: 'demo', deckList: WITCH_DECK, created: true },
      elf: { deckId: null, deckName: '—', deckList: WITCH_DECK, created: false, drawOnly: true }
    },
    now: playedAt
  })

  return sets.flatMap((set: { matches: Record<string, unknown>[] }) =>
    set.matches.map((m) => ({
      result: m.result as number,
      play_order: m.play_order as string,
      my_class: m.my_class as string,
      oppo_class: m.oppo_class as string,
      mode: m.mode as string,
      // Forced INTO the upload window on purpose. The seeder spreads its
      // matches over six months, so most of them are outside the 14-day window
      // and `rollup` would skip them for a reason that has nothing to do with
      // `source` — which would make this whole test pass while proving nothing.
      playedAt,
      source: m.source as string,
      current_cr: null,
      edited_fields: null,
      recog_flags: null
    }))
  )
}

describe('seeded matches and the telemetry uploader', () => {
  /**
   * The tripwire, stated as plainly as it can be stated.
   *
   * `classifyRow` fails closed: anything that is not `'engine'`, not `'manual'`
   * and not NULL is `'invalid'` and is dropped. `DEMO_SOURCE` is safe because it
   * is none of those three, and for no other reason. If somebody changes it to
   * one of them, this is the assertion that should stop them.
   */
  it('writes a source that the telemetry classifier refuses to recognise', () => {
    expect(
      DEMO_SOURCE,
      "DEMO_SOURCE has been changed to 'engine'. Every seeded match would now upload " +
        'as the CLEAN tier. This is the exact change that put ten fabricated ranked ' +
        'games into the published meta document.'
    ).not.toBe('engine')
    expect(
      DEMO_SOURCE,
      "DEMO_SOURCE has been changed to 'manual'. Seeded matches would be counted in " +
        "the uploaded 'manual' tally."
    ).not.toBe('manual')
    expect(
      DEMO_SOURCE,
      'DEMO_SOURCE has been changed to NULL. Seeded matches would classify as the ' +
        "'legacy' tier, which uploads."
    ).not.toBeNull()
  })

  it('classifies every single seeded row as invalid, so none of them can be uploaded', () => {
    const rows = rollupRowsFromSeeder(Date.UTC(2026, 5, 15, 12))
    expect(rows.length).toBeGreaterThan(1_000)

    const escaped = rows.filter((row) => classifyRow(row) !== 'invalid')
    expect(
      escaped.length,
      `${escaped.length} of ${rows.length} seeded matches were NOT classified 'invalid'. ` +
        'They would be uploaded to the production telemetry Worker and counted as real ' +
        `games by somebody else's meta document. First offender: ` +
        `${JSON.stringify(escaped[0] ?? null)}`
    ).toBe(0)
  })

  it('produces zero buckets, zero manual and zero abandoned when rolled up', () => {
    const now = Date.UTC(2026, 5, 15, 12)
    const days = rollup(rollupRowsFromSeeder(now), now)

    // Every date in the window is still present — an empty day is a fact the
    // server needs. What must be empty is the contents.
    expect(days.length).toBeGreaterThan(0)
    for (const day of days) {
      expect(
        day.buckets,
        `${day.date} carries ${day.buckets.length} uploadable buckets built from seeded ` +
          'matches. Local test data has left the machine.'
      ).toEqual([])
      expect(day.manual, `${day.date} counted seeded matches as hand-typed ones.`).toBe(0)
      expect(day.abandoned, `${day.date} counted seeded matches as abandoned ones.`).toBe(0)
    }
  })

  it('would have uploaded those same rows if the source were the engine — so the test is not vacuous', () => {
    // The control. Without it, all three assertions above would still pass if
    // `rollup` were broken, if the window arithmetic put every row outside it,
    // or if `rollupRowsFromSeeder` returned rows the uploader ignores for some
    // reason unrelated to `source`. The ONLY difference between these rows and
    // the ones above is the one column this whole section is about.
    const now = Date.UTC(2026, 5, 15, 12)
    const asEngine = rollupRowsFromSeeder(now).map((row) => ({ ...row, source: 'engine' }))
    const buckets = rollup(asEngine, now).reduce((sum, day) => sum + day.buckets.length, 0)
    expect(
      buckets,
      'The control produced no buckets either, so the assertions above prove nothing ' +
        'about `source`. Fix this test before trusting it.'
    ).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The 換牌建議 fixture. Not "does the generator do what it says" — whether the
// data it produces can fill the cells `src/main/ipc/mulligan.ts` needs filled.
// ---------------------------------------------------------------------------

/** One arm of one comparison: how many copies, and how many of them won. */
type Arm = { n: number; wins: number }
/** Copies of one card at one scope, split the way the handler splits them. */
type Cell = { kept: Arm; swapped: Arm }
const emptyCell = (): Cell => ({ kept: { n: 0, wins: 0 }, swapped: { n: 0, wins: 0 } })
const smaller = (cell: Cell): number => Math.min(cell.kept.n, cell.swapped.n)
const wr = (arm: Arm): number => (arm.n === 0 ? 0 : (100 * arm.wins) / arm.n)
const gap = (cell: Cell): number => wr(cell.kept) - wr(cell.swapped)

/**
 * Tally one card's copies across the scopes the fallback ladder walks.
 *
 * A deliberately small re-implementation of the handler's counting rules, and
 * only of the counting: a hand whose four pre slots are not all named is
 * skipped, a copy's fate comes off its own `swapped` flag, and the band is the
 * mean cost of the OTHER THREE SLOTS of that hand. What it does not do is decide
 * which rung wins — that is the handler's judgement, and a second copy of it
 * here would only ever agree with itself.
 */
function tally(matches: Record<string, unknown>[], cardId: number, costOf: Map<number, number>) {
  const out = {
    narrow: emptyCell(),
    opponent: emptyCell(),
    all: emptyCell(),
    bands: Array.from({ length: REST_BANDS }, emptyCell),
    keptBy: new Map<string, { kept: number; dealt: number }>(),
    /**
     * One entry per `oppo/order`, which is one COLUMN of the page.
     *
     * Added when the fixture grew from one matchup to seven. The three scopes
     * above answer "can the primary matchup support a comparison"; only this
     * answers the question the rewrite was about, which is whether the
     * SEVENTH-best matchup can.
     */
    cells: new Map<string, Cell>()
  }
  const cellFor = (key: string): Cell => {
    const found = out.cells.get(key)
    if (found) return found
    const fresh = emptyCell()
    out.cells.set(key, fresh)
    return fresh
  }
  for (const m of matches) {
    const cards = m.openingCards as { stage: string; cardId: number | null; swapped: number }[]
    const pre = cards.filter((c) => c.stage === 'pre')
    if (pre.length !== HAND_SIZE || pre.some((c) => c.cardId == null)) continue
    const costs = pre.map((c) => costOf.get(c.cardId as number) ?? null)
    pre.forEach((slot, i) => {
      if (slot.cardId !== cardId) return
      const won = m.result === 1
      const bump = (cell: Cell): void => {
        const a = slot.swapped === 1 ? cell.swapped : cell.kept
        a.n += 1
        if (won) a.wins += 1
      }
      bump(out.all)
      bump(cellFor(`${m.oppo_class as string}/${m.play_order as string}`))
      const band = restBandOf(costs.filter((_c, j) => j !== i))
      if (band != null) bump(out.bands[band])
      if (m.oppo_class === ADVISOR_PRIMARY_OPPO) {
        bump(out.opponent)
        if (m.play_order === 'first') bump(out.narrow)
      }
      const key = m.oppo_class as string
      const seen = out.keptBy.get(key) ?? { kept: 0, dealt: 0 }
      seen.dealt += 1
      if (slot.swapped !== 1) seen.kept += 1
      out.keptBy.set(key, seen)
    })
  }
  return out
}

/** Mantel-Haenszel risk difference over the bands that hold both arms. */
function mh(bands: Cell[]): number {
  let numerator = 0
  let weight = 0
  for (const cell of bands) {
    if (cell.kept.n === 0 || cell.swapped.n === 0) continue
    const w = (cell.kept.n * cell.swapped.n) / (cell.kept.n + cell.swapped.n)
    numerator += w * gap(cell)
    weight += w
  }
  return weight === 0 ? 0 : numerator / weight
}

describe('how many classes carry the advisor fixture', () => {
  /**
   * The page is read through the class filter, so a fixture that lives on one
   * class demonstrates nothing to a reader who plays another — which is how
   * the owner ended up looking at fourteen empty columns with 巫師 selected
   * while the verification table said every column was full. The regression is
   * silent from inside the seeder (its own summary looks perfect), so it is
   * pinned here.
   */
  const decks = Object.fromEntries(
    ADVISOR_CLASSES.map((className: string) => [
      className,
      { deckId: 44, deckName: 'demo', deckList: ADVISOR_DECK, created: true }
    ])
  )
  const sets = generateAll({ decks, now: Date.UTC(2026, 6, 1) })

  it('builds one full-size set per advisor class', () => {
    const advisorSets = sets.filter((s: { advisorPlants?: unknown }) => s.advisorPlants)
    expect(advisorSets.map((s: { label: string }) => s.label).sort()).toEqual(
      [...ADVISOR_CLASSES].sort()
    )
    for (const set of advisorSets) {
      expect(set.matches.length, set.label).toBe(ADVISOR_MATCHES)
    }
  })

  it('is more than one class, which is the whole point of the constant', () => {
    expect(ADVISOR_CLASSES.length).toBeGreaterThan(1)
    expect(ADVISOR_CLASSES).toContain(ADVISOR_CLASS)
  })

  it('leaves the classes that carry a thin demo state out of it', () => {
    // These four are on the page BECAUSE they are underfed. Filling one in
    // would delete the state it exists to show, and would do it invisibly.
    for (const thin of ['witch', 'nightmare', 'elf', 'dragon']) {
      expect(ADVISOR_CLASSES).not.toContain(thin)
    }
  })
})

describe('the 換牌建議 fixture', () => {
  const costOf = new Map<number, number>(ADVISOR_DECK.map((e) => [e.cardId, e.cost]))
  const plants = chooseAdvisorPlants(ADVISOR_DECK) as Record<string, number>
  const decks = {
    [ADVISOR_CLASS]: { deckId: 44, deckName: 'demo', deckList: ADVISOR_DECK, created: true }
  }
  const sets = generateAll({ decks, now: Date.UTC(2026, 6, 1) })
  const advisor = sets.find((s: { label: string }) => s.label === ADVISOR_CLASS)
  const matches = advisor.matches as Record<string, unknown>[]
  const of = (role: string) => tally(matches, plants[role], costOf)

  it('bands a hand the way the handler bands it, including on the boundary', () => {
    // Transcribed from `REST_BAND_CUTS` in `src/main/ipc/mulligan.ts`. The
    // boundary case is the one worth pinning: a mean of exactly 4.0 belongs to
    // the HIGHER band, because the handler's comparison is `< cut`.
    expect(restBandOf([1, 2, 3])).toBe(0) // 2.0
    expect(restBandOf([2, 2, 3])).toBe(0) // 2.33
    expect(restBandOf([2, 3, 3])).toBe(1) // 2.67
    expect(restBandOf([3, 4, 4])).toBe(1) // 3.67
    expect(restBandOf([4, 4, 4])).toBe(2) // exactly 4.0 goes UP
    expect(restBandOf([5, 6, 7])).toBe(2)
    // A companion with no known cost makes the band undefined rather than
    // approximate, which is what the handler does and why it matters: the
    // missing card is exactly the one that would have moved the mean.
    expect(restBandOf([1, 2, null])).toBeNull()
  })

  it('draws all three bands often enough for the stratified rung to exist', () => {
    // The whole reason the advisor gets its own deck. On the user's real deck 43
    // (mean cost 4.875) band 0 essentially never happens, every hand lands in
    // band 2, and a "stratified" estimate combined across one stratum is the
    // crude one wearing a hat.
    const seen = [0, 0, 0]
    const rng = makeRng(DEMO_SEED)
    const pool = expandDeck(ADVISOR_DECK)
    for (let i = 0; i < 20_000; i += 1) {
      for (const band of generateHand(rng, { pool, costOf }).bands) seen[band] += 1
    }
    const total = seen.reduce((a, b) => a + b, 0)
    for (const band of seen) expect(band / total).toBeGreaterThan(0.15)
  })

  it('plants every role on a distinct card of the deck', () => {
    const ids = Object.values(plants)
    expect(new Set(ids).size).toBe(ids.length)
    const inDeck = new Set(ADVISOR_DECK.map((e) => e.cardId))
    for (const id of ids) expect(inDeck.has(id)).toBe(true)
    // Two runs, same answer — the fixture has to survive `--remove` and a
    // re-seed, or the page the user was looking at is not the page they get back.
    expect(chooseAdvisorPlants(ADVISOR_DECK)).toEqual(plants)
  })

  it('writes the volume the arithmetic at ADVISOR_MATCHES asks for', () => {
    expect(matches).toHaveLength(ADVISOR_MATCHES)
    // Every hand complete. The advisor drops a hand with one unnamed slot
    // entirely — the band is undefined without the fourth card — so a nulled
    // slot here costs four copies, not one.
    for (const m of matches) {
      const cards = m.openingCards as { stage: string; cardId: number | null }[]
      expect(cards).toHaveLength(HAND_SIZE * 2)
      for (const c of cards.filter((x) => x.stage === 'pre')) expect(c.cardId).not.toBeNull()
    }
  })

  it('makes the keep decision depend on the OPPONENT, which is the whole premise', () => {
    const fast = [...ADVISOR_FAST_CLASSES] as string[]
    const slow = (ADVISOR_OPPO_WEIGHTS as { value: string }[])
      .map((e) => e.value)
      .filter((c) => !ADVISOR_FAST_CLASSES.has(c))

    const rateFor = (role: string, classes: string[]): number => {
      const seen = of(role).keptBy
      let kept = 0
      let dealt = 0
      for (const className of classes) {
        const row = seen.get(className)
        if (!row) continue
        kept += row.kept
        dealt += row.dealt
      }
      return dealt === 0 ? 0 : kept / dealt
    }

    // A card kept most of the time against fast classes and thrown back against
    // slow ones. If this ever collapses to one number, the advisor page has
    // nothing to be about: every matchup would show the same row.
    expect(rateFor('oppoFast', fast)).toBeGreaterThan(0.75)
    expect(rateFor('oppoFast', slow)).toBeLessThan(0.35)
    // ...and one that does the opposite, so the page is not demonstrating a
    // single card's quirk.
    expect(rateFor('oppoSlow', fast)).toBeLessThan(0.35)
    expect(rateFor('oppoSlow', slow)).toBeGreaterThan(0.72)
  })

  it('plants a real keep effect that survives the band adjustment', () => {
    const t = of('trueKeep')
    // Both arms past `sort`, in the narrowest scope the page can ask for, or
    // the row is not sortable and the effect cannot be found by a reader.
    expect(smaller(t.narrow)).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.sort)
    // Crude and adjusted AGREE, which is what makes it real: the effect is not
    // an artefact of which hands the card was kept in.
    expect(gap(t.all)).toBeGreaterThan(10)
    expect(mh(t.bands)).toBeGreaterThan(10)
    for (const band of t.bands) {
      expect(band.kept.n).toBeGreaterThan(0)
      expect(band.swapped.n).toBeGreaterThan(0)
    }
  })

  it('plants a confounded card whose crude gap the adjustment collapses', () => {
    const c = of('confounded')
    expect(smaller(c.all)).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.sort)
    // Every band contributes, or there is nothing to combine and the page falls
    // off the stratified rung instead of showing the disagreement.
    for (const band of c.bands) {
      expect(band.kept.n).toBeGreaterThan(0)
      expect(band.swapped.n).toBeGreaterThan(0)
    }
    // The point of the whole set: a big crude difference and a small adjusted
    // one, which is the shape `tests/main/mulligan.test.ts` builds by hand as
    // 41.7 against 5.0. Asserted as a ratio as well as an absolute, because
    // "large" and "small" are only meaningful relative to each other.
    expect(gap(c.all)).toBeGreaterThan(20)
    expect(Math.abs(mh(c.bands))).toBeLessThan(12)
    expect(gap(c.all)).toBeGreaterThan(2.5 * Math.abs(mh(c.bands)))
    // ...and the bands must visibly disagree in the drill-down, which is the
    // evidence the page offers a reader who does not trust the adjustment.
    const wrs = c.bands.map((b) => wr(b.kept))
    expect(Math.max(...wrs) - Math.min(...wrs)).toBeGreaterThan(40)
  })

  // ---- the seven-by-two grid: the reason the fixture is the size it is ----

  it('gives EVERY matchup column its own arms, not just the primary one', () => {
    // The failure this whole rewrite is about. The set used to give one class
    // half its matches, so six of the seven columns could only be answered from
    // the pooled rung - and since `answersTheChosenMatchup` those six columns
    // show nothing at all. A fixture that fills one seventh of a page is not a
    // fixture for that page.
    //
    // Checked on `trueKeep`, the balanced 3-of, because it is the cheapest card
    // in the deck to satisfy: if IT cannot fill a cell, nothing can.
    const t = of('trueKeep')
    expect(t.cells.size).toBe(14)
    for (const [key, cell] of t.cells) {
      expect(smaller(cell), `${key} has only ${smaller(cell)} in its smaller arm`).toBeGreaterThan(
        KEEP_THRESHOLDS.sort
      )
    }
  })

  it('draws at least ADVISOR_PER_OPPO_MATCHES against every single opponent', () => {
    // The floor that fixes `ADVISOR_MATCHES`. It is asserted rather than
    // trusted because it is a multinomial draw: the rarest class is one bad
    // seed away from coming in under the number its column needs, and the
    // symptom would be one blank column that nobody could explain.
    const seen = new Map<string, number>()
    for (const m of matches) {
      const key = m.oppo_class as string
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    expect(seen.size).toBe((ADVISOR_OPPO_WEIGHTS as { value: string }[]).length)
    for (const [oppoClass, n] of seen) {
      expect(n, `only ${n} matches against ${oppoClass}`).toBeGreaterThanOrEqual(
        ADVISOR_PER_OPPO_MATCHES
      )
    }
  })

  it('makes the ANSWER differ between columns, not just the sample size', () => {
    // Two columns that recommend the same cards are a page that could have been
    // one column. Each of these four plants is planted to be worth keeping in
    // some cells and not others, and the crude kept-minus-swapped gap is where
    // that has to show up first - if it is not in the raw arms it cannot be in
    // the interval either.
    //
    // The bar is 20 points because that is roughly the half-width of the
    // interval at these arm sizes (see `ADVISOR_PER_OPPO_MATCHES`): below it a
    // verdict is impossible however real the effect is, so a gap under 20 in a
    // cell that is supposed to recommend the card is a fixture bug, not bad luck.
    const cellGap = (role: string, oppoClass: string, playOrder: string): number => {
      const cell = of(role).cells.get(`${oppoClass}/${playOrder}`)
      return cell ? gap(cell) : 0
    }
    const fast = [...ADVISOR_FAST_CLASSES] as string[]
    const slow = [...ADVISOR_SLOW_CLASSES] as string[]

    for (const order of ['first', 'second']) {
      for (const oppoClass of fast) {
        expect(cellGap('fastOnly', oppoClass, order)).toBeGreaterThan(20)
        expect(Math.abs(cellGap('slowOnly', oppoClass, order))).toBeLessThan(20)
      }
      for (const oppoClass of slow) {
        expect(cellGap('slowOnly', oppoClass, order)).toBeGreaterThan(15)
        expect(Math.abs(cellGap('fastOnly', oppoClass, order))).toBeLessThan(20)
      }
    }

    // ...and the same story along the other axis. `firstOnly` must be worth
    // keeping on the play and silent on the draw, which is a distinction the
    // page draws with two columns and would be unable to demonstrate otherwise.
    for (const oppoClass of [...fast, ...slow]) {
      expect(cellGap('firstOnly', oppoClass, 'first')).toBeGreaterThan(20)
      expect(Math.abs(cellGap('firstOnly', oppoClass, 'second'))).toBeLessThan(20)
      expect(cellGap('secondOnly', oppoClass, 'second')).toBeGreaterThan(15)
      expect(Math.abs(cellGap('secondOnly', oppoClass, 'first'))).toBeLessThan(20)
    }
  })

  it('plants a card the page has to tell the user to THROW BACK', () => {
    // Until this card existed the fixture had not one negative effect anywhere,
    // so 建議換 - a whole branch of the advisor UI - had never been rendered
    // with data behind it. Its gap has to be negative in every cell, not just
    // on average, or the branch is only reachable from some columns.
    const t = of('trueToss')
    expect(gap(t.all)).toBeLessThan(-20)
    expect(mh(t.bands)).toBeLessThan(-20)
    for (const [key, cell] of t.cells) {
      expect(gap(cell), `${key} does not point at a toss`).toBeLessThan(-10)
      expect(smaller(cell)).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.show)
    }
  })

  it('pays the skewed-arm tax on one card rather than making every plant a coin flip', () => {
    // `ADVISOR_PER_OPPO_MATCHES` argues that a card kept 70% of the time puts
    // only 30% of its copies in the smaller arm, so it needs ~2.5x the matches
    // for the same precision. `slowOnly` is that card, and it is here so the
    // claim "the fixture only works for balanced cards" is checkable.
    //
    // If every recommended plant were a 50/50 split this test would be the one
    // that failed, and it would be right to.
    const balanced = of('trueKeep')
    const skewed = of('slowOnly')
    const keepShare = (cell: Cell): number => cell.kept.n / (cell.kept.n + cell.swapped.n)
    expect(keepShare(balanced.all)).toBeGreaterThan(0.45)
    expect(keepShare(balanced.all)).toBeLessThan(0.55)
    expect(keepShare(skewed.all)).toBeGreaterThan(0.65)
    // ...and it still clears `show` in every cell, which is what the extra
    // volume bought. It would not have at the old set size.
    for (const [key, cell] of skewed.cells) {
      expect(smaller(cell), `${key}`).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.show)
    }
  })

  it('combines several planted effects in one hand without clipping or starving any', () => {
    // The log-odds model, stated as the two things it has to do that neither
    // rejected alternative did. A hand holding four plants is not rare here -
    // 21 of 40 cards carry one - so "what happens when they collide" is the
    // common case, not an edge case.
    const hand = {
      pre: [plants.trueKeep, plants.trueToss, plants.fastOnly, plants.firstOnly],
      swapped: [false, false, false, false],
      bands: [1, 1, 1, 1]
    }
    const ctx = { oppoClass: 'elf', playOrder: 'first' }
    const all = advisorWinProbability(plants, hand, 0.5, ctx)
    expect(all).toBeGreaterThan(0)
    expect(all).toBeLessThan(1)

    // Every plant still moves the result when the others are present. Under the
    // old priority model three of these four would have contributed nothing.
    const withoutFast = advisorWinProbability(
      plants,
      { ...hand, pre: [plants.trueKeep, plants.trueToss, 0, plants.firstOnly] },
      0.5,
      ctx
    )
    expect(Math.abs(all - withoutFast)).toBeGreaterThan(0.02)

    // A hand with no plant in it is untouched, so the set's own baseline is a
    // base rate rather than a planted number.
    expect(advisorWinProbability(plants, { ...hand, pre: [0, 0, 0, 0] }, 0.5, ctx)).toBeCloseTo(0.5)

    // And the conditional plants really are conditional: the same hand against
    // a slow class loses exactly the `fastOnly` term.
    const vsSlow = advisorWinProbability(plants, hand, 0.5, {
      oppoClass: [...ADVISOR_SLOW_CLASSES][0],
      playOrder: 'first'
    })
    expect(vsSlow).toBeLessThan(all)
  })

  it('plants a card kept ~99% of the time, whose row has to stay hidden', () => {
    const a = of('alwaysKept')
    expect(a.all.kept.n / (a.all.kept.n + a.all.swapped.n)).toBeGreaterThan(0.9)
    // The failure mode `KEEP_THRESHOLDS` exists for. Even at the WIDEST rung —
    // every opponent, both turn orders, bands pooled — the swapped arm never
    // reaches `show`, so there is no honest comparison to print at any rung.
    //
    // The plant used to be kept 95% of the time. It had to go to 99% when the
    // set grew, and that is not a fixture detail: `show` is a COUNT, so the
    // state "not enough of one arm to say anything" erodes with volume alone.
    // A 95%-kept card is hidden at 1200 matches and comparable at 6200, with no
    // change in the card, the player, or the decision.
    expect(a.all.swapped.n).toBeLessThan(KEEP_THRESHOLDS.show)
    // But it is dealt often enough for a keep rate, so the row is not empty: it
    // says 95% kept and declines to say whether that was wise.
    expect(a.narrow.kept.n + a.narrow.swapped.n).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.keepRate)
  })

  it('leaves one card with no usable stratum, so the ladder has to step down', () => {
    // `bandSplit` is kept in bands 0-1 and never in band 2, so no band offers
    // both arms, `mantelHaenszelDiff` returns null and the stratified rung has
    // nothing. The next rung down pools the bands and does have both arms.
    const b = of('bandSplit')
    for (const band of b.bands) expect(Math.min(band.kept.n, band.swapped.n)).toBe(0)
    expect(smaller(b.narrow)).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.show)
  })

  it('starves the narrow arm of one card, so the ladder has to reach the opponent rung', () => {
    // Kept 95% on the play and 15% on the draw: plenty of data, all of it on one
    // side of the question once a turn order is pinned.
    const o = of('orderSplit')
    expect(smaller(o.narrow)).toBeLessThan(KEEP_THRESHOLDS.show)
    expect(smaller(o.opponent)).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.show)
  })

  it('starves the opponent rung of one card, so the ladder has to pool every matchup', () => {
    const o = of('oppoOneSided')
    expect(smaller(o.opponent)).toBeLessThan(KEEP_THRESHOLDS.show)
    expect(smaller(o.all)).toBeGreaterThanOrEqual(KEEP_THRESHOLDS.show)
  })

  it('leaves the rest of the deck on the ordinary cost curve', () => {
    // Eight planted cards out of eighteen rows is already a lot of fiction. The
    // rest must still behave like a deck, or the 起手 keep-rate column for this
    // class becomes a list of constants.
    const planted = new Set(Object.values(plants))
    const ordinary = ADVISOR_DECK.filter((e) => !planted.has(e.cardId))
    expect(ordinary.length).toBeGreaterThan(5)
    for (const entry of ordinary) {
      expect(
        advisorKeepProbability(plants, {
          cardId: entry.cardId,
          cost: entry.cost,
          band: 0,
          oppoClass: ADVISOR_PRIMARY_OPPO,
          playOrder: 'first'
        })
      ).toBeNull()
    }
  })

  it('still produces identical data on two runs', () => {
    const again = generateAll({ decks, now: Date.UTC(2026, 6, 1) })
    expect(JSON.stringify(again)).toBe(JSON.stringify(sets))
  })
})
