/**
 * 示範資料 for the 起手 page.
 *
 * The page has more states than any one real account will show for months: a
 * card at each confidence level, each of the four kinds of absence, the
 * recognition alarm, the curve both drawn and withheld. Building it against a
 * live database that has eleven matches means never seeing most of it, and
 * "looks fine on my data" is how the empty states of every stats page end up
 * unstyled. So the page can swap its result for one of these, behind a toggle
 * that is labelled loudly enough that nobody mistakes it for their own record.
 *
 * Everything here is hand-written and deterministic - no `Math.random`, so a
 * screenshot taken today matches one taken next week. Intervals are computed
 * with the same Wilson helper the real handler uses, so the whiskers are the
 * width they would really be at these sample sizes; the win counts are made up.
 *
 * Card names are real cards of the 巫師 class and a few neutrals, because a
 * page full of「示範卡片 3」reads as a wireframe and the point is to judge the
 * finished thing. `bannerHash` is null throughout: the art is fetched by hash
 * from the portal, and inventing hashes would only produce broken images.
 */
import type {
  AdviceBasis,
  CurvePoint,
  KeepAdvice,
  KeepBand,
  Missing,
  MulliganResult,
  OpeningCardStat,
  OpeningStatsResult,
  Rate,
  SwapBand
} from '@shared/openingStats'
import { KEEP_THRESHOLDS } from '@shared/openingStats'
import {
  confidenceFor,
  mantelHaenszelDiff,
  newcombeDiff,
  rate as statsRate,
  shrink
} from '@shared/stats'
import { wilsonInterval } from '@renderer/components/Analyzer/confidence'

const rate = (wins: number, total: number): Rate => {
  const { low, high } = wilsonInterval(wins, total)
  return { total, wins, rate: total > 0 ? (wins / total) * 100 : 0, lo: low, hi: high }
}

const band = (swapped: number, wins: number, total: number): SwapBand => ({
  swapped,
  total,
  wins,
  rate: total > 0 ? (wins / total) * 100 : 0
})

/** Hypergeometric: P(at least one of `copies` in a 4-card hand from 40). */
const expectedDeal = (copies: number): number => {
  let none = 1
  for (let i = 0; i < 4; i++) none *= (40 - copies - i) / (40 - i)
  return (1 - none) * 100
}

type CardInput = {
  cardId: number
  name: string
  cost: number | null
  rarity: number | null
  className: string | null
  dealt: number
  kept: number
  copies: number | null
  eligible: number
  observedDealRate: number | null
  dealRateSuspect?: boolean
  recognisedShare: number | null
  dealtWr: [wins: number, total: number] | null
  notDealtWr: [wins: number, total: number] | null
  /** Shrunk difference the handler would have produced; null when the arms are missing. */
  diff: number | null
  confidence: OpeningCardStat['confidence']
  missing: Missing | null
}

function card(input: CardInput): OpeningCardStat {
  const dealtWr = input.dealtWr ? rate(...input.dealtWr) : null
  const notDealtWr = input.notDealtWr ? rate(...input.notDealtWr) : null
  // The raw difference's interval: a normal approximation on the two arms is
  // what the handler ships, and at these sizes it is honestly wide.
  let diffLo: number | null = null
  let diffHi: number | null = null
  if (dealtWr && notDealtWr && dealtWr.total > 0 && notDealtWr.total > 0) {
    const p1 = dealtWr.rate / 100
    const p2 = notDealtWr.rate / 100
    const se = Math.sqrt((p1 * (1 - p1)) / dealtWr.total + (p2 * (1 - p2)) / notDealtWr.total)
    const raw = (p1 - p2) * 100
    diffLo = raw - 1.96 * se * 100
    diffHi = raw + 1.96 * se * 100
  }
  return {
    cardId: input.cardId,
    name: input.name,
    cost: input.cost,
    rarity: input.rarity,
    bannerHash: null,
    className: input.className,
    dealt: input.dealt,
    kept: input.kept,
    keepRate: input.dealt >= 10 ? rate(input.kept, input.dealt) : null,
    copies: input.copies,
    eligible: input.eligible,
    expectedDealRate: input.copies === null ? null : expectedDeal(input.copies),
    observedDealRate: input.observedDealRate,
    dealRateSuspect: input.dealRateSuspect ?? false,
    recognisedShare: input.recognisedShare,
    dealtWr,
    notDealtWr,
    diff: input.diff,
    diffLo,
    diffHi,
    confidence: input.confidence,
    missing: input.missing
  }
}

/* ------------------------------------------------------------- the full one */

