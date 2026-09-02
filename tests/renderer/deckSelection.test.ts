/**
 * The two-level deck pick shared by the analyzer and the 卡片 page: how a pick
 * resolves to deck row ids, how a stale or old-format pick is repaired, and
 * what the picker lists.
 */
import { describe, expect, it } from 'vitest'

import {
  buildDeckFamilyOptions,
  deckOptionLabel,
  deckSelectionChipLabel,
  pruneDeckSelection,
  resolveDeckSelection,
  restrictSelectionToClass,
  selectedDeckOptions,
  selectionFromOptions,
  visibleDeckOptions
} from '../../src/renderer/src/components/Common/filters/deckSelection'
import { groupDeckFamilies } from '../../src/renderer/src/components/DeckCards/deckVersions'

type Row = {
  id: number
  familyId: number | null
  archivedAt: number | null
  name: string
  classId: string
  categoryName: string | null
  categorySort: number | null
}

const row = (
  id: number,
  familyId: number,
  name: string,
  classId: string,
  archivedAt: number | null = null
): Row => ({ id, familyId, archivedAt, name, classId, categoryName: null, categorySort: null })

// Family 1 (elf): v1 = 1, v2 = 4 (deleted), v3 = 7. Family 2 (witch): one
// version. Family 3 (elf): fully deleted.
const ROWS: Row[] = [
  row(1, 1, 'Aggro', 'elf'),
  row(4, 1, 'Aggro', 'elf', 100),
  row(7, 1, 'Aggro', 'elf'),
  row(2, 2, 'Spell', 'witch'),
  row(3, 3, 'Old', 'elf', 100)
]
const FAMILIES = groupDeckFamilies(ROWS)
const CLASS_ORDER = ['elf', 'royal', 'witch']

describe('resolveDeckSelection', () => {
  it('expands a deck to every version, deleted ones included, and a version to itself', () => {
    expect(resolveDeckSelection({ familyIds: [1], deckIds: [] }, FAMILIES)).toEqual([1, 4, 7])
    expect(resolveDeckSelection({ familyIds: [], deckIds: [4] }, FAMILIES)).toEqual([4])
    expect(resolveDeckSelection({ familyIds: [1], deckIds: [7, 2] }, FAMILIES)).toEqual([
      1, 4, 7, 2
    ])
    expect(resolveDeckSelection({ familyIds: [], deckIds: [] }, FAMILIES)).toEqual([])
  })

  it('resolves an unknown deck to nothing', () => {
    expect(resolveDeckSelection({ familyIds: [99], deckIds: [] }, FAMILIES)).toEqual([])
  })
})

describe('pruneDeckSelection', () => {
  it('drops what no longer exists', () => {
    expect(pruneDeckSelection({ familyIds: [1, 99], deckIds: [7, 42] }, FAMILIES)).toEqual({
      familyIds: [1],
      deckIds: [7]
    })
  })

  it('maps an old-format pick (current version id) onto its family', () => {
    // Before the two-level picker, "this deck" was stored as version 7's id.
    expect(pruneDeckSelection({ familyIds: [7], deckIds: [] }, FAMILIES)).toEqual({
      familyIds: [1],
      deckIds: []
    })
    // Two old ids of the same family collapse to one.
    expect(pruneDeckSelection({ familyIds: [7, 1], deckIds: [] }, FAMILIES)).toEqual({
      familyIds: [1],
      deckIds: []
    })
  })
})

describe('options', () => {
  const all = buildDeckFamilyOptions(FAMILIES, CLASS_ORDER)

  it('lists one option per deck with its versions nested, in class order', () => {
    expect(all.map((f) => [f.familyId, f.name, f.versions.length, f.archived])).toEqual([
      [1, 'Aggro', 3, false],
      [3, 'Old', 1, true],
      [2, 'Spell', 1, false]
    ])
    expect(all[0].versions.map((v) => [v.deckId, v.versionLabel, v.archived])).toEqual([
      [1, 'v1', false],
      [4, 'v2', true],
      [7, 'v3', false]
    ])
  })

  it('hides deleted decks and versions unless asked, and narrows to a class', () => {
    const shown = visibleDeckOptions(all, { classId: null, showArchived: false })
    expect(shown.map((f) => f.familyId)).toEqual([1, 2])
    expect(shown[0].versions.map((v) => v.deckId)).toEqual([1, 7])

    expect(
      visibleDeckOptions(all, { classId: null, showArchived: true }).map((f) => f.familyId)
    ).toEqual([1, 3, 2])
    expect(
      visibleDeckOptions(all, { classId: 'witch', showArchived: false }).map((f) => f.familyId)
    ).toEqual([2])
  })

  it('round-trips a selection through option objects and labels them', () => {
    const picked = selectedDeckOptions({ familyIds: [2], deckIds: [7] }, all)
    expect(picked.map(deckOptionLabel)).toEqual(['Spell', 'Aggro v3'])
    expect(selectionFromOptions(picked)).toEqual({ familyIds: [2], deckIds: [7] })
  })

  it('keeps only one class of picks after a class switch', () => {
    expect(restrictSelectionToClass({ familyIds: [1, 2], deckIds: [7, 2] }, all, 'elf')).toEqual({
      familyIds: [1],
      deckIds: [7]
    })
  })
})

describe('deckSelectionChipLabel', () => {
  it("names what is picked in the user's two words", () => {
    expect(deckSelectionChipLabel({ familyIds: [], deckIds: [] })).toBeNull()
    expect(deckSelectionChipLabel({ familyIds: [1, 2], deckIds: [] })).toBe('2 個牌組')
    expect(deckSelectionChipLabel({ familyIds: [], deckIds: [7] })).toBe('1 個版本')
    expect(deckSelectionChipLabel({ familyIds: [1], deckIds: [7] })).toBe('1 個牌組、1 個版本')
  })
})
