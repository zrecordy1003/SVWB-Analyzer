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
  /**
   * Wilson score interval at 95%. Wide is honest; see `stats.ts`.
   *
   * At `total === 0` this is `{rate: 0, lo: 0, hi: 100}`: an unknown
   * proportion is the whole interval, not a point at zero. A renderer that
   * draws the interval must handle that case, or it will paint a full-width
   * bar where it means to paint nothing - check `total` first.
   */
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
   * whose pre-mulligan hand was fully identified. Below
   * `OPENING_THRESHOLDS.recognisedShare`, every other number on this row
   * deserves a warning beside it.
   *
   * NOT this card's own recognition rate, and the name flatters itself. The
   * numerator is hand-level: a hand is either read whole or it is not, and
   * whichever card spoiled it spoils it for every card in that hand. So a
   * perfectly legible card sitting in a deck full of unreadable ones reads
   * low, and with a single deck in range every card in it reads the same
   * number.
   *
   * That is the honest shape of the measurement rather than a defect - an
   * incomplete hand really is incomplete for everyone in it - but it means
   * this field is context about the matches, not an accusation against the
   * card. The accusation is `dealRateSuspect`, which IS card-specific. A
   * renderer that shows this must say which of the two it is showing.
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

  /**
   * Average cards swapped per hand, over every match whose panel was read.
   *
   * Note the denominator: every hand with four `pre` slots, NOT `preComplete`.
   * How many cards were swapped is read off the panel's geometry and does not
   * depend on naming any of them, so restricting it to fully-named hands would
   * introduce selection into the one measurement on this page that had none -
   * and not harmlessly, since a hand full of alternate illustrations is
   * precisely the hand that fails to be named.
   */
  avgSwapped: number | null
  /**
   * Win rate by how many cards were swapped, over the same denominator.
   *
   * Unlike everything else here this one IS selection-contaminated, and not by
   * recognition: people swap more when the hand is bad, so the low bands carry
   * the good hands. It is kept because "how often do I mulligan, and how does
   * that go" is a fair question about one's own habits, and dropped from any
   * reading about card quality. The renderer must say so beside the number.
   */
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

// ============================================================ 換牌建議（M5）

/**
 * How many bands the rest of the hand is summarised into.
 *
 * Three, and the reason is arithmetic rather than taste: the whole point of
 * the band is to compare keeping a card against swapping it *within* similar
 * hands, and every extra band divides an already small sample again. Three
 * distinguishes "the rest of my hand was cheap", "ordinary" and "expensive",
 * which is the distinction the confounding actually runs along - people keep a
 * costly card when the other three are cheap. Five would be more faithful and
 * would empty every cell.
 */
export const REST_BANDS = 3

/** Which comparison a piece of advice was actually computed from. */
export type AdviceBasis =
  /**
   * Same opponent, same turn order, and combined ACROSS the rest-of-hand bands
   * by Mantel-Haenszel rather than taken from one of them. The real thing.
   */
  | 'stratified'
  /** Same opponent and turn order, bands pooled raw. One rung down. */
  | 'turn-order'
  /** Same opponent, turn orders pooled too. */
  | 'opponent'
  /** Opponents pooled as well. The weakest basis still worth printing. */
  | 'all-opponents'

/**
 * One card's keep-or-swap record against the current opponent filter.
 *
 * The estimand is `kept − swapped`, which is the question a mulligan actually
 * asks. It is NOT the clean causal quantity `dealt − notDealt` that
 * [[OpeningCardStat]] carries: keeping is a decision, so this comparison is
 * confounded by whatever made the player decide - above all by the other three
 * cards. `basis` says how much of that was conditioned away.
 *
 * Locally this is better than any pooled version can be, and for a reason
 * worth stating: there is one player, so the comparison is within-player by
 * construction and skill cannot confound it. What a hundred installs would buy
 * is sample size, not cleanliness.
 */
export type KeepAdvice = {
  cardId: number
  name: string
  cost: number | null
  bannerHash: string | null
  imageHash: string | null

  /** Times this card was dealt, inside the current filter. */
  dealt: number
  /** Of those, how often it survived. */
  kept: number
  /** `kept / dealt`. Descriptive, no estimation, readable early. */
  keepRate: Rate | null

  /** Win rate of the matches where it was kept. */
  keptWr: Rate | null
  /** Win rate of the matches where it went back. */
  swappedWr: Rate | null
  /**
   * The adjusted difference in points, shrunk toward zero.
   *
   * Positive means the matches where this card stayed went better. It does
   * not mean keeping it caused that - read `basis` and the interval.
   *
   * **This is not `keptWr.rate − swappedWr.rate`.** At `basis: 'stratified'`
   * it is a Mantel-Haenszel combination across the rest-of-hand bands, so it
   * can differ from the crude gap between the two rates beside it - and that
   * gap is the confounding those bands exist to remove. At the lower rungs
   * there is nothing to adjust and the two do coincide.
   */
  diff: number | null
  diffLo: number | null
  diffHi: number | null

  /** How the estimate was reached, after any fallback. */
  basis: AdviceBasis
  /**
   * The per-band arms behind a `'stratified'` estimate, for the drill-down.
   *
   * Empty at every other basis. Worth opening because a difference that lives
   * in one band and vanishes in the others is a difference that is probably
   * noise, and no summary number can show that.
   */
  bands: KeepBand[]
  confidence: Confidence
  missing: Missing | null
}