const FULL_CARDS: OpeningCardStat[] = [
  // sortable, clearly positive - the card the page exists to find
  card({
    cardId: 900101,
    name: '魔力調節師',
    cost: 2,
    rarity: 2,
    className: 'witch',
    dealt: 68,
    kept: 61,
    copies: 3,
    eligible: 140,
    observedDealRate: 30.0,
    recognisedShare: 0.96,
    dealtWr: [42, 68],
    notDealtWr: [36, 72],
    diff: 8.4,
    confidence: 'sortable',
    missing: null
  }),
  // sortable, clearly negative - an 8-drop the user keeps too often
  card({
    cardId: 900102,
    name: '古老的巨人',
    cost: 8,
    rarity: 3,
    className: 'witch',
    dealt: 55,
    kept: 19,
    copies: 2,
    eligible: 140,
    observedDealRate: 20.7,
    recognisedShare: 0.94,
    dealtWr: [23, 55],
    notDealtWr: [52, 85],
    diff: -12.1,
    confidence: 'sortable',
    missing: null
  }),
  // sortable, nothing to see - the honest common case
  card({
    cardId: 900103,
    name: '魔法飛彈',
    cost: 1,
    rarity: 1,
    className: 'witch',
    dealt: 71,
    kept: 44,
    copies: 3,
    eligible: 140,
    observedDealRate: 29.3,
    recognisedShare: 0.97,
    dealtWr: [38, 71],
    notDealtWr: [37, 69],
    diff: 0.6,
    confidence: 'sortable',
    missing: null
  }),
  // sortable, neutral card - shows the class mark differs
  card({
    cardId: 900201,
    name: '天使的祝福',
    cost: 3,
    rarity: 1,
    className: 'neutral',
    dealt: 62,
    kept: 30,
    copies: 3,
    eligible: 140,
    observedDealRate: 27.1,
    recognisedShare: 0.95,
    dealtWr: [29, 62],
    notDealtWr: [46, 78],
    diff: -6.9,
    confidence: 'sortable',
    missing: null
  }),
  // shown, not sortable: the not-dealt arm is under 50
  card({
    cardId: 900104,
    name: '知識的探求者',
    cost: 2,
    rarity: 1,
    className: 'witch',
    dealt: 33,
    kept: 28,
    copies: 3,
    eligible: 80,
    observedDealRate: 27.5,
    recognisedShare: 0.93,
    dealtWr: [21, 33],
    notDealtWr: [24, 47],
    diff: 5.1,
    confidence: 'shown',
    missing: null
  }),
  // shown, negative
  card({
    cardId: 900105,
    name: '深淵的召喚',
    cost: 6,
    rarity: 3,
    className: 'witch',
    dealt: 27,
    kept: 6,
    copies: 2,
    eligible: 80,
    observedDealRate: 21.3,
    recognisedShare: 0.91,
    dealtWr: [11, 27],
    notDealtWr: [29, 53],
    diff: -7.8,
    confidence: 'shown',
    missing: null
  }),
  // hidden: keep rate readable, comparison not (not-dealt arm is 15)
  card({
    cardId: 900106,
    name: '晶石守衛',
    cost: 4,
    rarity: 2,
    className: 'witch',
    dealt: 25,
    kept: 20,
    copies: 3,
    eligible: 40,
    observedDealRate: 32.5,
    recognisedShare: 0.95,
    dealtWr: [14, 25],
    notDealtWr: [9, 15],
    diff: null,
    confidence: 'hidden',
    missing: 'low-sample'
  }),
  // hidden, and even the keep rate is under its line
  card({
    cardId: 900107,
    name: '禁忌的實驗',
    cost: 5,
    rarity: 4,
    className: 'witch',
    dealt: 7,
    kept: 3,
    copies: 1,
    eligible: 40,
    observedDealRate: 12.5,
    recognisedShare: 0.95,
    dealtWr: null,
    notDealtWr: null,
    diff: null,
    confidence: 'hidden',
    missing: 'low-sample'
  }),
  // never-dealt: one copy, added to the deck recently, and it has not shown up
  card({
    cardId: 900108,
    name: '時空的裂縫',
    cost: 7,
    rarity: 3,
    className: 'witch',
    dealt: 0,
    kept: 0,
    copies: 1,
    eligible: 18,
    observedDealRate: 0,
    recognisedShare: 1,
    dealtWr: null,
    notDealtWr: [10, 18],
    diff: null,
    confidence: 'hidden',
    missing: 'never-dealt'
  }),
  // no-deck: seen in hands, but those matches had no deck attached
  card({
    cardId: 900109,
    name: '小小魔女',
    cost: 1,
    rarity: 1,
    className: 'witch',
    dealt: 12,
    kept: 8,
    copies: null,
    eligible: 0,
    observedDealRate: null,
    recognisedShare: null,
    dealtWr: [7, 12],
    notDealtWr: null,
    diff: null,
    confidence: 'hidden',
    missing: 'no-deck'
  }),
  // unidentified: in the deck, and every hand that held it had an unreadable slot
  card({
    cardId: 900110,
    name: '星辰的賢者',
    cost: 3,
    rarity: 2,
    className: 'witch',
    dealt: 0,
    kept: 0,
    copies: 3,
    eligible: 0,
    observedDealRate: null,
    recognisedShare: 0,
    dealtWr: null,
    notDealtWr: null,
    diff: null,
    confidence: 'hidden',
    missing: 'unidentified'
  }),
  // the alarm: alternate art, systematically unreadable - observed far below
  // expected, and only 62% of the hands that should have held it were read
  card({
    cardId: 900111,
    name: '烈焰術士（異畫）',
    cost: 3,
    rarity: 3,
    className: 'witch',
    dealt: 18,
    kept: 15,
    copies: 3,
    eligible: 93,
    observedDealRate: 14.0,
    dealRateSuspect: true,
    recognisedShare: 0.62,
    dealtWr: [10, 18],
    notDealtWr: [39, 75],
    diff: null,
    confidence: 'hidden',
    missing: 'low-sample'
  }),
  // low recognised share without the alarm: a row that deserves a caution mark only
  card({
    cardId: 900112,
    name: '冰霜之壁',
    cost: 2,
    rarity: 1,
    className: 'witch',
    dealt: 41,
    kept: 12,
    copies: 3,
    eligible: 112,
    observedDealRate: 26.8,
    recognisedShare: 0.85,
    dealtWr: [22, 41],
    notDealtWr: [39, 71],
    diff: 1.9,
    confidence: 'shown',
    missing: null
  }),
  // a cost the cache did not know - `#id` name and a `?` badge
  card({
    cardId: 900113,
    name: '#900113',
    cost: null,
    rarity: null,
    className: null,
    dealt: 11,
    kept: 4,
    copies: 1,
    eligible: 60,
    observedDealRate: 8.3,
    recognisedShare: 0.9,
    dealtWr: null,
    notDealtWr: null,
    diff: null,
    confidence: 'hidden',
    missing: 'low-sample'
  })
]

