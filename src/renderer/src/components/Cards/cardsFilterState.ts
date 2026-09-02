/**
 * The 卡片 page's filter state, and the pure transforms around it.
 *
 * Kept out of the component for the same reason the analyzer's `filterState.ts`
 * is: hydration order, persistence diffs and "which rows survive the sample
 * line" are the parts that go wrong, and they are only testable when they do
 * not need a DOM. No MUI, no IPC, no class map - vocabularies are injected.
 *
 * What the page answers (docs/card-stats-research.md, section 3): "which of my
 * decks and versions carried this card, and how did those decks do". So the
 * numbers here are deck records cut along the card axis. Two numbers per card,
 * always both: the record with the card, and that record against the same
 * class's decks without it. Cards under the sample line are hidden by default
 * and shown greyed on request - the one switch this page has.
 */
import type { ClassName, GameMode } from '@shared/domain'
import type { RangeKey } from '@shared/types'
// Relative rather than aliased, like `filterState.ts`: vitest has no alias
// map, and this module is meant to run in a plain node test.
import {
  CARD_STATS_LOW_SAMPLE,
  type CardStat,
  type CardStatsQuery,
  type CardStatsResult
} from '../../../../shared/cardStats'

import { readSetting } from '../Analyzer/filterState'
import {
  deckSelectionChipLabel,
  emptyDeckSelection,
  resolveDeckSelection,
  type DeckSelection
} from '../Common/filters/deckSelection'
import { rangeChipLabel } from '../Common/filters/rangeLabels'
import type { DeckFamily, VersionLike } from '../DeckCards/deckVersions'

export type ClassFilter = ClassName | 'all'
export type ModeFilter = GameMode | 'all'

export type CardsFilters = {
  myClass: ClassFilter
  gameMode: ModeFilter
  rangeKey: RangeKey
  startDate: Date | null
  endDate: Date | null
  /** Whole decks and single versions; resolved to deck row ids in `buildCardsQuery`. */
  decks: DeckSelection
}

/**
 * Persisted keys. The date range is deliberately absent: a window picked for
 * one question should not quietly narrow next week's, and 牌組戰績 makes the
 * same choice. So is the low-sample switch - it is "let me peek", not a preference.
 */
export const CARDS_SETTINGS_KEYS = {
  myClass: 'cards.myClass',
  gameMode: 'cards.gameMode',
  /** Single versions, by deck row id. */
  deckIds: 'cards.deckIds',
  /** Whole decks, by family id. */
  familyIds: 'cards.familyIds'
} as const

/**
 * Defaults. Range is 生涯 rather than 30 天: coverage already excludes every
 * match before deck versioning shipped (plan section 7), and a second window on
 * top of that would leave most users looking at an empty table.
 */
export function defaultCardsFilters(): CardsFilters {
  return {
    myClass: 'all',
    gameMode: 'all',
    rangeKey: 'all',
    startDate: null,
    endDate: null,
    decks: emptyDeckSelection()
  }
}

