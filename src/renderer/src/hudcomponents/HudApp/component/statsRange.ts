/**
 * How far back the HUD's matchup stats look. `null` means every recorded match.
 *
 * Kept out of the control component so both it and its consumers can import
 * these without tripping Fast Refresh's component-only-exports rule.
 */
export type StatsRange = number | null

export const DEFAULT_STATS_DAYS = 7

export function describeRange(days: StatsRange): string {
  return days == null ? '全部紀錄' : `近 ${days} 天`
}
