/**
 * The deck filter's selection, shared by the analyzer and the 卡片 page.
 *
 * A user picks either a deck (every version of it) or one specific version.
 * The two live side by side in the state - `familyIds` for whole decks,
 * `deckIds` for single versions - and are turned into one flat list of deck
 * row ids right before the IPC call, so main only ever sees concrete ids
 * (`myDeckScope: 'deck'`) and needs no notion of the picker's two levels.
 *
 * Pure on purpose: no MUI, no IPC. The families come from
 * `groupDeckFamilies(allDeckVersions)`, which every screen already has.
 */
import { versionLabel, type DeckFamily, type VersionLike } from '../../DeckCards/deckVersions'

export type DeckSelection = {
  /** Whole decks: every version of each family. */
  familyIds: number[]
  /** Single versions, by deck row id. */
  deckIds: number[]
}

export const emptyDeckSelection = (): DeckSelection => ({ familyIds: [], deckIds: [] })

export const isEmptyDeckSelection = (sel: DeckSelection): boolean =>
  sel.familyIds.length === 0 && sel.deckIds.length === 0

export const deckSelectionSize = (sel: DeckSelection): number =>
  sel.familyIds.length + sel.deckIds.length

export function sameDeckSelection(a: DeckSelection, b: DeckSelection): boolean {
  const same = (x: number[], y: number[]): boolean =>
    x.length === y.length && x.every((v, i) => v === y[i])
  return same(a.familyIds, b.familyIds) && same(a.deckIds, b.deckIds)
}

/**
 * The flat list of deck row ids a selection stands for, deduplicated: a family
 * expands to all of its versions (archived included - their matches are still
 * that deck's), a version to itself. A family id nobody has any more resolves
 * to nothing; the caller's pruning is what reports that.
 */
export function resolveDeckSelection(
  sel: DeckSelection,
  families: readonly DeckFamily<VersionLike>[]
): number[] {
  if (isEmptyDeckSelection(sel)) return []
  const byFamily = new Map(families.map((f) => [f.familyId, f]))
  const ids = new Set<number>()
  for (const familyId of sel.familyIds) {
    const family = byFamily.get(familyId)
    if (!family) continue
    for (const version of family.versions) ids.add(version.deck.id)
  }
  for (const deckId of sel.deckIds) ids.add(deckId)
  return [...ids]
}

/**
 * Drop what no longer exists, and normalise what an older build stored.
 *
 * Before the two-level picker, "this deck" was stored as the id of its current
 * version. Those ids land in `familyIds` on restore; here, an id that is not a
 * family id but is some version's deck id is moved to that version's family -
 * the meaning the user had picked. Anything that matches nothing is gone
 * (hard-deleted) and comes out.
 */
export function pruneDeckSelection(
  sel: DeckSelection,
  families: readonly DeckFamily<VersionLike>[]
): DeckSelection {
  const familyIds = new Set(families.map((f) => f.familyId))
  const familyOfDeck = new Map<number, number>()
  for (const family of families) {
    for (const version of family.versions) familyOfDeck.set(version.deck.id, family.familyId)
  }

  const nextFamilies: number[] = []
  for (const id of sel.familyIds) {
    const resolved = familyIds.has(id) ? id : familyOfDeck.get(id)
    if (resolved !== undefined && !nextFamilies.includes(resolved)) nextFamilies.push(resolved)
  }
  const nextDecks = sel.deckIds.filter((id) => familyOfDeck.has(id))
  return { familyIds: nextFamilies, deckIds: nextDecks }
}

/* ------------------------------------------------------------- options */

/** What the picker needs to know about a deck, beyond what `VersionLike` has. */
export type DeckOptionSource = VersionLike & {
  name: string
  classId: string | number | null
  categoryName?: string | null
  categorySort?: number | null
}

export type DeckVersionOption = {
  kind: 'version'
  key: string
  deckId: number
  familyId: number
  name: string
  classId: string | number | null
  /** `v2` - always set on a version row. */
  versionLabel: string
  archived: boolean
}

export type DeckFamilyOption = {
  kind: 'family'
  key: string
  familyId: number
  /** The current version's id - what the deck "is" today. */
  deckId: number
  name: string
  classId: string | number | null
  categoryName: string | null
  categorySort: number | null
  /** Every version of the deck was deleted. */
  archived: boolean
  /** Oldest first. Only families with more than one get an expand arrow. */
  versions: DeckVersionOption[]
}

export type DeckOption = DeckFamilyOption | DeckVersionOption

export const familyOptionKey = (familyId: number): string => `f${familyId}`
export const versionOptionKey = (deckId: number): string => `d${deckId}`

