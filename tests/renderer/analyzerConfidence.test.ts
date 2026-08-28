import { describe, expect, it } from 'vitest'
import {
  LOW_SAMPLE_THRESHOLD,
  formatWithInterval,
  isLowSample,
  wilsonInterval
} from '../../src/renderer/src/components/Analyzer/confidence'

describe('wilsonInterval', () => {
  it('does not claim certainty from a single game', () => {
    // The whole point of choosing Wilson over the normal approximation: at 1/1
    // the latter collapses to 100%-100%.
    const { low, high } = wilsonInterval(1, 1)
    expect(low).toBeCloseTo(20.65, 1)
    expect(high).toBeCloseTo(100, 5)
  })

  it('matches the published interval for a coin-flip sample', () => {
    const { low, high } = wilsonInterval(50, 100)
    expect(low).toBeCloseTo(40.38, 1)
    expect(high).toBeCloseTo(59.62, 1)
  })

  it('narrows as the sample grows', () => {
    const width = (wins: number, total: number): number => {
      const { low, high } = wilsonInterval(wins, total)
      return high - low
    }
    expect(width(5, 10)).toBeGreaterThan(width(50, 100))
    expect(width(50, 100)).toBeGreaterThan(width(500, 1000))
  })

  it('stays inside 0-100 at the boundaries', () => {
    for (const [wins, total] of [
      [0, 5],
      [5, 5],
      [0, 1],
      [200, 200]
    ]) {
      const { low, high } = wilsonInterval(wins, total)
      expect(low).toBeGreaterThanOrEqual(0)
      expect(high).toBeLessThanOrEqual(100)
      expect(low).toBeLessThanOrEqual(high)
    }
  })

  it('returns the full range rather than NaN when there is no sample', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 100 })
    expect(wilsonInterval(3, 0)).toEqual({ low: 0, high: 100 })
  })

  it('ignores a win count that exceeds the total', () => {
    expect(wilsonInterval(12, 10)).toEqual(wilsonInterval(10, 10))
  })
})

describe('isLowSample', () => {
  it('flags a non-empty sample under the threshold', () => {
    expect(isLowSample(1)).toBe(true)
    expect(isLowSample(LOW_SAMPLE_THRESHOLD - 1)).toBe(true)
  })

  it('does not flag an empty row or a sufficient one', () => {
    // An empty row is drawn as "尚無對戰", not as an unreliable win rate.
    expect(isLowSample(0)).toBe(false)
    expect(isLowSample(LOW_SAMPLE_THRESHOLD)).toBe(false)
    expect(isLowSample(60)).toBe(false)
  })
})

describe('formatWithInterval', () => {
  it('reports the rate, the tally and the interval', () => {
    expect(formatWithInterval(31, 60)).toBe('51.7% (31/60) · 95% CI 39.3–63.8%')
  })

  it('says so plainly when there is nothing to summarise', () => {
    expect(formatWithInterval(0, 0)).toBe('尚無資料')
  })
})