/** Sums to 4.0 on both sides, as a real curve over complete hands must. */
const FULL_CURVE: CurvePoint[] = [
  { cost: 0, pre: 0.05, post: 0.06 },
  { cost: 1, pre: 0.62, post: 0.81 },
  { cost: 2, pre: 0.98, post: 1.12 },
  { cost: 3, pre: 0.84, post: 0.9 },
  { cost: 4, pre: 0.61, post: 0.55 },
  { cost: 5, pre: 0.42, post: 0.3 },
  { cost: 6, pre: 0.25, post: 0.14 },
  { cost: 7, pre: 0.23, post: 0.12 }
]

export const DEMO_FULL: OpeningStatsResult = {
  summary: {
    matches: 171,
    preComplete: 152,
    complete: 140,
    withDeck: 147,
    pendingRetry: 9,
    avgSwapped: 1.51,
    swapBands: [band(0, 18, 31), band(1, 27, 48), band(2, 22, 44), band(3, 9, 22), band(4, 2, 7)],
    swapByPlayOrder: {
      first: [band(0, 11, 18), band(1, 15, 26), band(2, 11, 22), band(3, 4, 9), band(4, 1, 3)],
      second: [band(0, 7, 13), band(1, 12, 22), band(2, 11, 22), band(3, 5, 13), band(4, 1, 4)]
    },
    curve: FULL_CURVE,
    avgCostPre: 3.43,
    avgCostPost: 3.02
  },
  cards: FULL_CARDS
}

/* ----------------------------------------------------------- the empty ones */

/** Nothing in range at all. */
export const DEMO_EMPTY_NO_MATCHES: OpeningStatsResult = {
  summary: {
    matches: 0,
    preComplete: 0,
    complete: 0,
    withDeck: 0,
    pendingRetry: 0,
    avgSwapped: null,
    swapBands: [],
    swapByPlayOrder: { first: [], second: [] },
    curve: [],
    avgCostPre: null,
    avgCostPost: null
  },
  cards: []
}

/**
 * Matches exist, hands were read, and not one was fully identified - the
 * first few minutes of a new class, while the card-image index is still being
 * built. Everything card-shaped is pending; nothing is wrong.
 *
 * The swap counts are NOT empty here, and that is the state most real users
 * see first: how many cards were swapped is read off the panel's geometry and
 * never needed a card's name, so the 換牌張數 section fills on the first
 * evening while the curve and the table wait for the recogniser.
 */
export const DEMO_EMPTY_NO_COMPLETE: OpeningStatsResult = {
  summary: {
    matches: 12,
    preComplete: 0,
    complete: 0,
    withDeck: 10,
    pendingRetry: 34,
    avgSwapped: 1.42,
    swapBands: [band(0, 2, 3), band(1, 3, 4), band(2, 1, 3), band(3, 1, 1), band(4, 0, 1)],
    swapByPlayOrder: {
      first: [band(0, 1, 2), band(1, 2, 2), band(2, 1, 2), band(3, 0, 0), band(4, 0, 1)],
      second: [band(0, 1, 1), band(1, 1, 2), band(2, 0, 1), band(3, 1, 1), band(4, 0, 0)]
    },
    curve: [],
    avgCostPre: null,
    avgCostPost: null
  },
  cards: [
    card({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      rarity: 2,
      className: 'witch',
      dealt: 0,
      kept: 0,
      copies: 3,
      eligible: 0,
      observedDealRate: null,
      recognisedShare: 0,
      dealtWr: null,
      notDealtWr: null,
      diff: null,
      confidence: 'hidden',
      missing: 'unidentified'
    }),
    card({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      rarity: 1,
      className: 'witch',
      dealt: 0,
      kept: 0,
      copies: 3,
      eligible: 0,
      observedDealRate: null,
      recognisedShare: 0,
      dealtWr: null,
      notDealtWr: null,
      diff: null,
      confidence: 'hidden',
      missing: 'unidentified'
    })
  ]
}