/**
 * The per-band detail behind one card, for the drill-down.
 *
 * Kept separate from [[KeepAdvice]] because the summary is what the page
 * shows and this is what a suspicious reader opens to check: a difference
 * that only exists in one band is a difference that is probably noise.
 */
export type KeepBand = {
  /** 0 = the other three were cheapest, `REST_BANDS - 1` = most expensive. */
  band: number
  keptWr: Rate | null
  swappedWr: Rate | null
}

export type MulliganPayload = OpeningStatsPayload & {
  /** Null pools every opponent. A class name narrows to that matchup. */
  oppoClass?: string | null
  /** Null pools both. `'first'` / `'second'` narrows. */
  playOrder?: string | null
}

export type MulliganResult = {
  /** Matches inside the filter whose pre-mulligan hand was read in full. */
  matches: number
  /** The filter's own win rate - the baseline every card is read against. */
  baseline: Rate | null
  cards: KeepAdvice[]
}

/** Thresholds for the keep comparison. Both arms, not the sum. */
export const KEEP_THRESHOLDS = {
  /** Times dealt before a keep rate is printed. */
  keepRate: 8,
  /** Per arm before a difference is shown at all. */
  show: 12,
  /** Per arm before the table may be sorted on it. */
  sort: 30,
  /**
   * Widest interval that may still produce a verdict, in points.
   *
   * Clearing zero was the only test, and it has a hole: `+1 [+0.5, +35]`
   * clears, and is one observation away from not clearing. A recommendation
   * that flips back and forth as games arrive costs more trust than one that
   * never appeared, and this page's whole pitch is that it does not overclaim.
   *
   * Thirty follows NCHS's suppression rule for proportions (an absolute
   * confidence-interval width of 0.30 or more is not published). Ours is a
   * DIFFERENCE of proportions, whose interval is wider for the same sample, so
   * thirty is if anything the lenient reading of that precedent - which is
   * fine, because the point here is to catch the barely-clearing case rather
   * than to demand precision this data cannot give.
   */
  maxWidth: 30
} as const

/**
 * What the page tells the reader to do with a card.
 *
 * This is where the confidence interval went. The advisor used to print
 * `+16.0 [9.5, 29.3]` and leave the reader to judge; it now says 建議留 and
 * says nothing about the arithmetic. That is a STRONGER claim, not a weaker
 * one, so the bar had to go up rather than down: a recommendation is only made
 * when the whole interval sits on one side of zero. A card whose interval
 * straddles zero has a point estimate and no direction, and printing a
 * direction for it would be inventing one.
 *
 * So the interval is still doing all the work it ever did - it just decides
 * what appears instead of appearing itself.
 */
export type KeepVerdict =
  /** The evidence points at keeping it, and does not cross over. */
  | 'keep'
  /** The evidence points at throwing it back. */
  | 'toss'
  /** Enough data to estimate, not enough to point anywhere. */
  | 'unclear'
  /** Not enough of one arm to estimate at all. */
  | 'unknown'

/**
 * Read a verdict off one card's record.
 *
 * Deliberately has no threshold of its own beyond the ones already in
 * `confidence`. A card with twelve observations in its smaller arm produces an
 * interval so wide that it cannot clear zero, so the width regulates this
 * without a second number to keep in step - and two thresholds that must agree
 * are two thresholds that will eventually disagree.
 */
export function verdictFor(advice: {
  confidence: Confidence
  diffLo: number | null
  diffHi: number | null
}): KeepVerdict {
  if (advice.confidence === 'hidden' || advice.diffLo === null || advice.diffHi === null) {
    return 'unknown'
  }
  // Wide enough to flip next week is not a verdict, even pointing one way.
  if (advice.diffHi - advice.diffLo >= KEEP_THRESHOLDS.maxWidth) return 'unclear'
  if (advice.diffLo > 0) return 'keep'
  if (advice.diffHi < 0) return 'toss'
  return 'unclear'
}

/**
 * Does this row's evidence actually concern the opponent the reader picked?
 *
 * The fallback ladder exists so a thin matchup gets an answer instead of a
 * blank, and that is right for a NUMBER. It is not right for a VERDICT. With
 * thirty matches against elf every recommendation comes from the rung that
 * pooled the opponents away, so a column headed 「對上精靈」 fills with
 * confident-looking advice, none of it about elf - and the same five cards,
 * with the same numbers, appear in all seven columns.
 *
 * The mark saying which rung answered is already on every row, but a reader
 * scanning green recommendations reads the recommendation first. So the rule
 * is structural rather than typographic: **evidence that pooled away the thing
 * you asked about cannot be presented as an answer about it.** Those cards are
 * still shown, under their own heading, described as what they are.
 *
 * Only the opponent is treated this way. `'opponent'` pools the turn orders,
 * which weakens a column heading but still concerns the matchup the reader
 * chose; the mark carries that, and forbidding it as well would empty the page
 * for a distinction most readers would accept. With no opponent picked, the
 * pooled rung IS the question asked, and everything answers.
 */
export function answersTheChosenMatchup(basis: AdviceBasis, oppoPinned: boolean): boolean {
  if (!oppoPinned) return true
  return basis !== 'all-opponents'
}