export type CardsVocabulary = {
  classIds: readonly string[]
  modeIds: readonly string[]
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

/**
 * Rebuild from `settings.getAll()`; every field falls back on its own. Keys an
 * older build wrote and this one no longer has (`cards.deckScope`,
 * `cards.minGames`, `cards.displayMode`) are read only where they disambiguate
 * an old deck pick, and otherwise ignored.
 */
export function hydrateCardsFilters(
  raw: Record<string, unknown> | null | undefined,
  vocab: CardsVocabulary
): CardsFilters {
  const base = defaultCardsFilters()
  if (!raw) return base

  const myClass = readSetting(raw, CARDS_SETTINGS_KEYS.myClass)
  if (typeof myClass === 'string' && (myClass === 'all' || vocab.classIds.includes(myClass))) {
    base.myClass = myClass as ClassFilter
  }

  const gameMode = readSetting(raw, CARDS_SETTINGS_KEYS.gameMode)
  if (typeof gameMode === 'string' && (gameMode === 'all' || vocab.modeIds.includes(gameMode))) {
    base.gameMode = gameMode as ModeFilter
  }

  const deckIds = asNumberArray(readSetting(raw, CARDS_SETTINGS_KEYS.deckIds)) ?? []
  const familyIds = asNumberArray(readSetting(raw, CARDS_SETTINGS_KEYS.familyIds))
  if (familyIds) {
    base.decks = { familyIds, deckIds }
  } else if (readSetting(raw, 'cards.deckScope') === 'deck') {
    base.decks = { familyIds: [], deckIds }
  } else {
    // A pick from before the two-level picker meant "this deck, every version";
    // the page's pruning pass maps the stored id onto its family.
    base.decks = { familyIds: deckIds, deckIds: [] }
  }

  return base
}

export function toCardsSettingsRecord(filters: CardsFilters): Record<string, unknown> {
  return {
    [CARDS_SETTINGS_KEYS.myClass]: filters.myClass,
    [CARDS_SETTINGS_KEYS.gameMode]: filters.gameMode,
    [CARDS_SETTINGS_KEYS.deckIds]: filters.decks.deckIds,
    [CARDS_SETTINGS_KEYS.familyIds]: filters.decks.familyIds
  }
}

/** The keys that changed, or null; feeds `settings.setMany`. */
export function diffCardsPersistPatch(
  prev: CardsFilters | null,
  next: CardsFilters
): Record<string, unknown> | null {
  const nextRecord = toCardsSettingsRecord(next)
  if (!prev) return nextRecord
  const prevRecord = toCardsSettingsRecord(prev)
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

/* ------------------------------------------------------------ advanced */

export type CardsAdvancedKey = 'range' | 'decks'

export const CARDS_ADVANCED_LABELS: Record<CardsAdvancedKey, string> = {
  range: '時間區間',
  decks: '牌組'
}

export function cardsAdvancedChips(
  filters: CardsFilters
): Array<{ key: CardsAdvancedKey; label: string }> {
  const chips: Array<{ key: CardsAdvancedKey; label: string }> = []
  const rangeLabel = rangeChipLabel(filters.rangeKey, filters.startDate, filters.endDate)
  if (rangeLabel) chips.push({ key: 'range', label: rangeLabel })
  const deckLabel = deckSelectionChipLabel(filters.decks)
  if (deckLabel) chips.push({ key: 'decks', label: deckLabel })
  return chips
}

export function enableCardsAdvanced(key: CardsAdvancedKey): Partial<CardsFilters> {
  // 30 天 rather than 7: a week of one player's games rarely clears a 10-game
  // line for any single card.
  return key === 'range' ? { rangeKey: '30d' } : {}
}

export function clearCardsAdvanced(key: CardsAdvancedKey): Partial<CardsFilters> {
  return key === 'range' ? { rangeKey: 'all' } : { decks: emptyDeckSelection() }
}

export function clearAllCardsAdvanced(): Partial<CardsFilters> {
  return { rangeKey: 'all', decks: emptyDeckSelection() }
}

/* --------------------------------------------------------------- query */

/**
 * Filter state -> the `cards:stats` payload. Deck picks are resolved against
 * `families` here, so main only ever receives concrete deck row ids.
 */
export function buildCardsQuery(
  filters: CardsFilters,
  families: readonly DeckFamily<VersionLike>[] = []
): CardStatsQuery {
  const query: CardStatsQuery = {
    mode: filters.gameMode === 'all' ? null : filters.gameMode,
    myDeckIds: resolveDeckSelection(filters.decks, families),
    myDeckScope: 'deck'
  }
  if (filters.myClass !== 'all') query.myClassIds = [filters.myClass]

  if (filters.rangeKey === 'custom') {
    if (filters.startDate) query.start = filters.startDate.toISOString()
    if (filters.endDate) query.end = filters.endDate.toISOString()
  } else {
    query.rangeKey = filters.rangeKey
  }
  return query
}

/* ---------------------------------------------------------------- rows */

/** One line of the table: a card within one class group, with derived numbers. */
export type CardRow = {
  /** `${myClass}:${cardId}` - a neutral card can appear under two classes. */
  key: string
  myClass: string
  card: CardStat
  /** Percent, or null when the card has no games (cannot happen, but typed honestly). */
  rate: number | null
  /** Percent of the same class's decks WITHOUT the card; null when there are none. */
  withoutRate: number | null
  /** `rate - withoutRate` in percentage points; null when either side is missing. */
  delta: number | null
  /** The comparison group is too small to read the delta from. */
  deltaLowSample: boolean
  /** Under `CARD_STATS_LOW_SAMPLE` games - hidden unless the page's switch is on. */
  lowSample: boolean
  /** How many decks / versions carried it. */
  families: number
  versions: number
}

export type CardsSortKey = 'total' | 'winRate' | 'delta' | 'cost' | 'name'
export type CardsSort = { key: CardsSortKey; descending: boolean }

/** Games first: a personal page sorted by win rate is a list of 1-0 cards. */
export const DEFAULT_CARDS_SORT: CardsSort = { key: 'total', descending: true }

/** Click the active header to flip it; click another to switch with its natural direction. */
export function nextSort(current: CardsSort, key: CardsSortKey): CardsSort {
  if (current.key === key) return { key, descending: !current.descending }
  return { key, descending: key === 'total' || key === 'winRate' || key === 'delta' }
}

const pctOf = (wins: number, total: number): number | null =>
  total > 0 ? (wins / total) * 100 : null

export function toCardRows(result: CardStatsResult | null): CardRow[] {
  if (!result) return []
  const rows: CardRow[] = []
  for (const group of result.groups) {
    for (const card of group.cards) {
      const rate = pctOf(card.wins, card.total)
      const withoutRate = pctOf(card.without.wins, card.without.total)
      rows.push({
        key: `${group.myClass}:${card.cardId}`,
        myClass: group.myClass,
        card,
        rate,
        withoutRate,
        delta: rate !== null && withoutRate !== null ? rate - withoutRate : null,
        deltaLowSample: card.without.total < CARD_STATS_LOW_SAMPLE,
        lowSample: card.total < CARD_STATS_LOW_SAMPLE,
        families: new Set(card.decks.map((d) => d.familyId)).size,
        versions: card.decks.length
      })
    }
  }
  return rows
}

/**
 * The sample line (`CARD_STATS_LOW_SAMPLE`). Off: rows under it are dropped.
 * On: every row stays, and the table greys the thin ones via `lowSample`.
 */
export function applyLowSample(rows: CardRow[], showLowSample: boolean): CardRow[] {
  if (showLowSample) return rows
  return rows.filter((row) => !row.lowSample)
}

/**
 * Sort. Provisional rows sink under a rate or delta sort regardless of
 * direction - a 1-0 card must not top or bottom a 30-25 one.
 */
export function sortCardRows(rows: CardRow[], sort: CardsSort): CardRow[] {
  const dir = sort.descending ? -1 : 1
  const byId = (a: CardRow, b: CardRow): number =>
    a.card.cardId - b.card.cardId || a.myClass.localeCompare(b.myClass)

  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'cost':
        return (
          ((a.card.cost ?? 99) - (b.card.cost ?? 99)) * dir ||
          b.card.total - a.card.total ||
          byId(a, b)
        )
      case 'name':
        return a.card.name.localeCompare(b.card.name, 'zh-Hant') * dir || byId(a, b)
      case 'winRate':
      case 'delta': {
        if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1
        const av = sort.key === 'delta' ? a.delta : a.rate
        const bv = sort.key === 'delta' ? b.delta : b.rate
        if (av === null && bv === null) return b.card.total - a.card.total || byId(a, b)
        if (av === null) return 1
        if (bv === null) return -1
        return (av - bv) * dir || b.card.total - a.card.total || byId(a, b)
      }
      default:
        return (a.card.total - b.card.total) * dir || (b.rate ?? 0) - (a.rate ?? 0) || byId(a, b)
    }
  })
}

/* ------------------------------------------------------------- summary */

export type CardsSummary = {
  covered: number
  total: number
  /** Distinct (class, card) rows before the sample line. */
  cards: number
  families: number
  versions: number
}

export function summarize(result: CardStatsResult | null): CardsSummary | null {
  if (!result) return null
  const families = new Set<number>()
  let versions = 0
  let cards = 0
  for (const group of result.groups) {
    versions += group.versions
    cards += group.cards.length
    for (const card of group.cards) for (const deck of card.decks) families.add(deck.familyId)
  }
  return {
    covered: result.coverage.covered,
    total: result.coverage.total,
    cards,
    families: families.size,
    versions
  }
}
