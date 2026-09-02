/**
 * Deck versions, as the renderer reasons about them.
 *
 * Pure on purpose - no MUI, no IPC - so the rules that decide "which row is the
 * current version", "what number does this version get" and "what changed
 * between two card lists" are testable in a plain node run. Every screen that
 * shows versions (牌組戰績, 牌組管理, 分析器的牌組篩選) derives from these
 * functions rather than re-deciding the rules locally.
 *
 * Numbering and "current" both follow docs/deck-versioning-plan.md 3.4: ordered
 * by `id`, never by `createdAt`. Ids are AUTOINCREMENT - monotonic, no ties, not
 * recycled - while createdAt mixes integer and text storage in old databases.
 */

export type VersionLike = {
  id: number
  familyId: number | null
  /** Non-null means the row was "deleted" while matches still reference it. */
  archivedAt: Date | string | number | null
}

export type DeckVersion<T extends VersionLike> = {
  deck: T
  /** 1-based, by id within the family. Recomputed on every read, never stored. */
  number: number
  archived: boolean
}

export type DeckFamily<T extends VersionLike> = {
  familyId: number
  /** Oldest first. */
  versions: DeckVersion<T>[]
  /** Highest unarchived id; when every version is archived, the highest id. */
  current: T
  /** Every version archived - the deck as a whole was deleted. */
  archived: boolean
}

export const familyIdOf = (row: VersionLike): number => row.familyId ?? row.id

export const isArchived = (row: VersionLike): boolean => row.archivedAt !== null

/**
 * Group version rows into families. Families come back in the order their
 * first row appeared in the input; callers sort as they see fit.
 */
export function groupDeckFamilies<T extends VersionLike>(rows: readonly T[]): DeckFamily<T>[] {
  const byFamily = new Map<number, T[]>()
  for (const row of rows) {
    const key = familyIdOf(row)
    const list = byFamily.get(key)
    if (list) list.push(row)
    else byFamily.set(key, [row])
  }

  const families: DeckFamily<T>[] = []
  for (const [familyId, members] of byFamily) {
    const sorted = [...members].sort((a, b) => a.id - b.id)
    const versions = sorted.map((deck, index) => ({
      deck,
      number: index + 1,
      archived: isArchived(deck)
    }))
    const live = sorted.filter((d) => !isArchived(d))
    const current = live.length ? live[live.length - 1] : sorted[sorted.length - 1]
    families.push({ familyId, versions, current, archived: live.length === 0 })
  }
  return families
}

/**
 * What `decks:all` returns by default, derived on the renderer side from the
 * full version list: one row per family - its current version - and no family
 * that is archived through and through. Pickers and the match list want exactly
 * this, so they never see a version or an archived deck.
 */
export function currentDecks<T extends VersionLike>(rows: readonly T[]): T[] {
  return groupDeckFamilies(rows)
    .filter((f) => !f.archived)
    .map((f) => f.current)
}

/** Version -> the row before it in the same family, or null for v1. */
export function previousVersion<T extends VersionLike>(
  family: DeckFamily<T>,
  version: DeckVersion<T>
): DeckVersion<T> | null {
  const index = family.versions.findIndex((v) => v.deck.id === version.deck.id)
  return index > 0 ? family.versions[index - 1] : null
}

export const versionLabel = (number: number): string => `v${number}`

/* ------------------------------------------------------------------ diff */

export type DiffableCard = { cardId: number; count: number }

export type DeckCardDiff<T extends DiffableCard> = {
  /** In `next`, not in `prev`. */
  added: T[]
  /** In `prev`, not in `next`. */
  removed: T[]
  /** In both, with a different copy count. `card` is the `next` row. */
  changed: { card: T; from: number; to: number }[]
  /** Cards (not copies) present in both with the same count. */
  unchanged: number
}

/**
 * What changed between two card lists, by card id.
 *
 * A card whose count moved is reported as a change, not as a remove plus an
 * add: "went from 3 to 2 copies" is what the user did, and splitting it in two
 * would double-count it in the summary. Output order follows the `next` list
 * (which the IPC already sorts by cost, then id) so the dialog lines up with
 * the deck the user is looking at; removed cards follow `prev`'s order.
 */
export function diffDeckCards<T extends DiffableCard>(
  prev: readonly T[],
  next: readonly T[]
): DeckCardDiff<T> {
  const before = new Map(prev.map((c) => [c.cardId, c]))
  const after = new Map(next.map((c) => [c.cardId, c]))

  const added: T[] = []
  const changed: DeckCardDiff<T>['changed'] = []
  let unchanged = 0
  for (const card of next) {
    const was = before.get(card.cardId)
    if (!was) added.push(card)
    else if (was.count !== card.count) changed.push({ card, from: was.count, to: card.count })
    else unchanged++
  }
  const removed = prev.filter((c) => !after.has(c.cardId))

  return { added, removed, changed, unchanged }
}

