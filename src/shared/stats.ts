/**
 * The arithmetic behind the 起手 page, kept away from the SQL that feeds it.
 *
 * Everything here is a pure function of numbers, with no I/O and no imports
 * beyond the contract's types and constants. That is not a stylistic
 * preference: `docs/opening-hand-plan.md` (stage 4) argues that at the sample
 * sizes a single player produces, a Wilson interval and shrinkage are the
 * difference between a page that informs and one that awards ribbons to noise.
 * Arguments like that are only worth anything if the formulas can be checked
 * against hand-computed values in isolation, which means they cannot live
 * inside an IPC handler that needs a database to run.
 *
 * Conventions, so callers do not have to read every signature:
 *
 * - Rates and interval bounds are percentages, 0-100, matching [[Rate]].
 * - A p-value is a probability, 0-1. It is a test statistic the renderer
 *   compares against a level, not a number it prints, so dressing it up as a
 *   percentage would only invite someone to display it next to a win rate.
 * - Nothing returns `NaN` or `Infinity`. Every division has a guard, and an
 *   input that makes the question meaningless (zero trials, an empty list)
 *   gets the honest answer - "unknown", "the whole interval", `null` - rather
 *   than zero dressed up as data.
 */
import {
  DECK_SIZE,
  HAND_SIZE,
  OPENING_THRESHOLDS,
  type Confidence,
  type Rate
} from './openingStats.js'

/** Two-sided 95%. The one number every interval on the page shares. */
const Z_95 = 1.96

const clampPct = (x: number): number => Math.min(100, Math.max(0, x))

/**
 * Clamp, then round to two decimals.
 *
 * Rounding happens here rather than in the renderer so that every percentage
 * crossing the IPC boundary has already been rounded the same way. The first
 * pass left `rate` raw while the bounds beside it were rounded downstream, and
 * `67.52136752136752%` duly reached the page next to a tidy `29.03%` - the kind
 * of inconsistency that gets patched with a `toFixed` at one call site and then
 * quietly diverges at the next one.
 *
 * Two decimals because these are percentages of at most a few hundred matches:
 * a third would be inventing precision the denominator cannot support.
 */
const pct = (x: number): number => +clampPct(x).toFixed(2)

/**
 * Wilson score interval for a proportion, as percentages.
 *
 * Wilson rather than the textbook Wald interval (`p ± z·sqrt(p(1-p)/n)`)
 * because Wald is exactly wrong where this page lives. At 0/10 Wald gives
 * `0 ± 0` - a claim of certainty from ten observations - and at 9/10 it
 * overshoots 100. Wilson's centre is pulled toward 50% by an amount that
 * shrinks with n, so a small sample reads as wide and lopsided, which is what
 * it is. Clopper-Pearson would also be acceptable but is wider than the data
 * warrants and needs the beta function; Wilson is closed-form.
 *
 * `total === 0` returns the whole interval, `[0, 100]`, with `rate` 0. An
 * unobserved proportion is not zero, it is anything, and a renderer that
 * checks `total` first (as [[Rate]] asks) never prints that zero.
 *
 * `wins` is clamped into `[0, total]` so a caller that hands in an
 * inconsistent pair (a join that double-counted, say) gets a bounded answer
 * instead of a square root of a negative number.
 */
export function wilson(
  wins: number,
  total: number,
  z: number = Z_95
): { rate: number; lo: number; hi: number } {
  if (!Number.isFinite(total) || total <= 0) return { rate: 0, lo: 0, hi: 100 }
  const n = total
  const k = Number.isFinite(wins) ? Math.min(n, Math.max(0, wins)) : 0
  const zz = Number.isFinite(z) ? z * z : Z_95 * Z_95
  const p = k / n

  const denominator = 1 + zz / n
  const centre = (p + zz / (2 * n)) / denominator
  const halfWidth = (Math.sqrt(zz) / denominator) * Math.sqrt((p * (1 - p)) / n + zz / (4 * n * n))

  return {
    rate: pct(p * 100),
    lo: pct((centre - halfWidth) * 100),
    hi: pct((centre + halfWidth) * 100)
  }
}

