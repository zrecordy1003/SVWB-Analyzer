import type { ClassName, GameMode } from '@shared/domain'
import type { RangeKey } from '@shared/types'

// CR 的邊界與夾取和對局列表共用一份，這裡只是把它們接回本模組原本的出口，
// 讓既有的 import 位置不用跟著搬家。
import { CR_MAX_BOUND, CR_MIN_BOUND, clampCr } from '../Common/filters/crBounds'
import { RANGE_LABELS, rangeChipLabel } from '../Common/filters/rangeLabels'
import {
  deckSelectionChipLabel,
  emptyDeckSelection,
  resolveDeckSelection,
  type DeckSelection
} from '../Common/filters/deckSelection'
import type { DeckFamily, VersionLike } from '../DeckCards/deckVersions'

export { CR_MAX_BOUND, CR_MIN_BOUND, clampCr, RANGE_LABELS }

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
  /** The N most recent matches to count, or `null` for every match. */
  matchLimit: number | null
  rangeKey: RangeKey
  startDate: Date | null
  endDate: Date | null
  /**
   * Whole decks and single versions, kept apart until the query is built -
   * see `deckSelection.ts`. Resolved to concrete deck row ids in
   * `buildQueryParams`, so main never sees the two levels.
   */
  decks: DeckSelection
  tagIds: number[]
  crEnabled: boolean
  crMin: number
  crMax: number
  /** Whether class and mode track the battle the user is actually playing. */
  followBattle: boolean
}

/**
 * Fewer than twenty matches is noise rather than a trend, so the floor is a
 * real guard and not a UI nicety: a custom "3 games" would read as a winrate.
 */
export const MATCH_LIMIT_MIN = 20
export const MATCH_LIMIT_MAX = 9999
export const MATCH_LIMIT_PRESETS: readonly number[] = [20, 50, 100, 200]

const RANGE_KEYS: readonly RangeKey[] = ['today', '7d', '30d', 'all', 'custom']

/** The settings keys this module owns, in the order they are written. */
export const SETTINGS_KEYS = {
  myClass: 'analyzer.myClass',
  gameMode: 'analyzer.gameMode',
  matchLimit: 'analyzer.matchLimit',
  rangeKey: 'analyzer.rangeKey',
  startDate: 'analyzer.startDate',
  endDate: 'analyzer.endDate',
  /** Single versions, by deck row id. */
  deckIds: 'analyzer.deckIds',
  /** Whole decks, by family id. */
  familyIds: 'analyzer.familyIds',
  tagIds: 'analyzer.tagIds',
  crEnabled: 'analyzer.crEnabled',
  crMin: 'analyzer.crMin',
  crMax: 'analyzer.crMax',
  followBattle: 'analyzer.followBattle'
} as const

export function defaultFilters(): AnalyzerFilters {
  const today = new Date()
  return {
    myClass: 'elf' as ClassName,
    gameMode: 'ranked' as GameMode,
    matchLimit: 100,
    rangeKey: '7d',
    startDate: today,
    endDate: today,
    decks: emptyDeckSelection(),
    tagIds: [],
    crEnabled: false,
    crMin: 1650,
    crMax: 1850,
    followBattle: true
  }
}

/** Allow-lists are injected rather than imported, so this module stays free of
 *  the renderer's MUI-laden class map and can be exercised in a plain test. */
export type FilterVocabulary = {
  classIds: readonly string[]
  modeIds: readonly string[]
}

/**
 * Read one settings key out of whatever `settings:getAll` handed back.
 *
 * The store treats a dot as a PATH, not as part of the name: writing
 * `analyzer.matchLimit` produces `{ analyzer: { matchLimit: … } }`. Reading the
 * flat string back off that object therefore found nothing, and every filter
 * silently fell back to its default on every launch - the settings were being
 * written correctly and never restored.
 *
 * Both shapes are accepted: a flat key wins if it exists (older stores, and
 * anything written without going through the store's path handling), otherwise
 * the dotted name is walked as a path.
 */
