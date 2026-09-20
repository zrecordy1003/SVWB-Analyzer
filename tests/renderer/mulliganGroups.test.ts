/**
 * `groupByVerdict` — which tier a card lands in, and what the column can show
 * when it can show nothing firm.
 *
 * The tiers are the whole user-facing contract of the 換牌建議 column, and the
 * one that needs pinning is `leaning`: a card with a real comparison whose
 * interval still crosses zero used to be folded in with the sample-starved
 * cards behind a closed disclosure, which is how a column ended up showing a
 * paragraph and no cards. It is now its own visible group, and the regression
 * to guard against is it silently going back.
 */
import { describe, expect, it } from 'vitest'

import type { KeepAdvice } from '../../src/shared/openingStats'
import { groupByVerdict, keepRateOf } from '../../src/renderer/src/components/Opening/mulliganState'

let nextId = 1

/** A card with both arms well past the display threshold, so only the interval decides. */
function advice(over: Partial<KeepAdvice> = {}): KeepAdvice {
  return {
    cardId: nextId++,
    name: `卡 ${nextId}`,
    cost: 3,
    bannerHash: null,
    imageHash: null,
    dealt: 80,
    kept: 40,
    keptRate: null,
    swappedRate: null,
    diff: 0,
    diffLo: -5,
    diffHi: 5,
    confidence: 'shown',
    basis: 'stratified',
    bands: [],
    missing: null,
    ...over
  } as KeepAdvice
}

const result = (cards: KeepAdvice[]): Parameters<typeof groupByVerdict>[0] =>
  ({ matches: 200, baseline: null, cards }) as never

describe('groupByVerdict', () => {
  it('puts a straddling interval in `leaning`, not out of sight', () => {
    const g = groupByVerdict(result([advice({ diff: 6, diffLo: -1, diffHi: 13 })]), true)
    expect(g.leaning).toHaveLength(1)
    expect(g.keep).toHaveLength(0)
    expect(g.unknown).toHaveLength(0)
  })

  it('still reserves a verdict for an interval clear of zero', () => {
    const g = groupByVerdict(result([advice({ diff: 20, diffLo: 12, diffHi: 28 })]), true)
    expect(g.keep).toHaveLength(1)
    expect(g.leaning).toHaveLength(0)
  })

  it('keeps a card with no estimate in `unknown`', () => {
    const g = groupByVerdict(
      result([advice({ dealt: 6, kept: 5, diff: null, diffLo: null, diffHi: null, confidence: 'hidden' })]),
      true
    )
    expect(g.unknown).toHaveLength(1)
    expect(g.leaning).toHaveLength(0)
  })

  it('ranks leanings by effect size, strongest first — it is read as a ranking', () => {
    const g = groupByVerdict(
      result([
        advice({ name: '小', diff: 2, diffLo: -9, diffHi: 13 }),
        advice({ name: '大', diff: 11, diffLo: -1, diffHi: 23 }),
        advice({ name: '負', diff: -7, diffLo: -18, diffHi: 4 })
      ]),
      true
    )
    expect(g.leaning.map((a) => a.name)).toEqual(['大', '負', '小'])
  })

  it('a pooled-away direction is still filed as 不分對手, not as a leaning', () => {
    const g = groupByVerdict(
      result([advice({ diff: 20, diffLo: 12, diffHi: 28, basis: 'all-opponents' })]),
      true
    )
    expect(g.general).toHaveLength(1)
    expect(g.keep).toHaveLength(0)
    expect(g.leaning).toHaveLength(0)
  })

  it('quarantines a pooled LEANING too, not only a pooled verdict', () => {
    // The rule used to cover verdicts only, because nothing else printed a
    // direction. A leaning prints 偏留 under a column headed by a class, so
    // evidence that pooled that class away is making the same misattribution
    // in smaller type — and a thin matchup is exactly where the ladder widens.
    const g = groupByVerdict(
      result([advice({ diff: 6, diffLo: -1, diffHi: 13, basis: 'all-opponents' })]),
      true
    )
    expect(g.general).toHaveLength(1)
    expect(g.leaning).toHaveLength(0)
    // And the caller can still tell it apart from a quarantined verdict.
    expect(g.verdicts.get(g.general[0].cardId)).toBe('unclear')
  })

  it('does not quarantine anything when no opponent was chosen', () => {
    const g = groupByVerdict(
      result([advice({ diff: 6, diffLo: -1, diffHi: 13, basis: 'all-opponents' })]),
      false
    )
    expect(g.leaning).toHaveLength(1)
    expect(g.general).toHaveLength(0)
  })

  it('every card lands in exactly one tier', () => {
    const cards = [
      advice({ diff: 20, diffLo: 12, diffHi: 28 }),
      advice({ diff: 6, diffLo: -1, diffHi: 13 }),
      advice({ dealt: 4, kept: 4, diff: null, diffLo: null, diffHi: null, confidence: 'hidden' })
    ]
    const g = groupByVerdict(result(cards), true)
    const total = g.keep.length + g.toss.length + g.general.length + g.leaning.length + g.unknown.length
    expect(total).toBe(cards.length)
  })
})

describe('keepRateOf', () => {
  it('is a count of what the player did, defined at any n', () => {
    expect(keepRateOf(advice({ dealt: 4, kept: 3 }))).toBeCloseTo(75)
  })

  it('is null when the card was never dealt, rather than 0%', () => {
    expect(keepRateOf(advice({ dealt: 0, kept: 0 }))).toBeNull()
  })
})
