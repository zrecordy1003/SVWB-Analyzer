import { describe, expect, it } from 'vitest'
import {
  MATCH_LIMIT_MIN,
  ADVANCED_FILTER_LABELS,
  advancedFilterChips,
  clearAdvancedFilter,
  clearAllAdvancedFilters,
  enableAdvancedFilter,
  followBattlePatch,
  buildQueryParams,
  defaultFilters,
  diffPersistPatch,
  hydrateFilters,
  type AnalyzerFilters,
  type FilterVocabulary
} from '../../src/renderer/src/components/Analyzer/filterState'

const VOCAB: FilterVocabulary = {
  classIds: ['elf', 'royal', 'witch', 'dragon', 'bishop', 'nightmare', 'nemesis'],
  modeIds: ['ranked', 'twoPick', 'weekendPlaza', 'unranked', 'cpu', 'custom', 'unknown']
}

function filters(overrides: Partial<AnalyzerFilters> = {}): AnalyzerFilters {
  return { ...defaultFilters(), ...overrides }
}

function omitDates(f: AnalyzerFilters): Omit<AnalyzerFilters, 'startDate' | 'endDate'> {
  const { startDate: _s, endDate: _e, ...rest } = f
  return rest
}

describe('hydrateFilters', () => {
  it('falls back to defaults when nothing was ever stored', () => {
    // The dates default to "now", so compare the rest structurally and assert
    // separately that both ends land on today.
    const today = new Date().toDateString()
    for (const raw of [null, {}]) {
      const restored = hydrateFilters(raw, VOCAB)
      expect(omitDates(restored)).toEqual(omitDates(defaultFilters()))
      expect(restored.startDate?.toDateString()).toBe(today)
      expect(restored.endDate?.toDateString()).toBe(today)
    }
  })

  it('restores a full settings record', () => {
    const restored = hydrateFilters(
      {
        'analyzer.myClass': 'dragon',
        'analyzer.gameMode': 'twoPick',
        'analyzer.matchLimit': 50,
        'analyzer.rangeKey': '30d',
        'analyzer.startDate': '2026-05-01T00:00:00.000Z',
        'analyzer.endDate': '2026-05-31T00:00:00.000Z',
        'analyzer.deckIds': [3, 7],
        'analyzer.tagIds': [1],
        'analyzer.crEnabled': true,
        'analyzer.crMin': 1750,
        'analyzer.crMax': 1849
      },
      VOCAB
    )

    expect(restored.myClass).toBe('dragon')
    expect(restored.gameMode).toBe('twoPick')
    expect(restored.matchLimit).toBe(50)
    expect(restored.rangeKey).toBe('30d')
    expect(restored.deckIds).toEqual([3, 7])
    expect(restored.tagIds).toEqual([1])
    expect(restored.crEnabled).toBe(true)
    expect(restored.crMin).toBe(1750)
    expect(restored.crMax).toBe(1849)
    expect(restored.startDate?.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('accepts the all-modes filter', () => {
    expect(hydrateFilters({ 'analyzer.gameMode': 'all' }, VOCAB).gameMode).toBe('all')
  })

  it('drops values the current build no longer recognises', () => {
    const restored = hydrateFilters(
      {
        'analyzer.myClass': 'necromancer',
        'analyzer.gameMode': 'arena',
        'analyzer.rangeKey': 'last-decade',
        'analyzer.deckIds': 'not-an-array',
        'analyzer.crEnabled': 'yes'
      },
      VOCAB
    )
    const base = defaultFilters()

    expect(restored.myClass).toBe(base.myClass)
    expect(restored.gameMode).toBe(base.gameMode)
    expect(restored.rangeKey).toBe(base.rangeKey)
    expect(restored.deckIds).toEqual([])
    expect(restored.crEnabled).toBe(base.crEnabled)
  })

  it('keeps a stored "no cap" and clamps a count below the floor', () => {
    // null is a value here, not a missing key: it is the 全部 button.
    expect(hydrateFilters({ 'analyzer.matchLimit': null }, VOCAB).matchLimit).toBeNull()
    expect(hydrateFilters({ 'analyzer.matchLimit': 3 }, VOCAB).matchLimit).toBe(MATCH_LIMIT_MIN)
    expect(hydrateFilters({ 'analyzer.matchLimit': 99999 }, VOCAB).matchLimit).toBe(9999)
    // A missing key still falls back to the default rather than to "no cap".
    expect(hydrateFilters({}, VOCAB).matchLimit).toBe(defaultFilters().matchLimit)
    expect(hydrateFilters({ 'analyzer.matchLimit': 'lots' }, VOCAB).matchLimit).toBe(
      defaultFilters().matchLimit
    )
  })

  it('normalises an inverted or out-of-range CR pair', () => {
    const inverted = hydrateFilters({ 'analyzer.crMin': 1900, 'analyzer.crMax': 1700 }, VOCAB)
    expect(inverted.crMin).toBe(1700)
    expect(inverted.crMax).toBe(1900)

    const clamped = hydrateFilters({ 'analyzer.crMin': -50, 'analyzer.crMax': 9999 }, VOCAB)
    expect(clamped.crMin).toBe(0)
    expect(clamped.crMax).toBe(3000)
  })

  it('opens a usable state for a user with no decks and no tags', () => {
    // The regression this guards: the write gate used to wait for a deck or a
    // tag to exist, so a brand new user never persisted a single filter.
    const restored = hydrateFilters({ 'analyzer.myClass': 'witch' }, VOCAB)
    expect(restored.myClass).toBe('witch')
    expect(restored.deckIds).toEqual([])
    expect(restored.tagIds).toEqual([])
  })
})

describe('diffPersistPatch', () => {
  it('writes everything when nothing has been persisted yet', () => {
    const patch = diffPersistPatch(null, filters())
    expect(patch).not.toBeNull()
    expect(Object.keys(patch!)).toHaveLength(12)
  })

  it('writes nothing when the state is unchanged', () => {
    const state = filters()
    expect(diffPersistPatch(state, { ...state })).toBeNull()
  })

  it('writes only the keys that moved', () => {
    const before = filters({ myClass: 'elf' })
    const after = { ...before, myClass: 'dragon' as AnalyzerFilters['myClass'] }
    expect(diffPersistPatch(before, after)).toEqual({ 'analyzer.myClass': 'dragon' })
  })

  it('compares id arrays by contents, not by identity', () => {
    const before = filters({ deckIds: [1, 2] })
    expect(diffPersistPatch(before, { ...before, deckIds: [1, 2] })).toBeNull()
    expect(diffPersistPatch(before, { ...before, deckIds: [2, 1] })).toEqual({
      'analyzer.deckIds': [2, 1]
    })
  })
})

describe('advancedFilterChips', () => {
  it('says nothing when only the lifetime range is set', () => {
    expect(advancedFilterChips(filters({ rangeKey: 'all' }))).toEqual([])
  })

  it('names every condition hiding behind the closed drawer', () => {
    const chips = advancedFilterChips(
      filters({ rangeKey: '30d', deckIds: [1, 2], tagIds: [5], crEnabled: true })
    )
    expect(chips).toEqual([
      { key: 'range', label: '30 天內' },
      { key: 'decks', label: '2 個牌組' },
      { key: 'tags', label: '1 個標籤' },
      { key: 'cr', label: 'CR 1650–1850' }
    ])
  })

  it('clears the chip the user actually clicked, and nothing else', () => {
    const state = filters({ rangeKey: '30d', deckIds: [1, 2], tagIds: [5], crEnabled: true })
    for (const chip of advancedFilterChips(state)) {
      const cleared = { ...state, ...clearAdvancedFilter(chip.key) }
      const keys = advancedFilterChips(cleared).map((c) => c.key)
      expect(keys, `clearing ${chip.key} must remove exactly that chip`).toEqual(
        advancedFilterChips(state)
          .map((c) => c.key)
          .filter((k) => k !== chip.key)
      )
    }
  })

  it('gives every condition a chip once it is enabled', () => {
    // The ＋ menu offers the keys with no chip; picking one must produce one,
    // or the menu would keep offering a condition that is already on.
    const bare = filters({ rangeKey: 'all', deckIds: [], tagIds: [], crEnabled: false })
    expect(advancedFilterChips(bare)).toEqual([])

    for (const key of ['range', 'cr'] as const) {
      const enabled = { ...bare, ...enableAdvancedFilter(key) }
      expect(
        advancedFilterChips(enabled).map((c) => c.key),
        `${key} must show a chip`
      ).toEqual([key])
    }

    // 牌組 and 標籤 are "on" only once something is picked, so enabling them is
    // just opening their editor - no chip until a selection lands.
    for (const key of ['decks', 'tags'] as const) {
      expect(advancedFilterChips({ ...bare, ...enableAdvancedFilter(key) })).toEqual([])
    }
  })

  it('names every condition the ＋ menu can offer', () => {
    expect(Object.keys(ADVANCED_FILTER_LABELS).sort()).toEqual(['cr', 'decks', 'range', 'tags'])
  })

  it('leaves no chip standing after clearing them all', () => {
    const state = filters({ rangeKey: 'custom', deckIds: [1], tagIds: [2], crEnabled: true })
    expect(advancedFilterChips({ ...state, ...clearAllAdvancedFilters() })).toEqual([])
  })
})

describe('followBattlePatch', () => {
  it('follows the class the moment a battle names it', () => {
    expect(followBattlePatch({ ownClass: 'dragon', mode: null }, VOCAB)).toEqual({
      myClass: 'dragon'
    })
  })

  it('treats a missing mode as "not known yet", never as "all modes"', () => {
    // A ranked battle carries no mode until its result screen. Reading that
    // null as 全部 would swing the chart to every mode mid-game.
    for (const mode of [null, undefined]) {
      const patch = followBattlePatch({ ownClass: 'elf', mode }, VOCAB)
      expect(patch).toEqual({ myClass: 'elf' })
      expect(patch).not.toHaveProperty('gameMode')
    }
  })

  it('follows both once the recorded match knows the mode', () => {
    expect(followBattlePatch({ ownClass: 'witch', mode: 'twoPick' }, VOCAB)).toEqual({
      myClass: 'witch',
      gameMode: 'twoPick'
    })
  })

  it('never follows the unrecognised bucket', () => {
    // `unknown` is a recognition failure, not a mode anyone played - and the
    // picker cannot even represent it.
    expect(followBattlePatch({ ownClass: 'elf', mode: 'unknown' }, VOCAB)).toEqual({
      myClass: 'elf'
    })
  })

  it('says nothing when the battle says nothing usable', () => {
    expect(followBattlePatch({ ownClass: null, mode: null }, VOCAB)).toBeNull()
    expect(followBattlePatch({ ownClass: 'necromancer', mode: 'arena' }, VOCAB)).toBeNull()
    expect(followBattlePatch({}, VOCAB)).toBeNull()
  })
})

describe('buildQueryParams', () => {
  it('caps the query at the chosen match count', () => {
    expect(buildQueryParams(filters({ matchLimit: 100 })).limit).toBe(100)
  })

  it('omits the cap when 全部 is chosen', () => {
    expect(buildQueryParams(filters({ matchLimit: null })).limit).toBeUndefined()
  })

  it('sends a range key for the quick ranges', () => {
    const params = buildQueryParams(filters({ rangeKey: '7d' }))
    expect(params.rangeKey).toBe('7d')
    expect(params.start).toBeUndefined()
    expect(params.end).toBeUndefined()
  })

  it('sends explicit dates for a custom range', () => {
    const start = new Date('2026-05-01T00:00:00.000Z')
    const end = new Date('2026-05-31T00:00:00.000Z')
    const params = buildQueryParams(filters({ rangeKey: 'custom', startDate: start, endDate: end }))
    expect(params.rangeKey).toBeUndefined()
    expect(params.start).toBe(start)
    expect(params.end).toBe(end)
  })

  it('omits the CR range when the switch is off', () => {
    const params = buildQueryParams(filters({ crEnabled: false, crMin: 1650, crMax: 1850 }))
    expect(params.crMin).toBeUndefined()
    expect(params.crMax).toBeUndefined()
  })

  it('sends the CR range for every mode when the switch is on', () => {
    for (const gameMode of ['ranked', 'twoPick', 'cpu', 'unranked', 'unknown', 'all'] as const) {
      const params = buildQueryParams(filters({ gameMode, crEnabled: true }))
      expect(params.crMin, `${gameMode} must carry a CR range`).toBe(1650)
      expect(params.crMax).toBe(1850)
    }
  })
})