export function readSetting(raw: Record<string, unknown>, key: string): unknown {
  if (key in raw) return raw[key]

  let cursor: unknown = raw
  for (const segment of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** Whether the key is present at all - `null` is a stored value, not a gap. */
export function hasSetting(raw: Record<string, unknown>, key: string): boolean {
  if (key in raw) return true

  const segments = key.split('.')
  let cursor: unknown = raw
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor !== 'object' || cursor === null) return false
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return typeof cursor === 'object' && cursor !== null && segments[segments.length - 1] in cursor
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

  const myClass = readSetting(raw, SETTINGS_KEYS.myClass)
  if (typeof myClass === 'string' && vocab.classIds.includes(myClass)) {
    base.myClass = myClass as ClassName
  }

  const gameMode = readSetting(raw, SETTINGS_KEYS.gameMode)
  if (typeof gameMode === 'string' && (gameMode === 'all' || vocab.modeIds.includes(gameMode))) {
    base.gameMode = gameMode as ModeFilter
  }

  // `null` is a value here - "no cap" - so a stored null must survive, while a
  // missing key falls back to the default.
  if (hasSetting(raw, SETTINGS_KEYS.matchLimit)) {
    const matchLimit = readSetting(raw, SETTINGS_KEYS.matchLimit)
    if (matchLimit === null) {
      base.matchLimit = null
    } else if (typeof matchLimit === 'number' && Number.isFinite(matchLimit)) {
      base.matchLimit = clampMatchLimit(matchLimit)
    }
  }

  const rangeKey = readSetting(raw, SETTINGS_KEYS.rangeKey)
  if (typeof rangeKey === 'string' && (RANGE_KEYS as readonly string[]).includes(rangeKey)) {
    base.rangeKey = rangeKey as RangeKey
  }

  const start = asDate(readSetting(raw, SETTINGS_KEYS.startDate))
  if (start) base.startDate = start
  const end = asDate(readSetting(raw, SETTINGS_KEYS.endDate))
  if (end) base.endDate = end

  const deckIds = asNumberArray(readSetting(raw, SETTINGS_KEYS.deckIds)) ?? []
  const familyIds = asNumberArray(readSetting(raw, SETTINGS_KEYS.familyIds))
  if (familyIds) {
    base.decks = { familyIds, deckIds }
  } else if (readSetting(raw, 'analyzer.deckScope') === 'deck') {
    // Written by the build that had a whole-deck / single-version switch, set
    // to single version: those ids were versions and still are.
    base.decks = { familyIds: [], deckIds }
  } else {
    // Older still, or the switch at its default: a picked id meant "this deck,
    // every version". It was the current version's id, not the family's; the
    // component's pruning pass maps it onto its family once decks are loaded.
    base.decks = { familyIds: deckIds, deckIds: [] }
  }
  const tagIds = asNumberArray(readSetting(raw, SETTINGS_KEYS.tagIds))
  if (tagIds) base.tagIds = tagIds

  const crEnabled = readSetting(raw, SETTINGS_KEYS.crEnabled)
  if (typeof crEnabled === 'boolean') base.crEnabled = crEnabled

  const followBattle = readSetting(raw, SETTINGS_KEYS.followBattle)
  if (typeof followBattle === 'boolean') base.followBattle = followBattle

  const crMin = readSetting(raw, SETTINGS_KEYS.crMin)
  const crMax = readSetting(raw, SETTINGS_KEYS.crMax)
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

export function clampMatchLimit(value: number): number {
  return Math.min(MATCH_LIMIT_MAX, Math.max(MATCH_LIMIT_MIN, Math.round(value)))
}

/** Flatten filter state into the settings record it is stored as. */
export function toSettingsRecord(filters: AnalyzerFilters): Record<string, unknown> {
  return {
    [SETTINGS_KEYS.myClass]: filters.myClass,
    [SETTINGS_KEYS.gameMode]: filters.gameMode,
    [SETTINGS_KEYS.matchLimit]: filters.matchLimit,
    [SETTINGS_KEYS.rangeKey]: filters.rangeKey,
    [SETTINGS_KEYS.startDate]: filters.startDate ? filters.startDate.toISOString() : null,
    [SETTINGS_KEYS.endDate]: filters.endDate ? filters.endDate.toISOString() : null,
    [SETTINGS_KEYS.deckIds]: filters.decks.deckIds,
    [SETTINGS_KEYS.familyIds]: filters.decks.familyIds,
    [SETTINGS_KEYS.tagIds]: filters.tagIds,
    [SETTINGS_KEYS.crEnabled]: filters.crEnabled,
    [SETTINGS_KEYS.crMin]: filters.crMin,
    [SETTINGS_KEYS.crMax]: filters.crMax,
    [SETTINGS_KEYS.followBattle]: filters.followBattle
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

/** The advanced panel's conditions, one clearable unit each. */
export type AdvancedFilterKey = 'range' | 'decks' | 'tags' | 'cr'

export type AdvancedFilterChip = { key: AdvancedFilterKey; label: string }

/**
 * What the closed drawer is currently doing to the query.
 *
 * Without this, a date range or a deck filter restored from the last session
 * silently narrows every query from behind a closed drawer - the same class of
 * invisible-filter bug the deck/tag pruning exists to prevent. Each chip is
 * clearable on its own, so the toolbar can undo one condition without opening
 * the drawer at all.
 */
export function advancedFilterChips(filters: AnalyzerFilters): AdvancedFilterChip[] {
  const chips: AdvancedFilterChip[] = []

  const rangeLabel = rangeChipLabel(filters.rangeKey, filters.startDate, filters.endDate)
  if (rangeLabel) chips.push({ key: 'range', label: rangeLabel })

  const deckLabel = deckSelectionChipLabel(filters.decks)
  if (deckLabel) chips.push({ key: 'decks', label: deckLabel })
  if (filters.tagIds.length) chips.push({ key: 'tags', label: `${filters.tagIds.length} 個標籤` })
  if (filters.crEnabled) chips.push({ key: 'cr', label: `CR ${filters.crMin}–${filters.crMax}` })

  return chips
}

/**
 * The patch that switches one advanced condition off.
 *
 * Clearing the range means 生涯 rather than the default 7 天內: the user asked
 * for "stop narrowing this", and dropping them back onto another date window
 * would leave the chip on screen after they clicked it away.
 */
export function clearAdvancedFilter(key: AdvancedFilterKey): Partial<AnalyzerFilters> {
  switch (key) {
    case 'range':
      return { rangeKey: 'all' }
    case 'decks':
      return { decks: emptyDeckSelection() }
    case 'tags':
      return { tagIds: [] }
    case 'cr':
      return { crEnabled: false }
  }
}

/** What each condition is called wherever it is offered or named. */
export const ADVANCED_FILTER_LABELS: Record<AdvancedFilterKey, string> = {
  range: '時間區間',
  decks: '牌組',
  tags: '標籤',
  cr: 'CR 區間'
}

/**
 * The patch that switches one advanced condition on from nothing.
 *
 * `decks` and `tags` get an empty patch on purpose: they are "on" only once
 * something is picked, so turning them on is the act of opening their editor.
 * The range defaults to 7 天 rather than 今天 - a day's matches is usually too
 * few to read anything from, which is why it is also the filters' default.
 */
export function enableAdvancedFilter(key: AdvancedFilterKey): Partial<AnalyzerFilters> {
  switch (key) {
    case 'range':
      return { rangeKey: '7d' }
    case 'cr':
      return { crEnabled: true }
    default:
      return {}
  }
}

/** Every advanced condition off at once. */
export function clearAllAdvancedFilters(): Partial<AnalyzerFilters> {
  return { rangeKey: 'all', decks: emptyDeckSelection(), tagIds: [], crEnabled: false }
}

/** What a battle - live or just recorded - says about class and mode. */
export type BattleSignal = {
  ownClass?: string | null
  mode?: string | null
}

/**
 * The filter patch a battle implies, or null when it says nothing usable.
 *
 * Both fields are optional on purpose. A ranked battle carries no mode until
 * its result screen, so a null mode means "not known yet" and must never be
 * read as "all modes" - the class switches now and the mode follows when the
 * match is recorded. `unknown` is the recognition-failure bucket rather than a
 * mode anyone played, and the picker cannot even represent it, so it is
 * dropped rather than followed.
 */
export function followBattlePatch(
  signal: BattleSignal,
  vocab: FilterVocabulary
): Partial<AnalyzerFilters> | null {
  const patch: Partial<AnalyzerFilters> = {}

  const ownClass = signal.ownClass
  if (typeof ownClass === 'string' && vocab.classIds.includes(ownClass)) {
    patch.myClass = ownClass as ClassName
  }

  const mode = signal.mode
  if (typeof mode === 'string' && mode !== 'unknown' && vocab.modeIds.includes(mode)) {
    patch.gameMode = mode as ModeFilter
  }

  return Object.keys(patch).length ? patch : null
}

export type WinrateQueryParams = {
  myClass: ClassName
  gameMode: ModeFilter
  /** Concrete deck row ids - families already expanded. Always paired with `'deck'`. */
  myDeckIds: number[]
  myDeckScope: 'deck'
  tagIds: number[]
  rangeKey?: RangeKey
  start?: Date
  end?: Date
  crMin?: number
  crMax?: number
  limit?: number
}

/**
 * Filter state -> the exact argument object `getRankedWinrate` expects.
 *
 * `families` is what the deck picks resolve against (a whole deck -> every
 * version's id). A caller whose decks have not loaded yet should wait rather
 * than call this: an unresolvable pick comes out as an empty list, and an empty
 * list reads as "every deck".
 */
export function buildQueryParams(
  filters: AnalyzerFilters,
  families: readonly DeckFamily<VersionLike>[] = []
): WinrateQueryParams {
  const params: WinrateQueryParams = {
    myClass: filters.myClass,
    gameMode: filters.gameMode,
    myDeckIds: resolveDeckSelection(filters.decks, families),
    myDeckScope: 'deck',
    tagIds: filters.tagIds
  }

  if (filters.rangeKey === 'custom') {
    if (filters.startDate) params.start = filters.startDate
    if (filters.endDate) params.end = filters.endDate
  } else {
    params.rangeKey = filters.rangeKey
  }

  if (filters.matchLimit !== null) {
    params.limit = filters.matchLimit
  }

  if (filters.crEnabled) {
    params.crMin = filters.crMin
    params.crMax = filters.crMax
  }

  return params
}
