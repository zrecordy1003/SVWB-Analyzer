/**
 * The 卡片 page's pure filter logic: restore, persist, the sample line, sort.
 *
 * These are the parts that decide what the table shows without a DOM, so they
 * are the parts worth pinning: a stale setting from a retired control must
 * restore to nothing rather than to a state the page cannot express, and the
 * delta column must go grey - not blank, not confident - when the comparison
 * side is thin.
 */
import { describe, expect, it } from 'vitest'

import type { CardStat, CardStatsResult } from '../../src/shared/cardStats'
import {
  CARDS_SETTINGS_KEYS,
  DEFAULT_CARDS_SORT,
  applyLowSample,
  buildCardsQuery,
  cardsAdvancedChips,
  defaultCardsFilters,
  diffCardsPersistPatch,
  hydrateCardsFilters,
  nextSort,
  sortCardRows,
  summarize,
  toCardRows,
  type CardsVocabulary
} from '../../src/renderer/src/components/Cards/cardsFilterState'
import { groupDeckFamilies } from '../../src/renderer/src/components/DeckCards/deckVersions'

const VOCAB: CardsVocabulary = {
  classIds: ['elf', 'royal', 'witch', 'dragon', 'bishop', 'nightmare', 'nemesis'],
  modeIds: ['ranked', 'twoPick', 'unranked', 'cpu', 'custom', 'unknown']
}

function card(partial: Partial<CardStat> & { cardId: number }): CardStat {
  const total = partial.total ?? 0
  const wins = partial.wins ?? 0
  return {
    name: `#${partial.cardId}`,
    cost: null,
    type: null,
    kind: null,
    rarity: null,
    atk: null,
    life: null,
    skillText: null,
    imageHash: null,
    bannerHash: null,
    copies: 3,
    winRate: total ? +((wins / total) * 100).toFixed(2) : 0,
    without: { total: 0, wins: 0 },
    decks: [],
    ...partial,
    total,
    wins
  }
}

describe('hydrateCardsFilters', () => {
  it('falls back to defaults on an empty store', () => {
    expect(hydrateCardsFilters(null, VOCAB)).toEqual(defaultCardsFilters())
    expect(defaultCardsFilters()).toMatchObject({
      myClass: 'all',
      gameMode: 'all',
      rangeKey: 'all',
      decks: { familyIds: [], deckIds: [] }
    })
  })

  it('reads the dotted path shape the store actually writes', () => {
    const raw = {
      cards: {
        myClass: 'witch',
        gameMode: 'ranked',
        deckIds: [4, 9],
        familyIds: [2]
      }
    }
    expect(hydrateCardsFilters(raw, VOCAB)).toMatchObject({
      myClass: 'witch',
      gameMode: 'ranked',
      decks: { familyIds: [2], deckIds: [4, 9] }
    })
  })

  it('ignores the keys of retired controls, and places an old deck pick', () => {
    // `minGames`, `displayMode` and `deckScope` no longer exist. The first two
    // are dropped outright; `deckScope` is read once to decide whether an old
    // `deckIds` meant whole decks or single versions.
    const raw = {
      cards: { minGames: 25, displayMode: 'delta', deckScope: 'family', deckIds: [4] }
    }
    const restored = hydrateCardsFilters(raw, VOCAB)
    expect(restored).toEqual({ ...defaultCardsFilters(), decks: { familyIds: [4], deckIds: [] } })
    expect(restored).not.toHaveProperty('minGames')
    expect(restored).not.toHaveProperty('displayMode')

    expect(
      hydrateCardsFilters({ cards: { deckScope: 'deck', deckIds: [4] } }, VOCAB).decks
    ).toEqual({ familyIds: [], deckIds: [4] })
  })

  it('rejects an unknown class or mode rather than sending it to the query', () => {
    const raw = {
      [CARDS_SETTINGS_KEYS.myClass]: 'paladin',
      [CARDS_SETTINGS_KEYS.gameMode]: 'arena'
    }
    expect(hydrateCardsFilters(raw, VOCAB)).toMatchObject({ myClass: 'all', gameMode: 'all' })
  })

  it('never restores a date range', () => {
    const raw = { cards: { rangeKey: '7d', startDate: '2026-01-01' } }
    expect(hydrateCardsFilters(raw, VOCAB)).toMatchObject({ rangeKey: 'all', startDate: null })
  })
})

