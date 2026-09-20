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
import type {
  MulliganPayload,
  OpeningCardStat,
  OpeningStatsPayload,
  OpeningStatsResult
} from '@shared/openingStats'

import { readSetting } from '../Analyzer/filterState'
import {
  buildCardsQuery,
  defaultCardsFilters,
  type CardsFilters,
  type CardsVocabulary,
  type ClassFilter,
  type ModeFilter
} from '../Cards/cardsFilterState'
import type { ClassChoiceId } from '../Common/filters/ClassSelect'
import { emptyDeckSelection } from '../Common/filters/deckSelection'
import type { DeckFamily, VersionLike } from '../DeckCards/deckVersions'

/** Which of the page's two views is showing. The advisor is the default: it is the question the page exists for. */
export type OpeningView = 'advisor' | 'overview'
export const OPENING_VIEWS: readonly OpeningView[] = ['advisor', 'overview']

/**
 * The 卡片 filters plus the two things only this page asks.
 *
 * `oppoClass` is the advisor's one selector and it is deliberately NOT part of
 * the shared filter bar: the handler steps outside it when a cell is thin
 * (`basis`), which a filter baked into the match scope could never do. It
 * lives in the same state object as the rest so that one persist effect and
 * one hydrate path cover everything, but `buildOpeningQuery` ignores it - the
 * 手牌總覽 view is about every hand, not one matchup.
 *
 * There is no `playOrder` here any more. The advisor used to carry a
 * three-way pin (先攻 / 後攻 / 不分); it now shows both orders side by side,
 * so the order is a property of the column, passed to `buildMulliganQuery`
 * by the caller, not a thing the user chooses or the page remembers. The old
 * `opening.playOrder` setting is simply no longer read - a stale key in the
 * store is harmless, and deleting it would be a write for nothing.
 */
export type OpeningFilters = CardsFilters & {
  view: OpeningView
  oppoClass: ClassChoiceId
}

/** Same keys as 卡片, under this page's own prefix, plus the advisor's. */
export const OPENING_SETTINGS_KEYS = {
  myClass: 'opening.myClass',
  gameMode: 'opening.gameMode',
  deckIds: 'opening.deckIds',
  familyIds: 'opening.familyIds',
  view: 'opening.view',
  oppoClass: 'opening.oppoClass'
} as const

export function defaultOpeningFilters(): OpeningFilters {
  return { ...defaultCardsFilters(), view: 'advisor', oppoClass: 'all' }
}

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

  // Each validated against its own vocabulary, so a key written by a build
  // that spelled a value differently falls back to the default instead of
  // handing the page a view it has no branch for.
  const view = readSetting(raw, OPENING_SETTINGS_KEYS.view)
  if (typeof view === 'string' && (OPENING_VIEWS as readonly string[]).includes(view)) {
    base.view = view as OpeningView
  }
  const oppoClass = readSetting(raw, OPENING_SETTINGS_KEYS.oppoClass)
  if (
    typeof oppoClass === 'string' &&
    (oppoClass === 'all' || vocab.classIds.includes(oppoClass))
  ) {
    base.oppoClass = oppoClass as ClassChoiceId
  }
  return base
}

export function toOpeningSettingsRecord(filters: OpeningFilters): Record<string, unknown> {
  return {
    [OPENING_SETTINGS_KEYS.myClass]: filters.myClass,
    [OPENING_SETTINGS_KEYS.gameMode]: filters.gameMode,
    [OPENING_SETTINGS_KEYS.deckIds]: filters.decks.deckIds,
    [OPENING_SETTINGS_KEYS.familyIds]: filters.decks.familyIds,
    [OPENING_SETTINGS_KEYS.view]: filters.view,
    [OPENING_SETTINGS_KEYS.oppoClass]: filters.oppoClass
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

/** Filter state -> the `cards:openingStats` payload. The advisor's opponent pin is not part of it. */
export function buildOpeningQuery(
  filters: OpeningFilters,
  families: readonly DeckFamily<VersionLike>[] = []
): OpeningStatsPayload {
  return buildCardsQuery(filters, families)
}

/**
 * Filter state -> the `cards:mulligan` payload for one column: the shared
 * filters, the opponent pin as the handler wants it (`null` for "pool it"),
 * and the column's turn order, which is never null - the page has no pooled
 * column, and a pooled answer is the handler's own fallback, labelled as such.
 */
export function buildMulliganQuery(
  filters: OpeningFilters,
  families: readonly DeckFamily<VersionLike>[],
  playOrder: 'first' | 'second'
): MulliganPayload {
  return {
    ...buildCardsQuery(filters, families),
    oppoClass: filters.oppoClass === 'all' ? null : filters.oppoClass,
    playOrder
  }
}

/* ---------------------------------------------------------------- rows */

export type OpeningRow = {
  /** `cardId` - the contract is per card, not per (class, card). */
  key: string
  stat: OpeningCardStat
  /** `confidence === 'sortable'`; the only rows a difference sort may rank. */
  sortable: boolean
}

/**
 * One key per column. There is no `'dealRate'`: the deal-rate check lost its
 * column (see `SuspectMark` in `OpeningTable.tsx`) and with it its sort. The
 * sort lives in component state, never in a stored setting, so a stale key
 * from an earlier build cannot be read back here; if that ever changes, the
 * reader must fall back to `DEFAULT_OPENING_SORT` on an unknown key rather
 * than hand the table a sort it does not have a branch for.
 */
export type OpeningSortKey = 'dealt' | 'keepRate' | 'diff' | 'cost' | 'name'
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
