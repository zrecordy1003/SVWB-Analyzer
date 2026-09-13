/**
 * The 起手 page's filter state, and the pure transforms around it.
 *
 * Most of it is the 卡片 page's, imported rather than copied: the two payloads
 * are declared with the same shape for exactly this reason (`OpeningStatsPayload`
 * header), so `buildCardsQuery` produces a valid opening-stats query as it is.
 * What is NOT shared is the settings namespace - a class picked to look at
 * mulligans must not quietly change what the 卡片 page shows when it comes
 * back - and the sort, which has a rule the 卡片 table does not need.
 *
 * # The sort rule
 *
 * A row may only take part in a ranking on the difference column when its
 * `confidence` is `'sortable'`. Rows that are merely `'shown'` still display
 * their number, but under a difference sort they sink beneath every sortable
 * row as a block, in dealt order, and the table draws a divider between the two
 * blocks so the user sees the rule rather than wonders why a +9.0 sits under a
 * +2.1. The alternative - letting them sort and greying them - is what the
 * contract's header calls "a ranking the data cannot support".
 */
import type { OpeningCardStat, OpeningStatsPayload, OpeningStatsResult } from '@shared/openingStats'

import { readSetting } from '../Analyzer/filterState'
import {
  buildCardsQuery,
  defaultCardsFilters,
  type CardsFilters,
  type CardsVocabulary,
  type ClassFilter,
  type ModeFilter
} from '../Cards/cardsFilterState'
import { emptyDeckSelection } from '../Common/filters/deckSelection'
import type { DeckFamily, VersionLike } from '../DeckCards/deckVersions'

export type OpeningFilters = CardsFilters

/** Same keys as 卡片, under this page's own prefix. */
export const OPENING_SETTINGS_KEYS = {
  myClass: 'opening.myClass',
  gameMode: 'opening.gameMode',
  deckIds: 'opening.deckIds',
  familyIds: 'opening.familyIds'
} as const

export const defaultOpeningFilters = defaultCardsFilters

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

export function hydrateOpeningFilters(
  raw: Record<string, unknown> | null | undefined,
  vocab: CardsVocabulary
): OpeningFilters {
  const base = defaultOpeningFilters()
  if (!raw) return base

  const myClass = readSetting(raw, OPENING_SETTINGS_KEYS.myClass)
  if (typeof myClass === 'string' && (myClass === 'all' || vocab.classIds.includes(myClass))) {
    base.myClass = myClass as ClassFilter
  }
  const gameMode = readSetting(raw, OPENING_SETTINGS_KEYS.gameMode)
  if (typeof gameMode === 'string' && (gameMode === 'all' || vocab.modeIds.includes(gameMode))) {
    base.gameMode = gameMode as ModeFilter
  }
  const deckIds = asNumberArray(readSetting(raw, OPENING_SETTINGS_KEYS.deckIds)) ?? []
  const familyIds = asNumberArray(readSetting(raw, OPENING_SETTINGS_KEYS.familyIds)) ?? []
  base.decks = familyIds.length || deckIds.length ? { familyIds, deckIds } : emptyDeckSelection()
  return base
}

export function toOpeningSettingsRecord(filters: OpeningFilters): Record<string, unknown> {
  return {
    [OPENING_SETTINGS_KEYS.myClass]: filters.myClass,
    [OPENING_SETTINGS_KEYS.gameMode]: filters.gameMode,
    [OPENING_SETTINGS_KEYS.deckIds]: filters.decks.deckIds,
    [OPENING_SETTINGS_KEYS.familyIds]: filters.decks.familyIds
  }
}

