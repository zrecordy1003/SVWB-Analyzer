/**
 * The rollup is the privacy boundary: whatever it does not output does not
 * leave the machine. These cases pin what it outputs.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyRow,
  DEMOTING_FLAGS,
  rollup,
  utcDate,
  windowDates,
  type RollupRow
} from '../../src/main/telemetry/rollup'
import { TELEMETRY_WINDOW_DAYS } from '../../src/shared/telemetry'

/** 2026-09-02T10:00:00Z */
const NOW = Date.parse('2026-09-02T10:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function row(overrides: Partial<RollupRow> = {}): RollupRow {
  return {
    result: 1,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    playedAt: NOW - HOUR,
    source: 'engine',
    edited_fields: null,
    recog_flags: null,
    ...overrides
  }
}

describe('window', () => {
  it('covers today and the preceding days in UTC, oldest first', () => {
    const dates = windowDates(NOW)
    expect(dates).toHaveLength(TELEMETRY_WINDOW_DAYS)
    expect(dates.at(-1)).toBe('2026-09-02')
    expect(dates[0]).toBe('2026-08-20')
  })

  it('dates rows by UTC, not local time', () => {
    // 23:30 UTC on the 1st is already the 2nd in UTC+8; the bucket says the 1st.
    expect(utcDate(Date.parse('2026-09-01T23:30:00Z'))).toBe('2026-09-01')
  })
})

describe('classifyRow', () => {
  it('is clean when the engine wrote it and nothing demotes it', () => {
    expect(classifyRow(row())).toBe('clean')
  })

  it('is edited only when an observed column was overwritten', () => {
    expect(classifyRow(row({ edited_fields: '["note","my_deckId","tags"]' }))).toBe('clean')
    expect(classifyRow(row({ edited_fields: '["note","mode"]' }))).toBe('edited')
  })

  it('is flagged for the mode-doubt flags and not for a missing number', () => {
    for (const flag of DEMOTING_FLAGS) {
      expect(classifyRow(row({ recog_flags: JSON.stringify([flag]) }))).toBe('flagged')
    }
    expect(classifyRow(row({ recog_flags: '["ranked-no-numbers"]' }))).toBe('clean')
  })

  it('ranks an edit above a flag: the person had the last word', () => {
    expect(
      classifyRow(row({ edited_fields: '["mode"]', recog_flags: '["weak-mode-accepted"]' }))
    ).toBe('edited')
  })

  it('is legacy when provenance is unknown', () => {
    expect(classifyRow(row({ source: null }))).toBe('legacy')
  })

  it('puts hand-typed rows and unfinished rows outside the tiers', () => {
    expect(classifyRow(row({ source: 'manual' }))).toBe('manual')
    expect(classifyRow(row({ result: null }))).toBe('abandoned')
    // Manual wins even without a result: nothing observed it either way.
    expect(classifyRow(row({ source: 'manual', result: null }))).toBe('manual')
  })

  it('refuses vocabulary the engine does not speak', () => {
    expect(classifyRow(row({ my_class: 'paladin' }))).toBe('invalid')
    expect(classifyRow(row({ play_order: 'third' }))).toBe('invalid')
    expect(classifyRow(row({ mode: 'arena' }))).toBe('invalid')
  })

  it('treats unreadable JSON as no edits and no flags rather than failing', () => {
    expect(classifyRow(row({ edited_fields: '{oops', recog_flags: 'nope' }))).toBe('clean')
  })
})

describe('rollup', () => {
  it('emits every day in the window, empty days included', () => {
    const days = rollup([], NOW)
    expect(days).toHaveLength(TELEMETRY_WINDOW_DAYS)
    expect(days.every((d) => d.buckets.length === 0 && d.abandoned === 0 && d.manual === 0)).toBe(
      true
    )
  })

  it('counts identical matches into one bucket and keeps different ones apart', () => {
    const days = rollup(
      [
        row(),
        row(),
        row({ result: 0 }),
        row({ play_order: 'second' }),
        row({ mode: 'twoPick', oppo_class: 'elf' })
      ],
      NOW
    )
    const today = days.at(-1)!
    expect(today.date).toBe('2026-09-02')
    expect(today.buckets).toEqual([
      {
        tier: 'clean',
        mode: 'ranked',
        myClass: 'witch',
        oppoClass: 'dragon',
        playOrder: 'first',
        result: 'loss',
        count: 1
      },
      {
        tier: 'clean',
        mode: 'ranked',
        myClass: 'witch',
        oppoClass: 'dragon',
        playOrder: 'first',
        result: 'win',
        count: 2
      },
      {
        tier: 'clean',
        mode: 'ranked',
        myClass: 'witch',
        oppoClass: 'dragon',
        playOrder: 'second',
        result: 'win',
        count: 1
      },
      {
        tier: 'clean',
        mode: 'twoPick',
        myClass: 'witch',
        oppoClass: 'elf',
        playOrder: 'first',
        result: 'win',
        count: 1
      }
    ])
  })

  it('sends a NULL mode as unknown, never folded into another mode', () => {
    const [bucket] = rollup([row({ mode: null })], NOW).at(-1)!.buckets
    expect(bucket.mode).toBe('unknown')
  })

  it('reports abandoned and manual rows as counts, not buckets', () => {
    const today = rollup([row({ result: null }), row({ source: 'manual' }), row()], NOW).at(-1)!
    expect(today.abandoned).toBe(1)
    expect(today.manual).toBe(1)
    expect(today.buckets).toHaveLength(1)
  })

  it('splits tiers so the server can choose which to trust', () => {
    const today = rollup(
      [row(), row({ source: null }), row({ edited_fields: '["result"]' })],
      NOW
    ).at(-1)!
    expect(today.buckets.map((b) => b.tier).sort()).toEqual(['clean', 'edited', 'legacy'])
  })

  it('ignores rows outside the window and drops invalid rows', () => {
    const days = rollup(
      [row({ playedAt: NOW - TELEMETRY_WINDOW_DAYS * DAY - HOUR }), row({ my_class: 'paladin' })],
      NOW
    )
    expect(days.every((d) => d.buckets.length === 0)).toBe(true)
  })

  it('files a match under the UTC day it was played', () => {
    const days = rollup([row({ playedAt: Date.parse('2026-08-31T23:59:00Z') })], NOW)
    const day = days.find((d) => d.buckets.length === 1)
    expect(day?.date).toBe('2026-08-31')
  })

  it('is deterministic: the same rows give the same bytes regardless of order', () => {
    const rows = [row({ result: 0 }), row({ mode: 'cpu' }), row(), row({ oppo_class: 'elf' })]
    const a = JSON.stringify(rollup(rows, NOW))
    const b = JSON.stringify(rollup([...rows].reverse(), NOW))
    expect(a).toBe(b)
  })

  it('never carries anything but the bucket dimensions and counts', () => {
    const today = rollup([row()], NOW).at(-1)!
    expect(Object.keys(today).sort()).toEqual(['abandoned', 'buckets', 'date', 'manual'])
    expect(Object.keys(today.buckets[0]).sort()).toEqual([
      'count',
      'mode',
      'myClass',
      'oppoClass',
      'playOrder',
      'result',
      'tier'
    ])
  })
})