/** Real data, just not thirty complete hands yet. The curve is withheld. */
export const DEMO_EMPTY_BELOW_CURVE: OpeningStatsResult = {
  summary: {
    matches: 22,
    preComplete: 19,
    complete: 17,
    withDeck: 20,
    pendingRetry: 3,
    avgSwapped: 1.37,
    swapBands: [band(0, 3, 5), band(1, 5, 8), band(2, 2, 4), band(3, 1, 2), band(4, 0, 0)],
    swapByPlayOrder: {
      first: [band(0, 2, 3), band(1, 3, 4), band(2, 1, 2), band(3, 0, 1), band(4, 0, 0)],
      second: [band(0, 1, 2), band(1, 2, 4), band(2, 1, 2), band(3, 1, 1), band(4, 0, 0)]
    },
    curve: [],
    avgCostPre: null,
    avgCostPost: null
  },
  cards: [
    card({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      rarity: 2,
      className: 'witch',
      dealt: 11,
      kept: 10,
      copies: 3,
      eligible: 17,
      observedDealRate: 35.3,
      recognisedShare: 0.9,
      dealtWr: null,
      notDealtWr: null,
      diff: null,
      confidence: 'hidden',
      missing: 'low-sample'
    }),
    card({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      rarity: 1,
      className: 'witch',
      dealt: 8,
      kept: 5,
      copies: 3,
      eligible: 17,
      observedDealRate: 29.4,
      recognisedShare: 0.9,
      dealtWr: null,
      notDealtWr: null,
      diff: null,
      confidence: 'hidden',
      missing: 'low-sample'
    }),
    card({
      cardId: 900102,
      name: '古老的巨人',
      cost: 8,
      rarity: 3,
      className: 'witch',
      dealt: 4,
      kept: 1,
      copies: 2,
      eligible: 17,
      observedDealRate: 23.5,
      recognisedShare: 0.9,
      dealtWr: null,
      notDealtWr: null,
      diff: null,
      confidence: 'hidden',
      missing: 'low-sample'
    })
  ]
}

export type DemoVariantKey = 'full' | 'noMatches' | 'noComplete' | 'belowCurve'

export const DEMO_VARIANTS: ReadonlyArray<{
  key: DemoVariantKey
  label: string
  result: OpeningStatsResult
}> = [
  { key: 'full', label: '完整資料', result: DEMO_FULL },
  { key: 'belowCurve', label: '場數還不夠畫曲線', result: DEMO_EMPTY_BELOW_CURVE },
  { key: 'noComplete', label: '有對局、手牌都還沒認完', result: DEMO_EMPTY_NO_COMPLETE },
  { key: 'noMatches', label: '完全沒有對局', result: DEMO_EMPTY_NO_MATCHES }
]

/* ------------------------------------------------------- drill-down split */

/** The seven classes, in a fixed order, so the split is the same every time. */
const SPLIT_ORDER = ['elf', 'royal', 'witch', 'dragon', 'bishop', 'nightmare', 'nemesis'] as const
/** Sums to 1. Deliberately uneven, so one class clears the threshold and most do not. */
const SPLIT_WEIGHTS = [0.09, 0.22, 0.11, 0.14, 0.07, 0.25, 0.12] as const

/**
 * A deterministic per-opponent slice of a demo card's dealt/kept, so the
 * drawer's split can be judged without a live database. Real data comes from
 * filtered re-queries (see `OpeningDrilldownDrawer`); this only stands in for
 * that when 示範資料 is on.
 */
export function demoOpponentSplit(
  stat: OpeningCardStat,
  klass: string
): { dealt: number; kept: number } {
  const i = SPLIT_ORDER.indexOf(klass as (typeof SPLIT_ORDER)[number])
  if (i < 0) return { dealt: 0, kept: 0 }
  const dealt = Math.round(stat.dealt * SPLIT_WEIGHTS[i])
  const kept = Math.min(dealt, Math.round(stat.kept * SPLIT_WEIGHTS[i]))
  return { dealt, kept }
}

/* ------------------------------------------------------------ 換牌建議 */

/**
 * The advisor's fixture is built by re-running the handler's own ladder over
 * hand-written arm counts, with the same `mantelHaenszelDiff`, `newcombeDiff`
 * and `shrink` the real handler calls. Writing the outputs by hand instead
 * would have meant inventing a `diff` that does not match its own bands, and
 * the whole point of the drill-down is that a reader can check one against
 * the other. The counts are made up; the arithmetic on them is real - and so
 * is the verdict, which `verdictFor` reads off the resulting interval exactly
 * as the column does. A fixture card lands in 建議留 because its made-up arms
 * really do clear zero, not because it was labelled so.
 *
 * Each variant is a PAIR of results, one per column, written as if the page
 * were pinned to 龍族. The two columns are written to differ, because the
 * contrast between them is the reason the layout has two: a card that is a
 * toss on the play and a keep on the draw, a column that recommends beside
 * one that does not yet.
 */
type Arm = [wins: number, total: number]
type Cell = { kept: Arm; swapped: Arm }