/** The [[Rate]] shape the contract uses everywhere, built from [[wilson]]. */
export function rate(wins: number, total: number): Rate {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0
  const safeWins = Number.isFinite(wins) ? Math.min(safeTotal, Math.max(0, wins)) : 0
  return { total: safeTotal, wins: safeWins, ...wilson(safeWins, safeTotal) }
}

/**
 * Score interval for the difference of two proportions (Newcombe, 1998,
 * method 10), in percentage points.
 *
 * This is what `diffLo` / `diffHi` in [[OpeningCardStat]] should be built
 * from. The naive alternative - `diff ± z·sqrt(seA² + seB²)` - inherits
 * every defect of the Wald interval twice over: it collapses to zero width
 * when either arm is 0/n or n/n, which at twenty observations per arm is not
 * rare. Newcombe's construction takes the two Wilson intervals, which already
 * behave at the boundaries, and combines the half-widths on each side
 * separately, so the result is as lopsided as its inputs.
 */
export function newcombeDiff(
  a: { wins: number; total: number },
  b: { wins: number; total: number }
): { diff: number; lo: number; hi: number } {
  const wa = wilson(a.wins, a.total)
  const wb = wilson(b.wins, b.total)
  const diff = wa.rate - wb.rate
  const lo = diff - Math.sqrt((wa.rate - wa.lo) ** 2 + (wb.hi - wb.rate) ** 2)
  const hi = diff + Math.sqrt((wa.hi - wa.rate) ** 2 + (wb.rate - wb.lo) ** 2)
  return {
    diff: +diff.toFixed(2),
    lo: +Math.max(-100, lo).toFixed(2),
    hi: +Math.min(100, hi).toFixed(2)
  }
}

/**
 * How often a hand of `handSize` from a deck of `deckSize` contains at least
 * one of `copies` copies. Percentage.
 *
 * `1 - C(deckSize - copies, handSize) / C(deckSize, handSize)`, but written as
 * the product of the per-draw odds of *missing* the card:
 *
 *     P(none) = Π_{i<handSize} (deckSize - copies - i) / (deckSize - i)
 *
 * The two are algebraically identical; the product form is chosen because it
 * never forms a factorial. `40!` is already past what a double represents
 * exactly, and while a ratio of two overflowing numbers happens to work out
 * for these sizes, a formula that is correct by accident is one somebody will
 * later reuse with a 60-card deck and a 7-card hand and watch fail.
 *
 * The product form also tolerates a non-integer `copies`, which matters
 * because [[OpeningCardStat]] reports `copies` as an *average* across deck
 * versions (a card run as a 3-of and later a 2-of reads 2.4). The result is
 * then the expectation under a fractional count - not a real deck, but the
 * only defensible single number for a card whose count changed.
 *
 * Guards: no copies means it cannot be dealt; more copies than there are
 * non-copies to fill the rest of the hand with means it always is. Both are
 * exact answers, not approximations, and returning them explicitly keeps the
 * product from walking through a negative numerator.
 */
export function hypergeometricAtLeastOne(
  copies: number,
  deckSize: number = DECK_SIZE,
  handSize: number = HAND_SIZE
): number {
  if (!Number.isFinite(copies) || copies <= 0) return 0
  if (!Number.isFinite(deckSize) || deckSize <= 0) return 0
  if (!Number.isFinite(handSize) || handSize <= 0) return 0
  if (copies > deckSize - handSize) return 100

  let none = 1
  for (let i = 0; i < handSize; i++) {
    none *= (deckSize - copies - i) / (deckSize - i)
  }
  return clampPct((1 - none) * 100)
}

/**
 * Relative slack when comparing two binomial probabilities for "no more
 * likely than". At p = 50% the pmf is exactly symmetric, and the mirror of
 * the observed outcome comes out a few ulps off in floating point; without
 * this it would be dropped from the tail and the p-value would be visibly
 * wrong (0.055 where the textbook says 0.109).
 */
const PMF_TIE_TOLERANCE = 1e-9