export function diffOpeningPersistPatch(
  prev: OpeningFilters | null,
  next: OpeningFilters
): Record<string, unknown> | null {
  const nextRecord = toOpeningSettingsRecord(next)
  if (!prev) return nextRecord
  const prevRecord = toOpeningSettingsRecord(prev)
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

/** Filter state -> the `cards:openingStats` payload. */
export function buildOpeningQuery(
  filters: OpeningFilters,
  families: readonly DeckFamily<VersionLike>[] = []
): OpeningStatsPayload {
  return buildCardsQuery(filters, families)
}

/* ---------------------------------------------------------------- rows */

export type OpeningRow = {
  /** `cardId` - the contract is per card, not per (class, card). */
  key: string
  stat: OpeningCardStat
  /** `confidence === 'sortable'`; the only rows a difference sort may rank. */
  sortable: boolean
}

export type OpeningSortKey = 'dealt' | 'keepRate' | 'dealRate' | 'diff' | 'cost' | 'name'
export type OpeningSort = { key: OpeningSortKey; descending: boolean }

/** Dealt first: the card you see most is the one your habits are built around. */
export const DEFAULT_OPENING_SORT: OpeningSort = { key: 'dealt', descending: true }

export function nextOpeningSort(current: OpeningSort, key: OpeningSortKey): OpeningSort {
  if (current.key === key) return { key, descending: !current.descending }
  return { key, descending: key !== 'cost' && key !== 'name' }
}

export function toOpeningRows(result: OpeningStatsResult | null): OpeningRow[] {
  if (!result) return []
  return result.cards.map((stat) => ({
    key: String(stat.cardId),
    stat,
    sortable: stat.confidence === 'sortable'
  }))
}

const byId = (a: OpeningRow, b: OpeningRow): number => a.stat.cardId - b.stat.cardId
const byDealtDesc = (a: OpeningRow, b: OpeningRow): number =>
  b.stat.dealt - a.stat.dealt || byId(a, b)

/**
 * Sort. Nulls sink under every numeric sort regardless of direction, and under
 * a difference sort only sortable rows are ranked - the rest keep dealt order
 * beneath them.
 */
export function sortOpeningRows(rows: OpeningRow[], sort: OpeningSort): OpeningRow[] {
  const dir = sort.descending ? -1 : 1
  const numeric = (
    pick: (row: OpeningRow) => number | null
  ): ((a: OpeningRow, b: OpeningRow) => number) => {
    return (a, b) => {
      const av = pick(a)
      const bv = pick(b)
      if (av === null && bv === null) return byDealtDesc(a, b)
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * dir || byDealtDesc(a, b)
    }
  }

  switch (sort.key) {
    case 'cost':
      return [...rows].sort(
        (a, b) => ((a.stat.cost ?? 99) - (b.stat.cost ?? 99)) * dir || byDealtDesc(a, b)
      )
    case 'name':
      return [...rows].sort(
        (a, b) => a.stat.name.localeCompare(b.stat.name, 'zh-Hant') * dir || byId(a, b)
      )
    case 'keepRate':
      return [...rows].sort(numeric((r) => r.stat.keepRate?.rate ?? null))
    case 'dealRate':
      // Observed minus expected: the interesting order is "furthest below what
      // the deck makes possible", which is the recognition alarm.
      return [...rows].sort(
        numeric((r) =>
          r.stat.observedDealRate !== null && r.stat.expectedDealRate !== null
            ? r.stat.observedDealRate - r.stat.expectedDealRate
            : null
        )
      )
    case 'diff': {
      const ranked = rows.filter((r) => r.sortable).sort(numeric((r) => r.stat.diff))
      const rest = rows.filter((r) => !r.sortable).sort(byDealtDesc)
      return [...ranked, ...rest]
    }
    default:
      return [...rows].sort((a, b) => (a.stat.dealt - b.stat.dealt) * dir || byId(a, b))
  }
}

/**
 * Under a difference sort, the index at which the unranked block begins, or
 * -1 when there is no boundary to draw. The table draws its divider here.
 */
export function unrankedBoundary(rows: OpeningRow[], sort: OpeningSort): number {
  if (sort.key !== 'diff') return -1
  const index = rows.findIndex((r) => !r.sortable)
  return index <= 0 ? -1 : index
}