/** Net copies added and removed - what a one-line summary of a diff says. */
export function diffCopyCounts<T extends DiffableCard>(
  diff: DeckCardDiff<T>
): { added: number; removed: number } {
  let added = diff.added.reduce((n, c) => n + c.count, 0)
  let removed = diff.removed.reduce((n, c) => n + c.count, 0)
  for (const { from, to } of diff.changed) {
    if (to > from) added += to - from
    else removed += from - to
  }
  return { added, removed }
}

export function isEmptyDiff<T extends DiffableCard>(diff: DeckCardDiff<T>): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
}

/* ------------------------------------------------------- inline diff chips */

/**
 * One chip on a version row: a single change, as the row summarises it.
 *
 * `label` is the text after the card name (`×1`, `×3`, `×1→×3`); the sign that
 * goes in front is the kind's, so the component decides the glyph and colour
 * and this stays free of presentation.
 */
export type DiffChip<T extends DiffableCard> = {
  kind: 'added' | 'removed' | 'changed'
  card: T
  label: string
}

/**
 * How many chips a row shows before folding the rest into a "+N".
 *
 * Six fit on one line at the panel's narrowest (the 牌組管理 dialog); past that
 * the row shows five and a count, so the fold never hides exactly one chip -
 * "+1" in place of the thing itself would be the one case where the summary is
 * longer than what it replaces.
 */
export const DIFF_CHIP_LIMIT = 6
export const DIFF_CHIP_SHOWN = 5

/**
 * The chips for a diff, adds first, then removes, then count changes - the
 * order the full dialog uses, so a chip and its section line up.
 */
export function diffChips<T extends DiffableCard>(diff: DeckCardDiff<T>): DiffChip<T>[] {
  return [
    ...diff.added.map((card) => ({ kind: 'added' as const, card, label: `×${card.count}` })),
    ...diff.removed.map((card) => ({ kind: 'removed' as const, card, label: `×${card.count}` })),
    ...diff.changed.map(({ card, from, to }) => ({
      kind: 'changed' as const,
      card,
      label: `×${from}→×${to}`
    }))
  ]
}

/** The chips a row actually renders, and how many it folded away. */
export function summarizeDiffChips<T extends DiffableCard>(
  chips: readonly DiffChip<T>[],
  limit = DIFF_CHIP_LIMIT,
  shown = DIFF_CHIP_SHOWN
): { shown: DiffChip<T>[]; hidden: number } {
  if (chips.length <= limit) return { shown: [...chips], hidden: 0 }
  return { shown: chips.slice(0, shown), hidden: chips.length - shown }
}

/* --------------------------------------------------------- played span */

/**
 * The period a version was actually played over, as the row prints it.
 *
 * `M/D – M/D` normally, collapsing to one date when both games fell on the same
 * day; the year is only spelled out on a date outside the current year, which
 * is when "8/30" stops being unambiguous. Null on either end - the version has
 * no games in range - reads as 尚未打過.
 *
 * Local time, like every other date on screen: a match played at 23:30 belongs
 * to the day the user was sitting there, not to the UTC one.
 */
export function formatPlayedSpan(
  firstPlayedAt: number | null | undefined,
  lastPlayedAt: number | null | undefined,
  now: Date = new Date()
): string {
  if (firstPlayedAt == null || lastPlayedAt == null) return '尚未打過'
  const first = new Date(Math.min(firstPlayedAt, lastPlayedAt))
  const last = new Date(Math.max(firstPlayedAt, lastPlayedAt))
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return '尚未打過'

  const thisYear = now.getFullYear()
  const day = (d: Date): string => {
    const md = `${d.getMonth() + 1}/${d.getDate()}`
    return d.getFullYear() === thisYear ? md : `${d.getFullYear()}/${md}`
  }
  const a = day(first)
  const b = day(last)
  return a === b ? a : `${a} – ${b}`
}

/* ------------------------------------------------------ win-rate delta */

export type WinRateDelta = {
  /** Percentage points, this version minus the one before it. */
  delta: number
  /** Either side has fewer than `threshold` games - the number is mostly noise. */
  lowSample: boolean
}

/**
 * How a version's win rate moved against the version before it.
 *
 * Null when either side has no games at all: a delta against nothing is not a
 * small number, it is no number. `threshold` is the same 10-game line the
 * analyzer draws (`confidence.ts`), passed in so this file stays free of that
 * import and the test can pin it.
 */
export function winRateDelta(
  current: { total: number; wins: number } | null | undefined,
  previous: { total: number; wins: number } | null | undefined,
  threshold: number
): WinRateDelta | null {
  if (!current || !previous || current.total <= 0 || previous.total <= 0) return null
  const rate = (r: { total: number; wins: number }): number => (r.wins / r.total) * 100
  return {
    delta: rate(current) - rate(previous),
    lowSample: current.total < threshold || previous.total < threshold
  }
}

/** `+10.0` / `−4.3` / `±0.0`, with a real minus sign, one decimal. */
export function formatDelta(delta: number): string {
  const rounded = Math.round(delta * 10) / 10
  if (rounded === 0) return '±0.0'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)}`
}