/**
 * Exact two-sided p-value for `observed` successes in `n` trials when each
 * has probability `p` (a PERCENTAGE, 0-100, to match `expectedDealRate`,
 * which is what callers hand in). Returns a probability, 0-1.
 *
 * This backs `dealRateSuspect`: with `p = hypergeometricAtLeastOne(copies)`
 * and `observed` the matches where the card was actually seen, a tiny value
 * says the recogniser is missing a card the deck says should be there.
 *
 * # Exact, not approximated
 *
 * The first draft was the normal approximation with a continuity
 * correction, and it was replaced for the case that matters most. At
 * `OPENING_THRESHOLDS.dealCheck = 50` a 1-of has `np = 5`, the edge of where
 * the approximation is defensible, and there it was wrong in both
 * directions: too *large* a p-value when the card was never seen (0.034
 * against an exact 0.0084 - the alarm the check exists for, blunted at the
 * first sample size it can fire at) and too *small* when it was seen too
 * often. n here is bounded by one user's match count, so summing the whole
 * pmf is cheap and there is no reason to accept either error.
 *
 * # Which "two-sided"
 *
 * The method of small p-values: the sum of the probability of every outcome
 * no more likely than the one observed. A skewed binomial has no natural
 * "equally far on the other side", so doubling the one-sided tail (the
 * textbook shortcut) either exceeds 1 or counts outcomes on the far side
 * that are more probable than what was seen. Summing by likelihood is the
 * definition that stays coherent for any p, and it makes the mode return
 * exactly 1, which is what a caller comparing against a level wants.
 *
 * The pmf is built from accumulated log-factorials and exponentiated per
 * term, so `C(300, 150)` never exists as a number; every term is a
 * probability and the sum is at most 1.
 *
 * Degenerate inputs: no trials means no evidence, so 1. `p` at 0 or 100
 * leaves only one possible outcome; the observation either is it (1) or is
 * impossible under the hypothesis (0). `observed` is a count, so it is
 * rounded and clamped into `[0, n]` rather than trusted.
 */
export function binomialTwoSided(observed: number, n: number, p: number): number {
  if (!Number.isFinite(n) || n < 1 || !Number.isFinite(observed) || !Number.isFinite(p)) return 1
  const trials = Math.floor(n)
  const k = Math.min(trials, Math.max(0, Math.round(observed)))
  const prob = clampPct(p) / 100
  if (prob === 0) return k === 0 ? 1 : 0
  if (prob === 1) return k === trials ? 1 : 0

  const logFactorial = new Float64Array(trials + 1)
  for (let i = 1; i <= trials; i++) logFactorial[i] = logFactorial[i - 1] + Math.log(i)
  const logP = Math.log(prob)
  const logQ = Math.log(1 - prob)
  const pmf = (successes: number): number =>
    Math.exp(
      logFactorial[trials] -
        logFactorial[successes] -
        logFactorial[trials - successes] +
        successes * logP +
        (trials - successes) * logQ
    )

  const observedPmf = pmf(k)
  const ceiling = observedPmf * (1 + PMF_TIE_TOLERANCE)
  let tail = 0
  let mode = 0
  for (let i = 0; i <= trials; i++) {
    const term = pmf(i)
    if (term > mode) mode = term
    if (term <= ceiling) tail += term
  }
  // The most likely outcome is by definition no evidence against the
  // hypothesis; return exactly 1 rather than a sum that is 1 minus rounding.
  if (observedPmf >= mode * (1 - PMF_TIE_TOLERANCE)) return 1
  return Math.min(1, Math.max(0, tail))
}