describe('diffCardsPersistPatch', () => {
  it('writes everything the first time and only the changed keys after', () => {
    const a = defaultCardsFilters()
    const first = diffCardsPersistPatch(null, a)
    expect(first && Object.keys(first).sort()).toEqual(Object.values(CARDS_SETTINGS_KEYS).sort())

    const b = { ...a, decks: { familyIds: [3], deckIds: [] }, rangeKey: '7d' as const }
    expect(diffCardsPersistPatch(a, b)).toEqual({ [CARDS_SETTINGS_KEYS.familyIds]: [3] })
    expect(diffCardsPersistPatch(b, b)).toBeNull()
  })
})

describe('buildCardsQuery', () => {
  it('omits the class for 全部職業 and maps mode all to null', () => {
    const q = buildCardsQuery(defaultCardsFilters())
    expect(q).toEqual({ mode: null, myDeckIds: [], myDeckScope: 'deck', rangeKey: 'all' })
    expect(q.myClassIds).toBeUndefined()
  })

  it('resolves a whole-deck pick to every version and a version pick to itself', () => {
    const families = groupDeckFamilies([
      { id: 3, familyId: 3, archivedAt: null },
      { id: 8, familyId: 3, archivedAt: null },
      { id: 5, familyId: 5, archivedAt: 1 }
    ])
    const f = { ...defaultCardsFilters(), decks: { familyIds: [3], deckIds: [5] } }
    const q = buildCardsQuery(f, families)
    expect(q.myDeckIds).toEqual([3, 8, 5])
    expect(q.myDeckScope).toBe('deck')
  })

  it('sends the two dates only for a custom range', () => {
    const f = {
      ...defaultCardsFilters(),
      myClass: 'dragon' as const,
      rangeKey: 'custom' as const,
      startDate: new Date('2026-05-01T00:00:00Z'),
      endDate: null
    }
    const q = buildCardsQuery(f)
    expect(q.myClassIds).toEqual(['dragon'])
    expect(q.start).toBe('2026-05-01T00:00:00.000Z')
    expect(q.end).toBeUndefined()
    expect(q.rangeKey).toBeUndefined()
  })
})

describe('advanced chips', () => {
  it('shows nothing for 生涯 and no decks, one chip per active condition otherwise', () => {
    expect(cardsAdvancedChips(defaultCardsFilters())).toEqual([])
    const f = {
      ...defaultCardsFilters(),
      rangeKey: '30d' as const,
      decks: { familyIds: [1], deckIds: [2] }
    }
    expect(cardsAdvancedChips(f)).toEqual([
      { key: 'range', label: '30 天內' },
      { key: 'decks', label: '1 個牌組、1 個版本' }
    ])
  })
})

