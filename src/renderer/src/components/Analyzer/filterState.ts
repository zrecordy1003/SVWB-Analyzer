import type { ClassName, GameMode } from '@shared/domain'
import type { RangeKey } from '@shared/types'

/**
 * The analyzer's filter state, and the pure transforms around it.
 *
 * These live outside the component on purpose. The bugs they replace were all
 * ordering bugs - a hydration gate that never opened, a persist pass that fired
 * ten times per keystroke, or an inverted CR range sent to the query -
 * and ordering bugs are only testable if the logic is separable from rendering.
 */

/** `'all'` drops the mode filter; the backend already understands it. */
export type ModeFilter = GameMode | 'all'

export type AnalyzerFilters = {
  myClass: ClassName
  gameMode: ModeFilter
  rangeKey: RangeKey
  startDate: Date | null
  endDate: Date | null
  deckIds: number[]
  tagIds: number[]
  crEnabled: boolean
  crMin: number
  crMax: number
}

export const CR_MIN_BOUND = 0
export const CR_MAX_BOUND = 3000

const RANGE_KEYS: readonly RangeKey[] = ['today', '7d', '30d', 'all', 'custom']

/** The settings keys this module owns, in the order they are written. */
export const SETTINGS_KEYS = {
  myClass: 'analyzer.myClass',
  gameMode: 'analyzer.gameMode',
  rangeKey: 'analyzer.rangeKey',
  startDate: 'analyzer.startDate',
  endDate: 'analyzer.endDate',
  deckIds: 'analyzer.deckIds',
  tagIds: 'analyzer.tagIds',
  crEnabled: 'analyzer.crEnabled',
  crMin: 'analyzer.crMin',
  crMax: 'analyzer.crMax'
} as const

export function defaultFilters(): AnalyzerFilters {
  const today = new Date()
  return {
    myClass: 'elf' as ClassName,
    gameMode: 'ranked' as GameMode,
    rangeKey: 'today',
    startDate: today,
    endDate: today,
    deckIds: [],
    tagIds: [],
    crEnabled: false,
    crMin: 1650,
    crMax: 1850
  }
}

/** Allow-lists are injected rather than imported, so this module stays free of
 *  the renderer's MUI-laden class map and can be exercised in a plain test. */
export type FilterVocabulary = {
  classIds: readonly string[]
  modeIds: readonly string[]
}

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

/**
 * Rebuild filter state from whatever `settings.getAll()` returned.
 *
 * Every field falls back independently: a settings file written by an older
 * version - or one holding a mode that no longer exists - must still yield a
 * usable state rather than poisoning the whole restore.
 */
export function hydrateFilters(
  raw: Record<string, unknown> | null | undefined,
  vocab: FilterVocabulary
): AnalyzerFilters {
  const base = defaultFilters()
  if (!raw) return base

  const myClass = raw[SETTINGS_KEYS.myClass]
  if (typeof myClass === 'string' && vocab.classIds.includes(myClass)) {
    base.myClass = myClass as ClassName
  }

  const gameMode = raw[SETTINGS_KEYS.gameMode]
  if (typeof gameMode === 'string' && (gameMode === 'all' || vocab.modeIds.includes(gameMode))) {
    base.gameMode = gameMode as ModeFilter
  }

  const rangeKey = raw[SETTINGS_KEYS.rangeKey]
  if (typeof rangeKey === 'string' && (RANGE_KEYS as readonly string[]).includes(rangeKey)) {
    base.rangeKey = rangeKey as RangeKey
  }

  const start = asDate(raw[SETTINGS_KEYS.startDate])
  if (start) base.startDate = start
  const end = asDate(raw[SETTINGS_KEYS.endDate])
  if (end) base.endDate = end

  const deckIds = asNumberArray(raw[SETTINGS_KEYS.deckIds])
  if (deckIds) base.deckIds = deckIds
  const tagIds = asNumberArray(raw[SETTINGS_KEYS.tagIds])
  if (tagIds) base.tagIds = tagIds

  const crEnabled = raw[SETTINGS_KEYS.crEnabled]
  if (typeof crEnabled === 'boolean') base.crEnabled = crEnabled

  const crMin = raw[SETTINGS_KEYS.crMin]
  const crMax = raw[SETTINGS_KEYS.crMax]
  if (typeof crMin === 'number' && Number.isFinite(crMin)) {
    base.crMin = clampCr(crMin)
  }
  if (typeof crMax === 'number' && Number.isFinite(crMax)) {
    base.crMax = clampCr(crMax)
  }
  // A stored pair could be inverted if it was written by a version that let the
  // number fields cross. Normalise rather than passing `min > max` to the query.
  if (base.crMin > base.crMax) {
    const lo = Math.min(base.crMin, base.crMax)
    const hi = Math.max(base.crMin, base.crMax)
    base.crMin = lo
    base.crMax = hi
  }

  return base
}

