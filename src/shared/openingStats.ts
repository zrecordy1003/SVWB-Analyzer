/**
 * 起手 — the opening-hand statistics contract.
 *
 * Separate from `cardStats.ts` on purpose, and the reason is not tidiness. The
 * 卡片 page answers "how did the decks that carried this card do" (17Lands' GP
 * WR); its own header admits there is no draw data behind it, and App.tsx has
 * it switched off for exactly that reason. This channel answers a different
 * question from a different denominator, and its numbers change over time as
 * unnamed cards get named in the background (`Command::RetryUnnamedCards`).
 * Two things with different denominators, different completeness rules and
 * different freshness do not belong in one table.
 *
 * # The distinction the whole file is built around
 *
 * The four cards **before** the mulligan are a hypergeometric draw from the
 * deck: whether card c appears is independent of the opponent, of the turn
 * order, of how the player felt that evening. It is a random assignment, and
 * so `dealt` versus `notDealt` is an intent-to-treat effect with no selection
 * in it.
 *
 * The four cards **after** the mulligan are not. They were chosen. A card kept
 * was kept because of the other three, the opponent's class and the turn
 * order, so its win rate measures the player's judgement as much as the card.
 *
 * Every mature product in this space measures the second one and calls it an
 * opening-hand win rate - 17Lands' OH WR, HSReplay's "Mulligan Winrate",
 * Mobalytics' column of the same name - and none of them say so. We read the
 * hand before the mulligan, so we do not have to make that trade. That is why
 * [[OpeningCardStat]] carries `dealt`/`notDealt` and deliberately carries no
 * "kept win rate": see `docs/opening-hand-plan.md`, stage 4.
 *
 * # Why so many nulls
 *
 * A number that cannot honestly be computed is `null` here rather than zero or
 * an approximation, and there are three different ways it can fail to exist:
 * the match had no deck attached (so the denominator is unknown), a slot was
 * not identified (so the hand is incomplete), or there simply is not enough
 * data yet. The renderer is expected to show those three as three different
 * things - see [[Missing]].
 */
import type { GameMode } from './domain.js'
import type { QueryPayload } from './types.js'

/**
 * The match-list filters, plus the two the aggregate pages add.
 *
 * Deliberately the same shape as `CardStatsPayload` so the filter bar
 * components are shared verbatim rather than re-implemented a few percent
 * differently.
 */
export type OpeningStatsPayload = Omit<
  QueryPayload,
  'mode' | 'cursor' | 'pageIndex' | 'pageSize'
> & {
  mode?: GameMode | 'all' | null
  /** Keep only the `limit` most recent matches that pass every other filter. */
  limit?: number | null
}

/** A win-rate estimate with its uncertainty. Percentages, 0-100. */
export type Rate = {
  total: number
  wins: number
  /** `wins / total`, as a percentage. Zero when `total` is zero - read `total` first. */
  rate: number
  /** Wilson score interval at 95%. Wide is honest; see `stats.ts`. */
  lo: number
  hi: number
}

/**
 * Why a number is absent.
 *
 * 17Lands collapses all of these into "the count column reads 0". That is fine
 * at n in the thousands and actively misleading at n in the dozens, because
 * "you never drew it" and "we could not read the screen" call for completely
 * different reactions from the user.
 */
export type Missing =
  /** Real data, and the card simply did not turn up. A trustworthy zero. */
  | 'never-dealt'
  /** No deck attached to those matches, so "is c in the deck" has no answer. */
  | 'no-deck'
  /** A slot in the hand was never identified, so the hand cannot be counted. */
  | 'unidentified'
  /** There is data, but not enough of it to show a number for. */
  | 'low-sample'

/**
 * How far a card's dealt-versus-not-dealt comparison may be trusted.
 *
 * Three states rather than a boolean because there are two different
 * thresholds: one below which a number must not be *shown*, and a higher one
 * below which it must not be used to *sort*. A table sorted on noise invents a
 * ranking the data cannot support, which is the failure mode of every letter
 * grade in this genre.
 */
export type Confidence = 'hidden' | 'shown' | 'sortable'

/**
 * One card's opening-hand record.
 *
 * Read the fields in the order they are declared: identity, then the part that
 * needs nothing but recognition (keep rate), then the part that additionally
 * needs a deck list (the deal-rate check), then the part that additionally
 * needs a large sample (the dealt comparison). Each section can be null while
 * a later one is not, which is why they are not collapsed into one optional
 * blob.
 */