type AdviceInput = {
  cardId: number
  name: string
  cost: number | null
  dealt: number
  kept: number
  /** Indexed by band. An arm of `[0, 0]` is a band where that choice was never made. */
  bands: Cell[]
  /** The pooled rungs, outward. Omit a rung to reuse the one before it. */
  turnOrder?: Cell
  opponent?: Cell
  allOpponents?: Cell
  unidentified?: boolean
}

const cellArms = (c: Cell): number => Math.min(c.kept[1], c.swapped[1])

function advice(input: AdviceInput): KeepAdvice {
  const identity = {
    cardId: input.cardId,
    name: input.name,
    cost: input.cost,
    bannerHash: null,
    imageHash: null,
    dealt: input.dealt,
    kept: input.kept
  }
  if (input.unidentified) {
    return {
      ...identity,
      keepRate: null,
      keptWr: null,
      swappedWr: null,
      diff: null,
      diffLo: null,
      diffHi: null,
      basis: 'all-opponents',
      bands: [],
      confidence: 'hidden',
      missing: 'unidentified'
    }
  }

  const keepRate =
    input.dealt >= KEEP_THRESHOLDS.keepRate ? statsRate(input.kept, input.dealt) : null

  const contributing = input.bands.filter((c) => cellArms(c) > 0)
  const stratifiedCell: Cell = contributing.reduce<Cell>(
    (acc, c) => ({
      kept: [acc.kept[0] + c.kept[0], acc.kept[1] + c.kept[1]],
      swapped: [acc.swapped[0] + c.swapped[0], acc.swapped[1] + c.swapped[1]]
    }),
    { kept: [0, 0], swapped: [0, 0] }
  )
  const mh = mantelHaenszelDiff(
    contributing.map((c) => ({
      aWins: c.kept[0],
      aTotal: c.kept[1],
      bWins: c.swapped[0],
      bTotal: c.swapped[1]
    }))
  )
  const bandDetail: KeepBand[] = input.bands
    .map((c, band) => ({
      band,
      keptWr: c.kept[1] > 0 ? statsRate(...c.kept) : null,
      swappedWr: c.swapped[1] > 0 ? statsRate(...c.swapped) : null
    }))
    .filter((_, band) => input.bands[band].kept[1] + input.bands[band].swapped[1] > 0)

  const turnOrder = input.turnOrder ?? stratifiedCell
  const opponent = input.opponent ?? turnOrder
  const allOpponents = input.allOpponents ?? opponent

  type Rung = { basis: AdviceBasis; cell: Cell | null; adjusted: typeof mh; bands: KeepBand[] }
  const ladder: Rung[] = [
    { basis: 'stratified', cell: mh ? stratifiedCell : null, adjusted: mh, bands: bandDetail },
    { basis: 'turn-order', cell: turnOrder, adjusted: null, bands: [] },
    { basis: 'opponent', cell: opponent, adjusted: null, bands: [] },
    { basis: 'all-opponents', cell: allOpponents, adjusted: null, bands: [] }
  ]
  const chosen = ladder.find((r) => r.cell && cellArms(r.cell) >= KEEP_THRESHOLDS.show) ?? null
  const cell = chosen?.cell ?? null
  const confidence = cell ? confidenceFor(cell.kept[1], cell.swapped[1], KEEP_THRESHOLDS) : 'hidden'

  let keptWr: Rate | null = null
  let swappedWr: Rate | null = null
  let diff: number | null = null
  let diffLo: number | null = null
  let diffHi: number | null = null
  let bands: KeepBand[] = []
  if (cell && chosen && confidence !== 'hidden') {
    keptWr = statsRate(...cell.kept)
    swappedWr = statsRate(...cell.swapped)
    const interval =
      chosen.adjusted ??
      newcombeDiff(
        { wins: cell.kept[0], total: cell.kept[1] },
        { wins: cell.swapped[0], total: cell.swapped[1] }
      )
    diff = +shrink(interval.diff, cell.kept[1], cell.swapped[1]).toFixed(2)
    diffLo = +interval.lo.toFixed(2)
    diffHi = +interval.hi.toFixed(2)
    bands = chosen.bands
  }

  return {
    ...identity,
    keepRate,
    keptWr,
    swappedWr,
    diff,
    diffLo,
    diffHi,
    basis: chosen?.basis ?? 'all-opponents',
    bands,
    confidence,
    missing: keepRate === null || confidence === 'hidden' ? 'low-sample' : null
  }
}

/** One variant: the two columns' results. */
export type MulliganPair = { first: MulliganResult; second: MulliganResult }

/* ----------------------------------------------------------------- full */

/**
 * The page as it looks after a season against one opponent: both columns
 * recommend, and they disagree about the eight-drop.
 *
 * 先攻 (118 matches): two keeps, two tosses, one keep that rides the
 * all-opponents rung (the widened mark), two unclear, two unknown, one
 * unidentified. 後攻 (103): the eight-drop flips to a keep, the two-drop that
 * was the strongest keep on the play is merely unclear on the draw, and the
 * pooled keep appears again with the same numbers - because that is what a
 * pooled row does, and a reader should see it happen.
 */
