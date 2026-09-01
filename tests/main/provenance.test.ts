import { describe, expect, it } from 'vitest'
import {
  changedColumns,
  OBSERVED_COLUMNS,
  provenancePatch,
  type ProvenanceSource
} from '../../src/main/data/provenance'

/** A row as the engine wrote it: nothing edited, nothing snapshotted. */
function engineRow(overrides: Partial<ProvenanceSource> = {}): ProvenanceSource {
  return {
    result: 1,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'bishop',
    mode: 'weekendPlaza',
    bp: 8,
    durationTime: 300,
    playedAt: 1_700_000_000_000,
    note: null,
    my_deckId: null,
    oppo_deckId: null,
    observed: null,
    edited_fields: null,
    ...overrides
  }
}

const parse = (raw: string | undefined): unknown => JSON.parse(raw ?? 'null')

describe('changedColumns', () => {
  it('compares by value, so resubmitting an unchanged form is not an edit', () => {
    const row = engineRow()
    // What the edit dialog sends: the whole form, every save.
    const resubmitted = {
      result: 1,
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'bishop',
      mode: 'weekendPlaza',
      bp: 8
    }
    expect(changedColumns(row, resubmitted)).toEqual([])
  })

  it('reports only the columns whose value actually moved', () => {
    const row = engineRow()
    expect(changedColumns(row, { mode: 'ranked', bp: 8, note: 'gg' })).toEqual(['mode', 'note'])
  })

  it('treats an absent value and null as the same absence', () => {
    const row = engineRow({ note: null })
    expect(changedColumns(row, { note: undefined })).toEqual([])
  })

  it('ignores columns outside the editable allowlist', () => {
    const row = engineRow()
    // `year` is derived from playedAt at the point of the write; recording it
    // would report two edits for one act.
    expect(changedColumns(row, { year: 2020, month: 1 })).toEqual([])
  })
})

describe('provenancePatch', () => {
  it('leaves no trace when nothing changed', () => {
    expect(provenancePatch(engineRow(), { bp: 8 })).toBeNull()
  })

  it('snapshots every observed column the first time one of them is overwritten', () => {
    const row = engineRow()
    const patch = provenancePatch(row, { mode: 'ranked' })

    expect(patch?.edited_fields).toBe(JSON.stringify(['mode']))
    // The whole observed set, not only the column being changed: a later edit
    // to a different column has no second chance to record it.
    const observed = parse(patch?.observed) as Record<string, unknown>
    expect(Object.keys(observed).sort()).toEqual([...OBSERVED_COLUMNS].sort())
    expect(observed.mode).toBe('weekendPlaza')
    expect(observed.result).toBe(1)
  })

  it('does not spend the snapshot on an edit that destroys no observation', () => {
    const row = engineRow()
    const patch = provenancePatch(row, { note: 'gg', my_deckId: 4 })

    expect(patch?.edited_fields).toBe(JSON.stringify(['note', 'my_deckId']))
    expect(patch?.observed).toBeUndefined()
  })

  it('snapshots only once, so a second correction cannot overwrite the original', () => {
    const alreadySnapshotted = engineRow({
      mode: 'ranked',
      observed: JSON.stringify({ mode: 'weekendPlaza' }),
      edited_fields: JSON.stringify(['mode'])
    })
    const patch = provenancePatch(alreadySnapshotted, { result: 0 })

    expect(patch?.observed).toBeUndefined()
    expect(patch?.edited_fields).toBe(JSON.stringify(['mode', 'result']))
  })

  it('accumulates edited columns as a set rather than a log', () => {
    const row = engineRow({ edited_fields: JSON.stringify(['mode']), observed: '{}' })
    expect(provenancePatch(row, { mode: 'cpu' })).toBeNull()
  })

  it('records a tag change even though tags are not a column', () => {
    const patch = provenancePatch(engineRow(), {}, ['tags'])

    expect(patch?.edited_fields).toBe(JSON.stringify(['tags']))
    // Tags feed no statistic, so they must not consume the snapshot either.
    expect(patch?.observed).toBeUndefined()
  })

  it('survives an unreadable edited_fields instead of failing the edit', () => {
    const corrupt = engineRow({ edited_fields: 'not json' })
    expect(provenancePatch(corrupt, { note: 'gg' })?.edited_fields).toBe(JSON.stringify(['note']))
  })
})
