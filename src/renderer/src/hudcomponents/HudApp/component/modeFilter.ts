import type { GameMode } from '@shared/domain'
import { modes } from '@renderer/map/classMap'

/**
 * Game mode the whole HUD is scoped to - the recent list, the win/loss tally
 * and, mid-battle, the matchup win rate. `'all'` means no filter, which is the
 * default: a player who only ever queues one mode should not have to configure
 * anything, and one who mixes modes gets an honest overall picture until they
 * ask for something narrower.
 *
 * Exported from a plain module so both the control and its consumers can import
 * these without tripping Fast Refresh's component-only-exports rule.
 */
export type ModeFilter = GameMode | 'all'

export const DEFAULT_MODE_FILTER: ModeFilter = 'all'

export const MODE_FILTER_OPTIONS: { value: ModeFilter; label: string }[] = [
  { value: 'all', label: '全部模式' },
  ...modes.map((mode) => ({ value: mode.id as GameMode, label: mode.label }))
]

export function isModeFilter(value: unknown): value is ModeFilter {
  return MODE_FILTER_OPTIONS.some((option) => option.value === value)
}

export function modeFilterLabel(value: ModeFilter): string {
  return MODE_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? '全部模式'
}
