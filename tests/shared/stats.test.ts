/**
 * The formulas behind the 起手 page, checked against values worked out by
 * hand (and against the three figures `docs/opening-hand-plan.md` quotes).
 * If one of these breaks, a number on the page is wrong; there is no test
 * further up the stack that would notice.
 */
import { describe, expect, it } from 'vitest'

import { DECK_SIZE, HAND_SIZE, OPENING_THRESHOLDS } from '../../src/shared/openingStats'
import {
  binomialTwoSided,
  confidenceFor,
  hypergeometricAtLeastOne,
  mean,
  newcombeDiff,
  rate,
  shrink,
  wilson,
  mantelHaenszelDiff
} from '../../src/shared/stats'

const finite = (value: { rate: number; lo: number; hi: number }): void => {
  expect(Number.isFinite(value.rate)).toBe(true)
  expect(Number.isFinite(value.lo)).toBe(true)
  expect(Number.isFinite(value.hi)).toBe(true)
}

describe('wilson', () => {
  it('matches the textbook interval for 5/10', () => {
    const w = wilson(5, 10)
    expect(w.rate).toBe(50)
    expect(w.lo).toBeCloseTo(23.66, 1)
    expect(w.hi).toBeCloseTo(76.34, 1)
  })

  it('does not claim certainty at 0/10 or 10/10 the way Wald would', () => {
    const none = wilson(0, 10)
    expect(none.rate).toBe(0)
    expect(none.lo).toBe(0)
    expect(none.hi).toBeCloseTo(27.75, 1)

    const all = wilson(10, 10)
    expect(all.rate).toBe(100)
    expect(all.lo).toBeCloseTo(72.25, 1)
    expect(all.hi).toBe(100)
  })

  it('leaves most of the range open after a single observation', () => {
    const w = wilson(1, 1)
    expect(w.rate).toBe(100)
    expect(w.lo).toBeCloseTo(20.65, 1)
    expect(w.hi).toBe(100)
  })

  it('is lopsided around the point estimate at small n', () => {
    // 1/10: the upper arm reaches much further than the lower one, because
    // the centre is pulled toward 50%. A symmetric interval here is a bug.
    const w = wilson(1, 10)
    expect(w.rate).toBe(10)
    expect(w.lo).toBeCloseTo(1.79, 1)
    expect(w.hi).toBeCloseTo(40.42, 1)
    expect(w.hi - w.rate).toBeGreaterThan(3 * (w.rate - w.lo))
  })

  it('returns the whole interval when nothing has been observed', () => {
    expect(wilson(0, 0)).toEqual({ rate: 0, lo: 0, hi: 100 })
    expect(wilson(3, 0)).toEqual({ rate: 0, lo: 0, hi: 100 })
  })

  it('narrows monotonically as n grows at a fixed rate', () => {
    let previous = Infinity
    for (const n of [4, 10, 20, 50, 100, 500, 2000]) {
      const w = wilson(n / 2, n)
      const width = w.hi - w.lo
      expect(width).toBeLessThan(previous)
      previous = width
    }
  })

  it('stays inside 0-100 and finite for hostile inputs', () => {
    finite(wilson(-3, 10))
    finite(wilson(15, 10))
    finite(wilson(NaN, 10))
    finite(wilson(5, NaN))
    finite(wilson(5, Infinity))
    expect(wilson(15, 10).rate).toBe(100)
    expect(wilson(-3, 10).rate).toBe(0)
  })
})

describe('rate', () => {
  it('assembles the contract shape from wilson', () => {
    const r = rate(7, 20)
    expect(r.total).toBe(20)
    expect(r.wins).toBe(7)
    expect(r.rate).toBe(35)
    expect(r.lo).toBeCloseTo(wilson(7, 20).lo, 6)
    expect(r.hi).toBeCloseTo(wilson(7, 20).hi, 6)
  })

  it('keeps total at zero rather than inventing one', () => {
    expect(rate(0, 0)).toEqual({ total: 0, wins: 0, rate: 0, lo: 0, hi: 100 })
  })
})