/**
 * Pull a difference in percentage points toward zero by an amount that
 * depends on how much data stands behind it.
 *
 * The page sorts on this and displays the raw difference with its interval
 * (see `diff` in [[OpeningCardStat]]). Sorting on the raw difference puts
 * the least-observed card on top every time, because the most extreme value
 * in a table is almost always the noisiest one; sorting on the interval's
 * lower bound is the usual fix but ranks every card with a wide interval at
 * the bottom regardless of its point estimate, which throws away the one
 * thing the user came to see. Shrinkage sits between the two.
 *
 * # The form
 *
 * `diff · n_eff / (n_eff + priorWeight)`, with `n_eff = 2 / (1/nA + 1/nB)`,
 * the harmonic mean of the two arms. Harmonic rather than arithmetic or
 * `min` because the variance of a difference of proportions is
 * `p(1-p)·(1/nA + 1/nB) = 2p(1-p)/n_eff`, so this is exactly the sample size
 * the difference *behaves* as though it had. A card dealt 20 times against
 * 500 not-dealt matches has `n_eff ≈ 38`, not 260 and not 20.
 *
 * This is the posterior mean under a normal prior on the true difference
 * centred at zero: `priorWeight = 2p(1-p) / τ²`, where `τ` is the prior
 * standard deviation of true effects. Taking `p ≈ 0.5` and working in
 * percentage points, `priorWeight ≈ 5000 / τ_pp²`.
 *
 * # Why 40, and what would justify changing it
 *
 * 40 corresponds to `τ ≈ 11pp` - a belief that a card's true effect on the
 * win rate, when dealt, is drawn from a spread with an 11-point standard
 * deviation. That is a *lenient* prior: `docs/opening-hand-plan.md` argues
 * that in a mature constructed list real effects are almost all under 7pp,
 * which would argue for `τ ≈ 5pp` and a weight nearer 200. The lower figure
 * is chosen deliberately, for two reasons. First, the table is only ever
 * sortable at `wrSort = 50` per arm, where 40 already halves an extreme
 * difference (`50/90 ≈ 0.56`) while 200 would leave a fifth of it - at
 * which point the ranking is nearly all sample size and the shrunk column
 * stops carrying information the `n` column does not. Second, the stated
 * purpose of this page at personal-data sizes is to catch *outliers*, and a
 * prior tuned to the population of ordinary cards is the wrong prior for a
 * search that only cares about the tail of it.
 *
 * Raise it if, once real data exists, the top of the sorted table is
 * dominated by cards at the `wrSort` boundary; that is the signature of
 * under-shrinking. Lower it only if the page starts showing pooled data
 * across many users, where the effective n is large enough that the prior
 * barely matters anyway.
 *
 * Either arm at zero returns 0: there is no comparison, so there is no
 * difference, and `n_eff` would otherwise divide by zero.
 */
export function shrink(diff: number, nA: number, nB: number, priorWeight: number = 40): number {
  if (!Number.isFinite(diff)) return 0
  if (!Number.isFinite(nA) || !Number.isFinite(nB) || nA <= 0 || nB <= 0) return 0
  const nEff = 2 / (1 / nA + 1 / nB)
  const weight = Number.isFinite(priorWeight) && priorWeight >= 0 ? priorWeight : 40
  return (diff * nEff) / (nEff + weight)
}

/**
 * How far the dealt-versus-not-dealt comparison may be trusted, by the
 * smaller arm.
 *
 * Both arms have to clear the bar, not their sum. A card dealt 5 times out
 * of 300 matches has 295 not-dealt observations and tells us nothing about
 * dealing it; the sum would read 300 and wave it through. The smaller arm
 * is what limits the variance of the difference (see [[shrink]] on `n_eff`),
 * so it is the smaller arm that decides.
 */
export function confidenceFor(nDealt: number, nNotDealt: number): Confidence {
  const smaller = Math.min(
    Number.isFinite(nDealt) ? nDealt : 0,
    Number.isFinite(nNotDealt) ? nNotDealt : 0
  )
  if (smaller >= OPENING_THRESHOLDS.wrSort) return 'sortable'
  if (smaller >= OPENING_THRESHOLDS.wrShow) return 'shown'
  return 'hidden'
}

/**
 * Arithmetic mean, or `null` for an empty list.
 *
 * Every average on the summary (`avgSwapped`, `avgCostPre`, ...) is typed
 * `number | null` because "no complete hands yet" and "the average was zero"
 * are different facts and the renderer shows them differently. Returning 0
 * here would quietly turn the first into the second. Non-finite entries are
 * skipped rather than poisoning the whole result; if they were all
 * non-finite the list is treated as empty.
 */
export function mean(xs: number[]): number | null {
  let sum = 0
  let count = 0
  for (const x of xs) {
    if (!Number.isFinite(x)) continue
    sum += x
    count++
  }
  return count === 0 ? null : sum / count
}
