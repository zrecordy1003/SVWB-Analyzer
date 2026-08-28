import { describe, expect, it } from 'vitest'
import {
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
    expect(Object.keys(patch!)).toHaveLength(10)
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

describe('buildQueryParams', () => {
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
