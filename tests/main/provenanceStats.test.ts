import { describe, expect, it } from 'vitest'
import {
  summariseProvenance,
  type ProvenanceRow,
  type SourceCount
} from '../../src/main/data/provenanceStats'

function row(overrides: Partial<ProvenanceRow> = {}): ProvenanceRow {
  return {
    source: 'engine',
    result: 1,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'bishop',
    mode: 'ranked',
    bp: 8,
    playedAt: 1_700_000_000_000,
    observed: null,
    edited_fields: null,
    recog_flags: null,
    ...overrides
  }
}

/** A match the engine flagged and the user then corrected the mode of. */
function flaggedAndCorrected(flag: string): ProvenanceRow {
  return row({
    mode: 'ranked',
    recog_flags: JSON.stringify([flag]),
    edited_fields: JSON.stringify(['mode']),
    observed: JSON.stringify({ mode: 'weekendPlaza' })
  })
}

const sources = (engine: number, unknown = 0, manual = 0): SourceCount[] => [
  { source: 'engine', count: engine },
  { source: null, count: unknown },
  { source: 'manual', count: manual }
]

describe('summariseProvenance', () => {
  it('separates pre-provenance rows from engine-written ones', () => {
    const stats = summariseProvenance(sources(80, 20), [])

    expect(stats.total).toBe(100)
    expect(stats.bySource).toEqual({ engine: 80, manual: 0, unknown: 20 })
  })

  it('counts the unflagged group from the engine total, not from the fetched rows', () => {
    // Only rows carrying provenance JSON are ever fetched, so a clean match
    // never appears here. Counting the comparison group from the fetch would
    // select it on the very outcome being measured.
    const stats = summariseProvenance(sources(100), [flaggedAndCorrected('weak-mode-accepted')])

    expect(stats.unflagged.matches).toBe(99)
    expect(stats.unflagged.corrected).toBe(0)
  })

  it('produces the flag-vs-correction cross-tab the gate depends on', () => {
    const rows = [
      flaggedAndCorrected('weak-mode-accepted'),
      flaggedAndCorrected('weak-mode-accepted'),
      row({ recog_flags: JSON.stringify(['weak-mode-accepted']) }),
      // An unflagged match that was corrected anyway.
      row({
        edited_fields: JSON.stringify(['result']),
        observed: JSON.stringify({ result: 0 })
      })
    ]
    const stats = summariseProvenance(sources(50), rows)

    expect(stats.flagged['weak-mode-accepted']).toEqual({ matches: 3, corrected: 2 })
    // 50 engine rows, 3 of them flagged.
    expect(stats.unflagged).toEqual({ matches: 47, corrected: 1 })
  })

  it('counts a match under every flag it carries', () => {
    const rows = [
      row({
        recog_flags: JSON.stringify(['mode-guessed', 'ranked-no-numbers']),
        edited_fields: JSON.stringify(['mode']),
        observed: JSON.stringify({ mode: 'unknown' })
      })
    ]
    const stats = summariseProvenance(sources(10), rows)

    expect(stats.flagged['mode-guessed']).toEqual({ matches: 1, corrected: 1 })
    expect(stats.flagged['ranked-no-numbers']).toEqual({ matches: 1, corrected: 1 })
    // Counted once as a row, though, or the comparison group goes negative.
    expect(stats.unflagged.matches).toBe(9)
  })

  it('separates an edit from a correction', () => {
    const rows = [
      row({ edited_fields: JSON.stringify(['note', 'my_deckId']) }),
      row({
        edited_fields: JSON.stringify(['mode']),
        observed: JSON.stringify({ mode: 'cpu' })
      })
    ]
    const stats = summariseProvenance(sources(10), rows)

    expect(stats.editedMatches).toBe(2)
    // Only the second one overwrote something a statistic reads.
    expect(stats.correctedMatches).toBe(1)
    expect(stats.editedByField).toEqual({ note: 1, my_deckId: 1, mode: 1 })
  })

  it('tabulates what the engine read against what it was changed to', () => {
    const rows = [
      flaggedAndCorrected('weak-mode-accepted'),
      flaggedAndCorrected('weak-mode-accepted'),
      row({
        my_class: 'dragon',
        edited_fields: JSON.stringify(['my_class']),
        observed: JSON.stringify({ my_class: 'nightmare' })
      })
    ]
    const stats = summariseProvenance(sources(10), rows)

    expect(stats.transitions[0]).toEqual({
      field: 'mode',
      from: 'weekendPlaza',
      to: 'ranked',
      count: 2
    })
    expect(stats.transitions).toContainEqual({
      field: 'my_class',
      from: 'nightmare',
      to: 'dragon',
      count: 1
    })
  })

  it('leaves continuous columns out of the transition table', () => {
    const rows = [
      row({
        bp: 9,
        edited_fields: JSON.stringify(['bp']),
        observed: JSON.stringify({ bp: 8, mode: 'ranked' })
      })
    ]
    const stats = summariseProvenance(sources(10), rows)

    // Still a correction - just not one worth one table row per value.
    expect(stats.correctedMatches).toBe(1)
    expect(stats.transitions).toEqual([])
  })

  it('does not let a pre-provenance row into the comparison group', () => {
    // A legacy row edited after the upgrade gets `observed` and
    // `edited_fields`, but its origin is still unknown - it could never have
    // been flagged, so it belongs in neither side of the cross-tab.
    const rows = [
      row({
        source: null,
        edited_fields: JSON.stringify(['mode']),
        observed: JSON.stringify({ mode: 'cpu' })
      })
    ]
    const stats = summariseProvenance(sources(10, 5), rows)

    expect(stats.correctedMatches).toBe(1)
    expect(stats.unflagged).toEqual({ matches: 10, corrected: 0 })
  })

  it('survives unreadable JSON in either column', () => {
    const rows = [row({ recog_flags: 'not json', edited_fields: '{}', observed: '[]' })]
    const stats = summariseProvenance(sources(3), rows)

    expect(stats.editedMatches).toBe(0)
    expect(stats.transitions).toEqual([])
    expect(stats.unflagged.matches).toBe(3)
  })
})