/**
 * Every family as a picker option, with its versions nested, sorted the way
 * the pickers have always sorted: category, then class order, then name.
 */
export function buildDeckFamilyOptions<T extends DeckOptionSource>(
  families: readonly DeckFamily<T>[],
  classOrder: readonly string[]
): DeckFamilyOption[] {
  const orderIndex = new Map(classOrder.map((id, idx) => [id, idx]))
  const options = families.map<DeckFamilyOption>((family) => {
    const deck = family.current
    return {
      kind: 'family',
      key: familyOptionKey(family.familyId),
      familyId: family.familyId,
      deckId: deck.id,
      name: deck.name,
      classId: deck.classId,
      categoryName: deck.categoryName ?? null,
      categorySort: deck.categorySort ?? null,
      archived: family.archived,
      versions: family.versions.map((version) => ({
        kind: 'version',
        key: versionOptionKey(version.deck.id),
        deckId: version.deck.id,
        familyId: family.familyId,
        name: version.deck.name,
        classId: version.deck.classId,
        versionLabel: versionLabel(version.number),
        archived: version.archived
      }))
    }
  })
  options.sort((a, b) => {
    const as = a.categorySort ?? 9999
    const bs = b.categorySort ?? 9999
    if (as !== bs) return as - bs
    const an = (a.categoryName ?? '未分類').localeCompare(b.categoryName ?? '未分類')
    if (an !== 0) return an
    const ai = orderIndex.get(String(a.classId)) ?? 9999
    const bi = orderIndex.get(String(b.classId)) ?? 9999
    if (ai !== bi) return ai - bi
    return a.name.localeCompare(b.name) || a.familyId - b.familyId
  })
  return options
}

/**
 * The options a picker lists: one class or every class, deleted decks only on
 * request. Inside a listed family, deleted versions follow the same switch.
 */
export function visibleDeckOptions(
  all: readonly DeckFamilyOption[],
  opts: { classId: string | null; showArchived: boolean }
): DeckFamilyOption[] {
  return all
    .filter((family) => opts.showArchived || !family.archived)
    .filter(
      (family) =>
        opts.classId === null || (family.classId != null && String(family.classId) === opts.classId)
    )
    .map((family) =>
      opts.showArchived
        ? family
        : { ...family, versions: family.versions.filter((v) => !v.archived) }
    )
}

/** The option objects a selection points at, in selection order; unknown ids are skipped. */
export function selectedDeckOptions(
  sel: DeckSelection,
  all: readonly DeckFamilyOption[]
): DeckOption[] {
  const byFamily = new Map(all.map((f) => [f.familyId, f]))
  const byDeck = new Map<number, DeckVersionOption>()
  for (const family of all) for (const v of family.versions) byDeck.set(v.deckId, v)
  const out: DeckOption[] = []
  for (const id of sel.familyIds) {
    const f = byFamily.get(id)
    if (f) out.push(f)
  }
  for (const id of sel.deckIds) {
    const v = byDeck.get(id)
    if (v) out.push(v)
  }
  return out
}

/** Options -> selection; the inverse of `selectedDeckOptions`. */
export function selectionFromOptions(options: readonly DeckOption[]): DeckSelection {
  const familyIds: number[] = []
  const deckIds: number[] = []
  for (const option of options) {
    if (option.kind === 'family') familyIds.push(option.familyId)
    else deckIds.push(option.deckId)
  }
  return { familyIds, deckIds }
}

/** `名稱` for a deck, `名稱 v2` for a version - the chip text. */
export const deckOptionLabel = (option: DeckOption): string =>
  option.kind === 'version' ? `${option.name} ${option.versionLabel}` : option.name

/** Keep only the picks that belong to one class - what a class switch leaves standing. */
export function restrictSelectionToClass(
  sel: DeckSelection,
  all: readonly DeckFamilyOption[],
  classId: string
): DeckSelection {
  const keep = new Set(
    all.filter((f) => f.classId != null && String(f.classId) === classId).map((f) => f.familyId)
  )
  return {
    familyIds: sel.familyIds.filter((id) => keep.has(id)),
    deckIds: sel.deckIds.filter((id) =>
      all.some((f) => keep.has(f.familyId) && f.versions.some((v) => v.deckId === id))
    )
  }
}

/** The advanced-condition chip's text: 「2 個牌組」, 「1 個版本」, or both. */
export function deckSelectionChipLabel(sel: DeckSelection): string | null {
  const f = sel.familyIds.length
  const d = sel.deckIds.length
  if (f === 0 && d === 0) return null
  if (d === 0) return `${f} 個牌組`
  if (f === 0) return `${d} 個版本`
  return `${f} 個牌組、${d} 個版本`
}