describe('newcombeDiff', () => {
  it('is centred on the raw difference and keeps width when an arm is at a boundary', () => {
    const d = newcombeDiff({ wins: 20, total: 20 }, { wins: 10, total: 20 })
    expect(d.diff).toBe(50)
    // Wald would give the 20/20 arm zero variance and a one-sided interval.
    expect(d.hi - d.diff).toBeGreaterThan(0)
    expect(d.diff - d.lo).toBeGreaterThan(0)
    expect(d.lo).toBeLessThan(50)
    expect(d.hi).toBeLessThanOrEqual(100)
  })

  it('brackets zero when both arms are identical', () => {
    const d = newcombeDiff({ wins: 12, total: 30 }, { wins: 12, total: 30 })
    expect(d.diff).toBe(0)
    expect(d.lo).toBeLessThan(0)
    expect(d.hi).toBeGreaterThan(0)
    expect(d.hi).toBeCloseTo(-d.lo, 6)
  })
})

describe('hypergeometricAtLeastOne', () => {
  it('reproduces the three figures the plan quotes for a 40-card deck and 4-card hand', () => {
    expect(DECK_SIZE).toBe(40)
    expect(HAND_SIZE).toBe(4)
    expect(hypergeometricAtLeastOne(3)).toBeCloseTo(27.73, 1)
    expect(hypergeometricAtLeastOne(2)).toBeCloseTo(19.23, 1)
    expect(hypergeometricAtLeastOne(1)).toBeCloseTo(10, 6)
  })

  it('agrees with the combinatorial definition at a size where factorials are still exact', () => {
    // C(6,2)=15 hands of 2 from 6; with 2 copies, C(4,2)=6 miss both: 1 - 6/15 = 60%.
    expect(hypergeometricAtLeastOne(2, 6, 2)).toBeCloseTo(60, 6)
  })

  it('cannot deal a card that is not in the deck', () => {
    expect(hypergeometricAtLeastOne(0)).toBe(0)
    expect(hypergeometricAtLeastOne(-1)).toBe(0)
  })

  it('always deals a card there are not enough other cards to avoid', () => {
    expect(hypergeometricAtLeastOne(DECK_SIZE)).toBe(100)
    expect(hypergeometricAtLeastOne(DECK_SIZE - HAND_SIZE + 1)).toBe(100)
    // Exactly enough non-copies to fill the hand: one hand in C(40,4) misses.
    const edge = hypergeometricAtLeastOne(DECK_SIZE - HAND_SIZE)
    expect(edge).toBeLessThan(100)
    expect(edge).toBeGreaterThan(99.99)
  })

  it('handles a fractional average copy count without producing garbage', () => {
    const between = hypergeometricAtLeastOne(2.5)
    expect(between).toBeGreaterThan(hypergeometricAtLeastOne(2))
    expect(between).toBeLessThan(hypergeometricAtLeastOne(3))
  })

  it('returns a finite number for a degenerate deck or hand', () => {
    expect(hypergeometricAtLeastOne(3, 0, 4)).toBe(0)
    expect(hypergeometricAtLeastOne(3, 40, 0)).toBe(0)
    expect(hypergeometricAtLeastOne(NaN)).toBe(0)
  })
})

