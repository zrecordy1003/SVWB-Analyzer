import { describe, expect, it } from 'vitest'
import {
  currentDecks,
  diffChips,
  diffCopyCounts,
  diffDeckCards,
  formatDelta,
  formatPlayedSpan,
  groupDeckFamilies,
  isEmptyDiff,
  previousVersion,
  summarizeDiffChips,
  versionLabel,
  winRateDelta
} from '../../src/renderer/src/components/DeckCards/deckVersions'

type Row = { id: number; familyId: number | null; archivedAt: number | null; name: string }

const row = (id: number, familyId: number | null, archivedAt: number | null = null): Row => ({
  id,
  familyId,
  archivedAt,
  name: `deck ${id}`
})

describe('groupDeckFamilies', () => {
  it('numbers versions by id within a family, oldest first, regardless of input order', () => {
    const families = groupDeckFamilies([row(7, 3), row(3, 3), row(5, 3)])
    expect(families).toHaveLength(1)
    const [fam] = families
    expect(fam.familyId).toBe(3)
    expect(fam.versions.map((v) => [v.deck.id, v.number])).toEqual([
      [3, 1],
      [5, 2],
      [7, 3]
    ])
    expect(fam.current.id).toBe(7)
    expect(fam.archived).toBe(false)
  })

  it('treats a null familyId as its own family (pre-migration rows)', () => {
    const families = groupDeckFamilies([row(1, null), row(2, 2)])
    expect(families.map((f) => f.familyId)).toEqual([1, 2])
  })

  it('picks the highest UNARCHIVED id as current', () => {
    const [fam] = groupDeckFamilies([row(1, 1), row(2, 1), row(3, 1, 1000)])
    expect(fam.current.id).toBe(2)
    expect(fam.archived).toBe(false)
    expect(fam.versions[2].archived).toBe(true)
  })

  it('falls back to the highest id when the whole family is archived, and flags it', () => {
    const [fam] = groupDeckFamilies([row(1, 1, 5), row(2, 1, 5)])
    expect(fam.current.id).toBe(2)
    expect(fam.archived).toBe(true)
  })

  it('keeps first-appearance order of families', () => {
    const families = groupDeckFamilies([row(9, 9), row(2, 2), row(10, 9)])
    expect(families.map((f) => f.familyId)).toEqual([9, 2])
  })
})

describe('currentDecks', () => {
  it('matches what decks:all returns by default - one live row per family, no dead families', () => {
    const rows = [row(1, 1), row(2, 1), row(3, 3, 7), row(4, 4), row(5, 4, 7)]
    expect(currentDecks(rows).map((d) => d.id)).toEqual([2, 4])
  })
})

describe('previousVersion / versionLabel', () => {
  it('finds the version before a given one, and null for v1', () => {
    const [fam] = groupDeckFamilies([row(1, 1), row(2, 1), row(3, 1)])
    expect(previousVersion(fam, fam.versions[2])?.deck.id).toBe(2)
    expect(previousVersion(fam, fam.versions[0])).toBeNull()
  })

  it('labels are v-prefixed', () => {
    expect(versionLabel(1)).toBe('v1')
    expect(versionLabel(12)).toBe('v12')
  })
})

describe('diffDeckCards', () => {
  const card = (cardId: number, count: number) => ({ cardId, count })

  it('reports added, removed and count changes separately', () => {
    const prev = [card(1, 3), card(2, 3), card(3, 1)]
    const next = [card(1, 3), card(2, 2), card(4, 2)]
    const diff = diffDeckCards(prev, next)
    expect(diff.added).toEqual([card(4, 2)])
    expect(diff.removed).toEqual([card(3, 1)])
    expect(diff.changed).toEqual([{ card: card(2, 2), from: 3, to: 2 }])
    expect(diff.unchanged).toBe(1)
    expect(isEmptyDiff(diff)).toBe(false)
  })

  it('follows the order of `next` for adds/changes and of `prev` for removes', () => {
    const prev = [card(5, 1), card(6, 1), card(7, 1)]
    const next = [card(9, 1), card(6, 2), card(8, 1)]
    const diff = diffDeckCards(prev, next)
    expect(diff.added.map((c) => c.cardId)).toEqual([9, 8])
    expect(diff.removed.map((c) => c.cardId)).toEqual([5, 7])
  })

  it('is empty for identical lists', () => {
    const cards = [card(1, 3), card(2, 3)]
    const diff = diffDeckCards(cards, [...cards].reverse())
    expect(isEmptyDiff(diff)).toBe(true)
    expect(diff.unchanged).toBe(2)
  })

  it('sums copies, counting a count change on the side it moved', () => {
    const diff = diffDeckCards(
      [card(1, 3), card(2, 1), card(3, 2)],
      [card(1, 1), card(2, 3), card(4, 2)]
    )
    // 1: 3->1 (-2), 2: 1->3 (+2), 3 removed (-2), 4 added (+2)
    expect(diffCopyCounts(diff)).toEqual({ added: 4, removed: 4 })
  })
})