describe('rows', () => {
  const result: CardStatsResult = {
    coverage: { total: 40, covered: 30 },
    groups: [
      {
        myClass: 'witch',
        total: 30,
        wins: 18,
        versions: 3,
        families: 2,
        cards: [
          // In every deck: no comparison group.
          card({
            cardId: 1,
            total: 30,
            wins: 18,
            cost: 2,
            name: 'Alpha',
            decks: [
              {
                deckId: 10,
                familyId: 10,
                name: 'A',
                versionLabel: 'v1',
                copies: 3,
                total: 20,
                wins: 12,
                archivedAt: null
              },
              {
                deckId: 11,
                familyId: 10,
                name: 'A',
                versionLabel: 'v2',
                copies: 3,
                total: 4,
                wins: 3,
                archivedAt: null
              },
              {
                deckId: 20,
                familyId: 20,
                name: 'B',
                versionLabel: 'v1',
                copies: 3,
                total: 6,
                wins: 3,
                archivedAt: null
              }
            ]
          }),
          // Comparison group of 10: readable delta.
          card({
            cardId: 2,
            total: 20,
            wins: 14,
            cost: 5,
            name: 'Beta',
            without: { total: 10, wins: 4 },
            decks: [
              {
                deckId: 10,
                familyId: 10,
                name: 'A',
                versionLabel: 'v1',
                copies: 2,
                total: 20,
                wins: 14,
                archivedAt: null
              }
            ]
          }),
          // Comparison group of 4: delta present but provisional.
          card({
            cardId: 3,
            total: 26,
            wins: 14,
            cost: 1,
            name: 'Gamma',
            without: { total: 4, wins: 4 }
          }),
          // Under the low-sample line itself.
          card({
            cardId: 4,
            total: 4,
            wins: 4,
            cost: 9,
            name: 'Delta',
            without: { total: 26, wins: 14 }
          })
        ]
      }
    ]
  }

  it('derives rate, delta and the two sample flags', () => {
    const rows = toCardRows(result)
    const byId = new Map(rows.map((r) => [r.card.cardId, r]))

    expect(byId.get(1)).toMatchObject({
      key: 'witch:1',
      rate: 60,
      withoutRate: null,
      delta: null,
      families: 2,
      versions: 3
    })
    expect(byId.get(2)?.delta).toBeCloseTo(30)
    expect(byId.get(2)).toMatchObject({ deltaLowSample: false, lowSample: false })
    expect(byId.get(3)).toMatchObject({ deltaLowSample: true, lowSample: false })
    expect(byId.get(4)).toMatchObject({ lowSample: true, deltaLowSample: false })
  })

  it('hides rows under the sample line by default and keeps them all when asked', () => {
    const rows = toCardRows(result)
    expect(applyLowSample(rows, false).map((r) => r.card.cardId)).toEqual([1, 2, 3])
    expect(applyLowSample(rows, true)).toHaveLength(4)
  })

  it('sorts by games by default, and sinks provisional rows under a rate or delta sort', () => {
    const rows = toCardRows(result)
    expect(sortCardRows(rows, DEFAULT_CARDS_SORT).map((r) => r.card.cardId)).toEqual([1, 3, 2, 4])

    const byRate = sortCardRows(rows, { key: 'winRate', descending: true })
    // Card 4 is 100% but 4 games: last, not first.
    expect(byRate.map((r) => r.card.cardId)).toEqual([2, 1, 3, 4])

    // The delta column sorts by delta; rows with no delta go after those with one.
    const byDelta = sortCardRows(rows, { key: 'delta', descending: true })
    expect(byDelta.map((r) => r.card.cardId)).toEqual([2, 3, 1, 4])

    expect(
      sortCardRows(rows, { key: 'cost', descending: false }).map((r) => r.card.cardId)
    ).toEqual([3, 1, 2, 4])
    expect(sortCardRows(rows, { key: 'name', descending: false }).map((r) => r.card.name)).toEqual([
      'Alpha',
      'Beta',
      'Delta',
      'Gamma'
    ])
  })

  it('flips direction on the active header and resets it on a new one', () => {
    expect(nextSort(DEFAULT_CARDS_SORT, 'total')).toEqual({ key: 'total', descending: false })
    expect(nextSort(DEFAULT_CARDS_SORT, 'name')).toEqual({ key: 'name', descending: false })
    expect(nextSort({ key: 'name', descending: false }, 'winRate')).toEqual({
      key: 'winRate',
      descending: true
    })
    expect(nextSort({ key: 'name', descending: false }, 'delta')).toEqual({
      key: 'delta',
      descending: true
    })
  })

  it('summarises coverage, distinct cards, decks and versions', () => {
    expect(summarize(result)).toEqual({
      covered: 30,
      total: 40,
      cards: 4,
      families: 2,
      versions: 3
    })
    expect(summarize(null)).toBeNull()
  })
})