export type OpeningCardStat = {
  cardId: number
  /** `#<cardId>` when the card master cache has no row for it. */
  name: string
  cost: number | null
  rarity: number | null
  /** For the list thumbnail; null when the cache has no row. */
  bannerHash: string | null
  /** The class this card belongs to, `'neutral'` for cards every class may run. */
  className: string | null

  // ---- needs only that this card was identified in the pre-mulligan hand ----

  /** Matches where this card was identified in the hand as dealt. */
  dealt: number
  /** Of those, how often it survived the mulligan. */
  kept: number
  /**
   * `kept / dealt`, as a percentage, with its interval.
   *
   * This is the one number on the page that is purely descriptive: it reports
   * a decision the user made, not an outcome they hope to predict, so it
   * carries no selection problem and is readable at a couple of dozen
   * observations. It is therefore what the page leads with.
   */
  keepRate: Rate | null

  // ---- additionally needs a deck list, and a fully identified hand ----

  /** Average copies carried, across the deck versions in range. Null without a deck. */
  copies: number | null
  /** Matches with a deck attached AND all four pre slots identified. */
  eligible: number
  /**
   * The hypergeometric expectation: with `copies` copies in a 40-card deck,
   * how often a 4-card hand should contain at least one. Percentage.
   */
  expectedDealRate: number | null
  /** What actually happened, over `eligible` matches. Percentage. */
  observedDealRate: number | null
  /**
   * True when observed differs from expected by more than chance explains.
   *
   * This is a recognition alarm wearing a statistic's clothes. A card that is
   * systematically unreadable - an alternate illustration, a foil - goes
   * missing from hands it was really in, and its deal rate falls below what
   * the deck composition makes possible. Nothing else in the app notices that
   * without a human watching the screen.
   */
  dealRateSuspect: boolean
  /**
   * Of the matches where a deck containing this card was attached, the share
   * whose pre-mulligan hand was fully identified. Below ~0.9 every other
   * number on this row deserves a warning beside it.
   */
  recognisedShare: number | null

  // ---- additionally needs a large sample ----

  /** Win rate of matches where this card was dealt. */
  dealtWr: Rate | null
  /** Win rate of matches where it was in the deck and not dealt. */
  notDealtWr: Rate | null
  /**
   * `dealtWr - notDealtWr`, in percentage points, shrunk toward zero.
   *
   * Shrunk, not raw: with a dozen observations the raw difference is mostly
   * noise, and a table sorted on raw differences puts the noisiest card on top
   * every time. The shrunk value is what the page sorts by; `diffLo`/`diffHi`
   * describe the raw difference and are what it shows.
   */
  diff: number | null
  diffLo: number | null
  diffHi: number | null
  /** How much of the above the renderer may show, and whether it may sort on it. */
  confidence: Confidence
  /** Set when a section is absent, so the renderer can say which kind of absent. */
  missing: Missing | null
}

/** One bar of the mana curve: how many cards of this cost a hand held on average. */
export type CurvePoint = {
  /** Mana cost; the last bucket is "this cost or more", see `CURVE_MAX_COST`. */
  cost: number
  /** Average number of cards at this cost in the hand as dealt. */
  pre: number
  /** Same, after the mulligan. The difference is the shape of the user's habit. */
  post: number
}

/** Costs at or above this are one bucket - four 8-drops is not four numbers. */
export const CURVE_MAX_COST = 7

/** The record of hands where exactly this many cards were swapped. */
export type SwapBand = {
  /** 0 to 4. */
  swapped: number
  total: number
  wins: number
  rate: number
}

/**
 * What the page can say about the user's mulligan as a whole.
 *
 * Hand-level rather than card-level, so every field here requires a hand that
 * was read completely. A curve computed from three of four cards is not a
 * noisier curve, it is a wrong one.
 */
export type OpeningSummary = {
  /** Matches with any opening-hand row at all. */
  matches: number
  /** Of those, how many had all four pre-mulligan slots identified. */
  preComplete: number
  /** Of those, how many had all eight slots identified. */
  complete: number
  /** Of those, how many also had a deck attached - the deal-rate denominator. */
  withDeck: number
  /** Slots that are still waiting for a name in the background. */
  pendingRetry: number

  /** Average cards swapped per hand, over `preComplete` matches. */
  avgSwapped: number | null
  /** Win rate by how many cards were swapped. Selection-contaminated; labelled as such. */
  swapBands: SwapBand[]
  /** Same, split by turn order, because the decision differs and `play_order` is recorded. */
  swapByPlayOrder: { first: SwapBand[]; second: SwapBand[] }

  /** The curve as dealt and as kept, over `complete` matches. */
  curve: CurvePoint[]
  avgCostPre: number | null
  avgCostPost: number | null
}

export type OpeningStatsResult = {
  summary: OpeningSummary
  cards: OpeningCardStat[]
}

/**
 * Thresholds.
 *
 * The 500-game figure that 17Lands and Untapped.gg independently landed on is
 * the right number for a pooled dataset and an impossible one for a single
 * player: it would mean showing nothing for the first two years. These are set
 * where a number stops being actively misleading rather than where it becomes
 * precise, and every number below a threshold is replaced by its sample size
 * rather than hidden - "n=7" tells the user what "—" does not.
 */
export const OPENING_THRESHOLDS = {
  /** Times dealt before a keep rate is worth printing. */
  keepRate: 10,
  /** Matches before the deal-rate check can accuse the recogniser of anything. */
  dealCheck: 50,
  /** Per arm (dealt / not dealt) before a win rate is shown at all. */
  wrShow: 20,
  /** Per arm before the table may be sorted on the difference. */
  wrSort: 50,
  /** Complete hands before the curve is drawn. */
  curve: 30,
  /** Below this share of hands identified, every number gets a warning. */
  recognisedShare: 0.9
} as const

/** Deck size, for the hypergeometric expectation. Constructed is always 40. */
export const DECK_SIZE = 40
/** Cards dealt before the mulligan. */
export const HAND_SIZE = 4
