/**
 * Sample-size honesty for the win-rate chart.
 *
 * One win in one game and 31 wins in 60 both render as a bar with a percentage
 * on it, and the first one is the wider bar. Nothing on screen said which
 * number you could act on. These helpers give the chart the two things it
 * needs: an interval that widens as the sample shrinks, and a threshold below
 * which a row is drawn as provisional.
 */

/** Below this many games a row is drawn as provisional. */
export const LOW_SAMPLE_THRESHOLD = 10

export type Interval = { low: number; high: number }

/**
 * Wilson score interval, in percent.
 *
 * Chosen over the textbook normal approximation because the samples here are
 * small and often land on the boundary: at 1/1 the normal interval collapses to
 * 100%-100%, claiming certainty from a single game, while Wilson returns a band
 * that visibly covers most of the range.
 *
 * `z` defaults to 1.96 (95%).
 */
export function wilsonInterval(wins: number, total: number, z = 1.96): Interval {
  if (!Number.isFinite(total) || total <= 0) return { low: 0, high: 100 }

  const clampedWins = Math.min(Math.max(wins, 0), total)
  const p = clampedWins / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))

  const low = (centre - margin) / denominator
  const high = (centre + margin) / denominator

  return {
    low: Math.max(0, low * 100),
    high: Math.min(100, high * 100)
  }
}

export function isLowSample(total: number): boolean {
  return total > 0 && total < LOW_SAMPLE_THRESHOLD
}

/** `52.3% (31/60) · 95% CI 39.6-64.7%`, or a plain marker when there is no data. */
export function formatWithInterval(wins: number, total: number): string {
  if (!total) return '尚無資料'
  const rate = (wins / total) * 100
  const { low, high } = wilsonInterval(wins, total)
  return `${rate.toFixed(1)}% (${wins}/${total}) · 95% CI ${low.toFixed(1)}–${high.toFixed(1)}%`
}