describe('diffChips / summarizeDiffChips', () => {
  const card = (cardId: number, count: number) => ({ cardId, count })

  it('lists adds, then removes, then count changes, with the row label for each', () => {
    const diff = diffDeckCards(
      [card(1, 3), card(2, 3), card(3, 1)],
      [card(1, 3), card(2, 2), card(4, 2)]
    )
    expect(diffChips(diff)).toEqual([
      { kind: 'added', card: card(4, 2), label: '×2' },
      { kind: 'removed', card: card(3, 1), label: '×1' },
      { kind: 'changed', card: card(2, 2), label: '×3→×2' }
    ])
  })

  it('shows everything up to the limit, and folds past it to five plus a count', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      kind: 'added' as const,
      card: card(i, 1),
      label: '×1'
    }))
    expect(summarizeDiffChips(six)).toEqual({ shown: six, hidden: 0 })

    const seven = [...six, { kind: 'removed' as const, card: card(99, 1), label: '×1' }]
    const folded = summarizeDiffChips(seven)
    expect(folded.shown).toHaveLength(5)
    expect(folded.hidden).toBe(2)
  })
})

describe('formatPlayedSpan', () => {
  const now = new Date(2026, 8, 2) // 2026-09-02, local

  it('prints a M/D – M/D span in local time', () => {
    const first = new Date(2026, 8, 1, 9).getTime()
    const last = new Date(2026, 8, 2, 23, 30).getTime()
    expect(formatPlayedSpan(first, last, now)).toBe('9/1 – 9/2')
  })

  it('collapses to one date when both ends fall on the same day, whatever the order', () => {
    const a = new Date(2026, 8, 1, 9).getTime()
    const b = new Date(2026, 8, 1, 21).getTime()
    expect(formatPlayedSpan(a, b, now)).toBe('9/1')
    expect(formatPlayedSpan(b, a, now)).toBe('9/1')
  })

  it('spells out the year only on a date outside the current year', () => {
    const first = new Date(2025, 11, 30).getTime()
    const last = new Date(2026, 0, 2).getTime()
    expect(formatPlayedSpan(first, last, now)).toBe('2025/12/30 – 1/2')
  })

  it('reads 尚未打過 when either end is missing', () => {
    expect(formatPlayedSpan(null, null, now)).toBe('尚未打過')
    expect(formatPlayedSpan(undefined, 1, now)).toBe('尚未打過')
    expect(formatPlayedSpan(Number.NaN, 1, now)).toBe('尚未打過')
  })
})

describe('winRateDelta / formatDelta', () => {
  it('is the difference in percentage points, flagged low when either side is under the threshold', () => {
    expect(winRateDelta({ total: 20, wins: 12 }, { total: 20, wins: 10 }, 10)).toEqual({
      delta: 10,
      lowSample: false
    })
    expect(winRateDelta({ total: 4, wins: 3 }, { total: 20, wins: 10 }, 10)).toMatchObject({
      lowSample: true
    })
    expect(winRateDelta({ total: 20, wins: 10 }, { total: 9, wins: 4 }, 10)).toMatchObject({
      lowSample: true
    })
  })

  it('is null when either side has no games', () => {
    expect(winRateDelta({ total: 0, wins: 0 }, { total: 5, wins: 3 }, 10)).toBeNull()
    expect(winRateDelta({ total: 5, wins: 3 }, undefined, 10)).toBeNull()
  })

  it('formats with a sign, a real minus, and one decimal', () => {
    expect(formatDelta(10)).toBe('+10.0')
    expect(formatDelta(-4.26)).toBe('−4.3')
    expect(formatDelta(0.04)).toBe('±0.0')
  })
})
