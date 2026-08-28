/**
 * How many recent matches the HUD's statistics are computed over.
 *
 * Kept separate from the number of rows the list draws: the donut wants a
 * sample big enough to mean something, while the list is a glance at the last
 * few results and stays short so the window never has to scroll.
 *
 * Exported from a plain module so both the control and its consumers can
 * import these without tripping Fast Refresh's component-only-exports rule.
 */
export const RECENT_COUNT_OPTIONS = [10, 15, 20, 30] as const

export type RecentCount = (typeof RECENT_COUNT_OPTIONS)[number]

export const DEFAULT_RECENT_COUNT: RecentCount = 10

/** Rows the list itself shows, whatever the statistics sample is set to. */
export const VISIBLE_MATCH_ROWS = 5

export function isRecentCount(value: unknown): value is RecentCount {
  return RECENT_COUNT_OPTIONS.includes(value as RecentCount)
}