export function clampCr(value: number): number {
  return Math.min(CR_MAX_BOUND, Math.max(CR_MIN_BOUND, Math.round(value)))
}

/** Flatten filter state into the settings record it is stored as. */
export function toSettingsRecord(filters: AnalyzerFilters): Record<string, unknown> {
  return {
    [SETTINGS_KEYS.myClass]: filters.myClass,
    [SETTINGS_KEYS.gameMode]: filters.gameMode,
    [SETTINGS_KEYS.rangeKey]: filters.rangeKey,
    [SETTINGS_KEYS.startDate]: filters.startDate ? filters.startDate.toISOString() : null,
    [SETTINGS_KEYS.endDate]: filters.endDate ? filters.endDate.toISOString() : null,
    [SETTINGS_KEYS.deckIds]: filters.deckIds,
    [SETTINGS_KEYS.tagIds]: filters.tagIds,
    [SETTINGS_KEYS.crEnabled]: filters.crEnabled,
    [SETTINGS_KEYS.crMin]: filters.crMin,
    [SETTINGS_KEYS.crMax]: filters.crMax
  }
}

/**
 * The keys that actually changed, or null when nothing did. Feeding this to
 * `settings.setMany` keeps an unrelated re-render from rewriting all ten.
 */
export function diffPersistPatch(
  prev: AnalyzerFilters | null,
  next: AnalyzerFilters
): Record<string, unknown> | null {
  const nextRecord = toSettingsRecord(next)
  if (!prev) return nextRecord

  const prevRecord = toSettingsRecord(prev)
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(nextRecord)) {
    const before = prevRecord[key]
    const changed = Array.isArray(value)
      ? !Array.isArray(before) ||
        before.length !== value.length ||
        value.some((v, i) => v !== (before as unknown[])[i])
      : before !== value
    if (changed) patch[key] = value
  }
  return Object.keys(patch).length ? patch : null
}

export type WinrateQueryParams = {
  myClass: ClassName
  gameMode: ModeFilter
  myDeckIds: number[]
  tagIds: number[]
  rangeKey?: RangeKey
  start?: Date
  end?: Date
  crMin?: number
  crMax?: number
}

/** Filter state -> the exact argument object `getRankedWinrate` expects. */
export function buildQueryParams(filters: AnalyzerFilters): WinrateQueryParams {
  const params: WinrateQueryParams = {
    myClass: filters.myClass,
    gameMode: filters.gameMode,
    myDeckIds: filters.deckIds,
    tagIds: filters.tagIds
  }

  if (filters.rangeKey === 'custom') {
    if (filters.startDate) params.start = filters.startDate
    if (filters.endDate) params.end = filters.endDate
  } else {
    params.rangeKey = filters.rangeKey
  }

  if (filters.crEnabled) {
    params.crMin = filters.crMin
    params.crMax = filters.crMax
  }

  return params
}