const FULL_FIRST: MulliganResult = {
  matches: 118,
  baseline: statsRate(61, 118),
  cards: [
    // The clean case: every band has both arms, MH combines them, the three
    // bands agree, and the interval clears zero by a wide margin.
    advice({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      dealt: 94,
      kept: 58,
      bands: [
        { kept: [12, 18], swapped: [3, 12] },
        { kept: [20, 30], swapped: [5, 16] },
        { kept: [6, 10], swapped: [2, 8] }
      ]
    }),
    // A keep with a one-armed band: never swapped when the rest was cheap, so
    // that band is listed in the drawer but not in the estimate.
    advice({
      cardId: 900104,
      name: '知識的探求者',
      cost: 2,
      dealt: 62,
      kept: 46,
      bands: [
        { kept: [11, 16], swapped: [0, 0] },
        { kept: [14, 20], swapped: [4, 16] },
        { kept: [6, 10], swapped: [3, 12] }
      ]
    }),
    // The toss: kept rarely and it went badly when it was. Stratified.
    advice({
      cardId: 900102,
      name: '古老的巨人',
      cost: 8,
      dealt: 92,
      kept: 42,
      bands: [
        { kept: [3, 14], swapped: [10, 16] },
        { kept: [5, 20], swapped: [14, 22] },
        { kept: [1, 8], swapped: [8, 12] }
      ]
    }),
    // A toss at 'turn-order': the bands are too thin once the one-armed one
    // is dropped, pooled raw within the column they clear `show`.
    advice({
      cardId: 900105,
      name: '深淵的召喚',
      cost: 6,
      dealt: 36,
      kept: 20,
      bands: [
        { kept: [4, 13], swapped: [0, 0] },
        { kept: [1, 5], swapped: [6, 9] },
        { kept: [0, 2], swapped: [4, 7] }
      ],
      turnOrder: { kept: [5, 20], swapped: [12, 16] }
    }),
    // Fell all the way to 'all-opponents' and is a KEEP there. This is the
    // row the basis mark exists for: a confident verdict about a different
    // question than the column heading asks.
    advice({
      cardId: 900201,
      name: '天使的祝福',
      cost: 3,
      dealt: 12,
      kept: 7,
      bands: [
        { kept: [2, 3], swapped: [1, 2] },
        { kept: [2, 3], swapped: [1, 2] },
        { kept: [0, 1], swapped: [0, 1] }
      ],
      opponent: { kept: [8, 13], swapped: [4, 9] },
      allOpponents: { kept: [38, 52], swapped: [15, 41] }
    }),
    // Unclear: both arms are there, the estimate is positive, the interval
    // is not. The most common state of a card with real data.
    advice({
      cardId: 900106,
      name: '晶石守衛',
      cost: 4,
      dealt: 71,
      kept: 38,
      bands: [
        { kept: [10, 18], swapped: [5, 12] },
        { kept: [8, 14], swapped: [6, 13] },
        { kept: [3, 6], swapped: [3, 8] }
      ]
    }),
    advice({
      cardId: 900108,
      name: '火焰術士',
      cost: 3,
      dealt: 71,
      kept: 38,
      bands: [
        { kept: [8, 15], swapped: [6, 12] },
        { kept: [9, 15], swapped: [7, 14] },
        { kept: [4, 8], swapped: [3, 7] }
      ]
    }),
    // Kept 95% of the time. The swapped arm has a handful of observations at
    // every rung, so nothing can be estimated; the keep rate itself is
    // perfectly readable. The plan's 四 in a card.
    advice({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      dealt: 61,
      kept: 58,
      bands: [
        { kept: [11, 20], swapped: [1, 1] },
        { kept: [15, 28], swapped: [1, 2] },
        { kept: [6, 10], swapped: [0, 0] }
      ],
      allOpponents: { kept: [70, 131], swapped: [3, 7] }
    }),
    // Under every line, including the keep rate's.
    advice({
      cardId: 900107,
      name: '禁忌的實驗',
      cost: 5,
      dealt: 5,
      kept: 2,
      bands: [
        { kept: [1, 1], swapped: [1, 2] },
        { kept: [0, 1], swapped: [0, 1] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    }),
    // Seen only in hands that were never read in full.
    advice({
      cardId: 900110,
      name: '星辰的賢者',
      cost: 3,
      dealt: 0,
      kept: 0,
      bands: [],
      unidentified: true
    })
  ]
}

const FULL_SECOND: MulliganResult = {
  matches: 103,
  baseline: statsRate(48, 103),
  cards: [
    // The eight-drop, on the draw: a keep. Same card, opposite verdict to the
    // other column, which is the whole argument for showing both at once.
    advice({
      cardId: 900102,
      name: '古老的巨人',
      cost: 8,
      dealt: 80,
      kept: 40,
      bands: [
        { kept: [10, 14], swapped: [4, 14] },
        { kept: [12, 18], swapped: [5, 16] },
        { kept: [5, 8], swapped: [3, 10] }
      ]
    }),
    // The same pooled row as the other column, verbatim. Pooled over both
    // turn orders and every opponent, so of course it says the same thing
    // twice - and the mark says why.
    advice({
      cardId: 900201,
      name: '天使的祝福',
      cost: 3,
      dealt: 10,
      kept: 6,
      bands: [
        { kept: [2, 3], swapped: [1, 2] },
        { kept: [1, 2], swapped: [1, 1] },
        { kept: [0, 1], swapped: [0, 1] }
      ],
      opponent: { kept: [8, 13], swapped: [4, 9] },
      allOpponents: { kept: [38, 52], swapped: [15, 41] }
    }),
    // The strongest keep on the play is merely unclear on the draw.
    advice({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      dealt: 83,
      kept: 48,
      bands: [
        { kept: [9, 16], swapped: [6, 12] },
        { kept: [13, 24], swapped: [8, 16] },
        { kept: [4, 8], swapped: [3, 7] }
      ]
    }),
    advice({
      cardId: 900104,
      name: '知識的探求者',
      cost: 2,
      dealt: 40,
      kept: 22,
      bands: [
        { kept: [5, 8], swapped: [0, 0] },
        { kept: [5, 10], swapped: [5, 11] },
        { kept: [2, 4], swapped: [3, 7] }
      ]
    }),
    // Kept rarely on the draw, so the kept arm is thin at 'turn-order' and
    // the row widens to 'opponent' - where it is unclear. Widened AND
    // undecided, which is the honest reading of a six-drop on the draw.
    advice({
      cardId: 900105,
      name: '深淵的召喚',
      cost: 6,
      dealt: 30,
      kept: 6,
      bands: [
        { kept: [2, 3], swapped: [3, 8] },
        { kept: [1, 2], swapped: [6, 10] },
        { kept: [0, 1], swapped: [3, 6] }
      ],
      opponent: { kept: [7, 14], swapped: [20, 40] }
    }),
    advice({
      cardId: 900108,
      name: '火焰術士',
      cost: 3,
      dealt: 60,
      kept: 33,
      bands: [
        { kept: [7, 13], swapped: [5, 11] },
        { kept: [8, 14], swapped: [6, 11] },
        { kept: [3, 6], swapped: [2, 5] }
      ]
    }),
    advice({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      dealt: 52,
      kept: 49,
      bands: [
        { kept: [9, 17], swapped: [1, 1] },
        { kept: [13, 24], swapped: [1, 2] },
        { kept: [4, 8], swapped: [0, 0] }
      ],
      allOpponents: { kept: [70, 131], swapped: [3, 7] }
    }),
    advice({
      cardId: 900106,
      name: '晶石守衛',
      cost: 4,
      dealt: 9,
      kept: 5,
      bands: [
        { kept: [1, 2], swapped: [1, 2] },
        { kept: [2, 3], swapped: [1, 2] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    }),
    advice({
      cardId: 900107,
      name: '禁忌的實驗',
      cost: 5,
      dealt: 4,
      kept: 1,
      bands: [
        { kept: [0, 1], swapped: [1, 2] },
        { kept: [0, 0], swapped: [0, 1] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    }),
    advice({
      cardId: 900110,
      name: '星辰的賢者',
      cost: 3,
      dealt: 0,
      kept: 0,
      bands: [],
      unidentified: true
    })
  ]
}

/* ------------------------------------------------------------ one-sided */

/**
 * A few weeks in: the play side has enough to say two things, the draw side
 * has the same cards and says nothing yet. This is the pair the empty-column
 * copy is judged against - it has to sit next to a column with verdicts and
 * read as "not yet", not as "broken".
 */
const ONE_SIDED_FIRST: MulliganResult = {
  matches: 57,
  baseline: statsRate(30, 57),
  cards: [
    advice({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      dealt: 44,
      kept: 27,
      bands: [
        { kept: [6, 9], swapped: [1, 6] },
        { kept: [9, 13], swapped: [2, 8] },
        { kept: [3, 5], swapped: [0, 3] }
      ]
    }),
    advice({
      cardId: 900102,
      name: '古老的巨人',
      cost: 8,
      dealt: 40,
      kept: 17,
      bands: [
        { kept: [1, 6], swapped: [5, 8] },
        { kept: [2, 8], swapped: [8, 11] },
        { kept: [0, 3], swapped: [3, 4] }
      ]
    }),
    advice({
      cardId: 900106,
      name: '晶石守衛',
      cost: 4,
      dealt: 33,
      kept: 18,
      bands: [
        { kept: [5, 9], swapped: [3, 6] },
        { kept: [4, 7], swapped: [3, 6] },
        { kept: [1, 2], swapped: [1, 3] }
      ]
    }),
    advice({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      dealt: 30,
      kept: 27,
      bands: [
        { kept: [6, 10], swapped: [1, 1] },
        { kept: [7, 13], swapped: [0, 1] },
        { kept: [2, 4], swapped: [0, 1] }
      ]
    }),
    advice({
      cardId: 900107,
      name: '禁忌的實驗',
      cost: 5,
      dealt: 6,
      kept: 2,
      bands: [
        { kept: [1, 1], swapped: [1, 2] },
        { kept: [0, 1], swapped: [1, 2] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    })
  ]
}

const ONE_SIDED_SECOND: MulliganResult = {
  matches: 38,
  baseline: statsRate(17, 38),
  cards: [
    // Both arms present, estimate positive, interval straddling: the nearest
    // card to a verdict, and the one the empty state names.
    advice({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      dealt: 30,
      kept: 17,
      bands: [
        { kept: [4, 6], swapped: [2, 4] },
        { kept: [5, 8], swapped: [3, 6] },
        { kept: [2, 3], swapped: [1, 3] }
      ]
    }),
    // The swapped arm is one short of `show`.
    advice({
      cardId: 900102,
      name: '古老的巨人',
      cost: 8,
      dealt: 29,
      kept: 18,
      bands: [
        { kept: [4, 6], swapped: [1, 4] },
        { kept: [5, 9], swapped: [2, 5] },
        { kept: [1, 3], swapped: [1, 2] }
      ]
    }),
    advice({
      cardId: 900106,
      name: '晶石守衛',
      cost: 4,
      dealt: 21,
      kept: 13,
      bands: [
        { kept: [3, 6], swapped: [2, 4] },
        { kept: [3, 5], swapped: [1, 3] },
        { kept: [1, 2], swapped: [0, 1] }
      ]
    }),
    advice({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      dealt: 22,
      kept: 20,
      bands: [
        { kept: [4, 8], swapped: [0, 1] },
        { kept: [5, 9], swapped: [0, 1] },
        { kept: [2, 3], swapped: [0, 0] }
      ]
    }),
    advice({
      cardId: 900107,
      name: '禁忌的實驗',
      cost: 5,
      dealt: 3,
      kept: 1,
      bands: [
        { kept: [0, 1], swapped: [1, 2] },
        { kept: [0, 0], swapped: [0, 0] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    })
  ]
}

/* ---------------------------------------------------------------- young */

/**
 * The state most real accounts will be in for their first weeks: hands read,
 * keep rates showing, and not one comparison over its line in either column.
 * The page has to be worth opening in this state or it will not be opened in
 * the next.
 */
const YOUNG_FIRST: MulliganResult = {
  matches: 19,
  baseline: statsRate(10, 19),
  cards: [
    advice({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      dealt: 14,
      kept: 11,
      bands: [
        { kept: [3, 4], swapped: [0, 1] },
        { kept: [3, 5], swapped: [1, 2] },
        { kept: [1, 2], swapped: [0, 0] }
      ]
    }),
    advice({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      dealt: 12,
      kept: 7,
      bands: [
        { kept: [2, 3], swapped: [1, 2] },
        { kept: [2, 3], swapped: [1, 2] },
        { kept: [0, 1], swapped: [0, 1] }
      ]
    }),
    advice({
      cardId: 900102,
      name: '古老的巨人',
      cost: 8,
      dealt: 9,
      kept: 2,
      bands: [
        { kept: [1, 1], swapped: [2, 3] },
        { kept: [0, 1], swapped: [1, 3] },
        { kept: [0, 0], swapped: [0, 1] }
      ]
    }),
    advice({
      cardId: 900107,
      name: '禁忌的實驗',
      cost: 5,
      dealt: 4,
      kept: 1,
      bands: [
        { kept: [1, 1], swapped: [1, 2] },
        { kept: [0, 0], swapped: [0, 1] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    })
  ]
}

const YOUNG_SECOND: MulliganResult = {
  matches: 11,
  baseline: statsRate(5, 11),
  cards: [
    advice({
      cardId: 900101,
      name: '魔力調節師',
      cost: 2,
      dealt: 8,
      kept: 6,
      bands: [
        { kept: [2, 3], swapped: [0, 1] },
        { kept: [1, 2], swapped: [0, 1] },
        { kept: [1, 1], swapped: [0, 0] }
      ]
    }),
    advice({
      cardId: 900103,
      name: '魔法飛彈',
      cost: 1,
      dealt: 7,
      kept: 5,
      bands: [
        { kept: [1, 2], swapped: [1, 1] },
        { kept: [2, 3], swapped: [0, 1] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    }),
    advice({
      cardId: 900102,
      name: '古老的巨人',
      cost: 8,
      dealt: 5,
      kept: 1,
      bands: [
        { kept: [0, 1], swapped: [1, 2] },
        { kept: [0, 0], swapped: [1, 2] },
        { kept: [0, 0], swapped: [0, 0] }
      ]
    })
  ]
}

const EMPTY: MulliganResult = { matches: 0, baseline: null, cards: [] }

export type DemoMulliganKey = 'full' | 'oneSided' | 'young' | 'noMatches'

export const DEMO_MULLIGAN_VARIANTS: ReadonlyArray<{
  key: DemoMulliganKey
  label: string
  result: MulliganPair
}> = [
  { key: 'full', label: '完整資料', result: { first: FULL_FIRST, second: FULL_SECOND } },
  {
    key: 'oneSided',
    label: '只有先攻有建議',
    result: { first: ONE_SIDED_FIRST, second: ONE_SIDED_SECOND }
  },
  { key: 'young', label: '剛開始記錄的帳號', result: { first: YOUNG_FIRST, second: YOUNG_SECOND } },
  { key: 'noMatches', label: '完全沒有對局', result: { first: EMPTY, second: EMPTY } }
]