describe('binomialTwoSided', () => {
  it('matches hand-computed exact values on small cases', () => {
    // n=10, p=1/2: pmf numerators over 1024 are 1,10,45,120,210,252,... Outcomes
    // no more likely than k=2 (45) are k in {0,1,2,8,9,10}: 2·(1+10+45)/1024.
    expect(binomialTwoSided(2, 10, 50)).toBeCloseTo(112 / 1024, 10)
    // n=4, p=1/4: pmf = .3164, .4219, .2109, .0469, .0039. Seeing zero is less
    // likely than seeing one, so the tail is everything except k=1.
    expect(binomialTwoSided(0, 4, 25)).toBeCloseTo(1 - 0.421875, 10)
    // Seeing all four is the single least likely outcome: (1/4)^4.
    expect(binomialTwoSided(4, 4, 25)).toBeCloseTo(1 / 256, 10)
  })

  it('reads as exactly no evidence when the observation is the most likely outcome', () => {
    expect(binomialTwoSided(5, 10, 50)).toBe(1)
    // 50 matches at 10%: five is the expected count.
    expect(binomialTwoSided(5, 50, 10)).toBe(1)
    expect(binomialTwoSided(25, 100, 25)).toBe(1)
    // A non-integer expectation (13.85) still has a single mode, at 14.
    expect(binomialTwoSided(14, 50, 27.7)).toBe(1)
  })

  it('pins the 1-of at n=50 case that retired the normal approximation', () => {
    // p = 10%, np = 5 - the smallest sample the deal-rate check runs at, for
    // the card count it is most likely to be asked about. The continuity-
    // corrected normal gave 0.034 for "never dealt" and 0.099 for "dealt
    // once" (both too large - the alarm blunted exactly where it first
    // becomes usable) and 0.0095 for "dealt 11 times" (too small). These are
    // the exact tails, computed independently, so a regression to any
    // approximation here shows up as a numeric miss, not a vibe.
    expect(binomialTwoSided(0, 50, 10)).toBeCloseTo(0.0083737, 6)
    expect(binomialTwoSided(1, 50, 10)).toBeCloseTo(0.0583238, 6)
    expect(binomialTwoSided(11, 50, 10)).toBeCloseTo(0.0145084, 6)
    expect(binomialTwoSided(12, 50, 10)).toBeCloseTo(0.0032199, 6)
  })

  it('falls monotonically as the observation moves away from expectation on either side', () => {
    const below = [5, 4, 3, 2, 1, 0].map((k) => binomialTwoSided(k, 50, 10))
    const above = [5, 6, 7, 8, 9, 10, 11, 12].map((k) => binomialTwoSided(k, 50, 10))
    for (const run of [below, above]) {
      for (let i = 1; i < run.length; i++) expect(run[i]).toBeLessThan(run[i - 1])
    }
  })

  it('is small when the observation is far from expectation', () => {
    // A 3-of never seen in 50 hands, against 27.7%.
    expect(binomialTwoSided(0, 50, 27.7)).toBeLessThan(1e-6)
    // Seen in every hand is even less plausible.
    expect(binomialTwoSided(50, 50, 27.7)).toBeLessThan(1e-20)
  })

  it('treats a deviation of one as barely evidence at all', () => {
    expect(binomialTwoSided(13, 50, 27.7)).toBeGreaterThan(0.8)
  })

  it('is symmetric when the distribution is', () => {
    expect(binomialTwoSided(3, 20, 50)).toBeCloseTo(binomialTwoSided(17, 20, 50), 12)
  })

  it('stays finite and bounded at the largest n a single user could plausibly reach', () => {
    const p = binomialTwoSided(2400, 10_000, 25)
    expect(Number.isFinite(p)).toBe(true)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(0.05)
    expect(binomialTwoSided(2500, 10_000, 25)).toBe(1)
  })

  it('returns a probability for every input, including degenerate ones', () => {
    expect(binomialTwoSided(3, 0, 20)).toBe(1)
    expect(binomialTwoSided(0, 50, 0)).toBe(1)
    expect(binomialTwoSided(1, 50, 0)).toBe(0)
    expect(binomialTwoSided(50, 50, 100)).toBe(1)
    expect(binomialTwoSided(NaN, 50, 20)).toBe(1)
    for (const observed of [0, 1, 17, 50]) {
      const p = binomialTwoSided(observed, 50, 27.7)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })
})

describe('shrink', () => {
  it('pulls hard toward zero at tiny n and barely at large n', () => {
    expect(Math.abs(shrink(20, 5, 5))).toBeLessThan(3)
    expect(shrink(20, 5000, 5000)).toBeGreaterThan(19.5)
    expect(shrink(20, 5000, 5000)).toBeLessThan(20)
  })

  it('never crosses zero or overshoots the raw difference', () => {
    for (const [nA, nB] of [
      [1, 1],
      [20, 20],
      [20, 500],
      [50, 50],
      [300, 300]
    ]) {
      const positive = shrink(12, nA, nB)
      expect(positive).toBeGreaterThan(0)
      expect(positive).toBeLessThanOrEqual(12)
      const negative = shrink(-12, nA, nB)
      expect(negative).toBeCloseTo(-positive, 10)
    }
  })

  it('shrinks more as the prior weight grows', () => {
    expect(shrink(10, 50, 50, 200)).toBeLessThan(shrink(10, 50, 50, 40))
    expect(shrink(10, 50, 50, 0)).toBe(10)
  })

  it('is limited by the smaller arm, not the sum', () => {
    // 20 vs 500 has n_eff ≈ 38; treating it as 520 observations would leave
    // almost the whole difference standing.
    const lopsided = shrink(10, 20, 500)
    const balanced = shrink(10, 260, 260)
    expect(lopsided).toBeLessThan(balanced)
    expect(lopsided).toBeCloseTo(
      (10 * (2 / (1 / 20 + 1 / 500))) / (2 / (1 / 20 + 1 / 500) + 40),
      10
    )
  })

  it('returns zero when either arm has nothing in it', () => {
    expect(shrink(15, 0, 40)).toBe(0)
    expect(shrink(15, 40, 0)).toBe(0)
    expect(shrink(15, 0, 0)).toBe(0)
    expect(shrink(NaN, 40, 40)).toBe(0)
  })
})

describe('confidenceFor', () => {
  const { wrShow, wrSort } = OPENING_THRESHOLDS

  it('hides anything below the show threshold', () => {
    expect(confidenceFor(0, 0)).toBe('hidden')
    expect(confidenceFor(wrShow - 1, wrShow - 1)).toBe('hidden')
  })

  it('flips to shown exactly at the show threshold and to sortable exactly at the sort threshold', () => {
    expect(confidenceFor(wrShow, wrShow)).toBe('shown')
    expect(confidenceFor(wrSort - 1, wrSort - 1)).toBe('shown')
    expect(confidenceFor(wrSort, wrSort)).toBe('sortable')
    expect(confidenceFor(wrSort * 10, wrSort * 10)).toBe('sortable')
  })

  it('requires both arms to clear a bar, whichever one is short', () => {
    expect(confidenceFor(wrSort, wrShow - 1)).toBe('hidden')
    expect(confidenceFor(wrShow - 1, wrSort)).toBe('hidden')
    expect(confidenceFor(wrSort, wrShow)).toBe('shown')
    expect(confidenceFor(wrShow, wrSort)).toBe('shown')
    expect(confidenceFor(1000, wrSort - 1)).toBe('shown')
  })

  it('treats a non-finite count as zero', () => {
    expect(confidenceFor(NaN, 100)).toBe('hidden')
  })
})

describe('mean', () => {
  it('is null for nothing, because the average of no hands is not zero', () => {
    expect(mean([])).toBeNull()
  })

  it('averages what it is given', () => {
    expect(mean([2])).toBe(2)
    expect(mean([1, 2, 3, 4])).toBe(2.5)
    expect(mean([0, 0])).toBe(0)
  })

  it('skips non-finite entries rather than poisoning the result', () => {
    expect(mean([1, NaN, 3])).toBe(2)
    expect(mean([NaN, Infinity])).toBeNull()
  })
})

describe('mantelHaenszelDiff', () => {
  it('combines strata rather than pooling their counts', () => {
    // Keeping happens mostly in the cheap-hand stratum and swapping mostly in
    // the expensive one, so the crude gap is enormous and almost all of it is
    // the stratum, not the decision.
    const strata = [
      { aWins: 16, aTotal: 20, bWins: 3, bTotal: 4 },
      { aWins: 1, aTotal: 4, bWins: 4, bTotal: 20 }
    ]
    const crude = ((16 + 1) / 24 - (3 + 4) / 24) * 100
    const mh = mantelHaenszelDiff(strata)
    expect(crude).toBeCloseTo(41.67, 1)
    expect(mh?.diff).toBeCloseTo(5, 1)
    expect(mh!.lo).toBeLessThan(mh!.diff)
    expect(mh!.hi).toBeGreaterThan(mh!.diff)
  })

  it('refuses to answer when no stratum has both arms', () => {
    expect(mantelHaenszelDiff([{ aWins: 3, aTotal: 5, bWins: 0, bTotal: 0 }])).toBeNull()
    expect(mantelHaenszelDiff([])).toBeNull()
  })

  it('does not claim certainty when every game in a stratum went the same way', () => {
    // Sixteen wins kept against sixteen losses swapped. The uncorrected
    // Greenland-Robins variance is exactly zero here, which would draw a
    // zero-width interval on the most dramatic row of the page.
    const mh = mantelHaenszelDiff([{ aWins: 16, aTotal: 16, bWins: 0, bTotal: 16 }])
    expect(mh?.diff).toBeCloseTo(100, 5)
    expect(mh!.hi - mh!.lo).toBeGreaterThan(1)
    expect(mh!.lo).toBeLessThan(100)
  })

  it('keeps the point estimate exactly where the uncorrected one was', () => {
    // The correction touches the variance only, so a risk of one stays one.
    const mh = mantelHaenszelDiff([{ aWins: 10, aTotal: 10, bWins: 0, bTotal: 10 }])
    expect(mh?.diff).toBeCloseTo(100, 5)
  })
})
