/**
 * The rules that decide who wins, and the file format, with no database in sight.
 *
 * These are the places where a mistake is silent data loss, so they are a table
 * of inputs and outputs. The property they must add up to - every machine ends
 * in the same state whatever the order - is `syncEngine.test.ts`'s last block.
 */
import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  nameWinner,
  nextTs,
  pickDefault,
  remoteWins,
  resolveAlias,
  type Version
} from '../../src/main/sync/merge'
import {
  MAX_SEGMENT_BYTES,
  MAX_SEGMENT_ENTRIES,
  SEGMENT_FORMAT,
  parseSegment,
  serializeSegment,
  splitEntries,
  type Entry,
  type SegmentHeader
} from '../../src/main/sync/segment'

const v = (ts: number, device: string, deleted = false): Version => ({ ts, device, deleted })

describe('who wins', () => {
  it('the later change wins, whichever side it is on', () => {
    expect(remoteWins(v(10, 'a'), v(11, 'b'))).toBe(true)
    expect(remoteWins(v(11, 'a'), v(10, 'b'))).toBe(false)
  })

  it('an unknown row is always taken', () => {
    expect(remoteWins(null, v(1, 'b'))).toBe(true)
  })

  it('the same change seen twice is not applied twice', () => {
    expect(remoteWins(v(10, 'b'), v(10, 'b'))).toBe(false)
  })

  it('a tie in time is broken by device id - identically from either side', () => {
    const x = v(10, 'a')
    const y = v(10, 'b')
    expect(remoteWins(x, y)).toBe(true)
    expect(remoteWins(y, x)).toBe(false)
    // Antisymmetric: exactly one of the two orders prefers the other.
    expect(compareVersions(x, y)).toBe(-compareVersions(y, x))
  })

  it('a deletion is a version like any other: newer wins in both directions', () => {
    expect(remoteWins(v(10, 'a'), v(11, 'b', true))).toBe(true) // delete after edit: gone
    expect(remoteWins(v(11, 'a', true), v(10, 'b'))).toBe(false) // edit before delete: stays gone
    expect(remoteWins(v(10, 'a', true), v(11, 'b'))).toBe(true) // edit after delete: back
  })
})

describe('the clock', () => {
  it('uses when the user acted, not when it was uploaded', () => {
    expect(nextTs(5_000, 1_000)).toBe(5_000)
  })

  it('never goes backwards, and never repeats', () => {
    expect(nextTs(5_000, 9_000)).toBe(9_001)
    expect(nextTs(5_000, 5_000)).toBe(5_001)
  })

  it('a run of changes in the same millisecond gets distinct, ordered stamps', () => {
    let hw = 0
    const stamps: number[] = []
    for (let i = 0; i < 5; i++) {
      hw = nextTs(100, hw)
      stamps.push(hw)
    }
    expect(stamps).toEqual([100, 101, 102, 103, 104])
  })
})

describe('names and aliases', () => {
  it('the smaller uid keeps the name, from either side', () => {
    expect(nameWinner('a1', 'b2')).toBe('a1')
    expect(nameWinner('b2', 'a1')).toBe('a1')
  })

  it('aliases are followed to the end of a chain, and a loop does not hang', () => {
    expect(
      resolveAlias(
        new Map([
          ['c', 'b'],
          ['b', 'a']
        ]),
        'c'
      )
    ).toBe('a')
    expect(resolveAlias(new Map(), 'x')).toBe('x')
    const loop = new Map([
      ['a', 'b'],
      ['b', 'a']
    ])
    expect(['a', 'b']).toContain(resolveAlias(loop, 'a'))
  })

  it('the default deck is the one set last, with uid as the tiebreak', () => {
    expect(
      pickDefault([
        { uid: 'x', ts: 1 },
        { uid: 'y', ts: 2 }
      ]).uid
    ).toBe('y')
    expect(
      pickDefault([
        { uid: 'x', ts: 2 },
        { uid: 'y', ts: 2 }
      ]).uid
    ).toBe('y')
    expect(
      pickDefault([
        { uid: 'y', ts: 2 },
        { uid: 'x', ts: 2 }
      ]).uid
    ).toBe('y')
    expect(() => pickDefault([])).toThrow()
  })
})

const header: SegmentHeader = {
  v: SEGMENT_FORMAT,
  schemaVersion: 18,
  device: 'd-1',
  seq: 3,
  hlc: 99
}
const upsert = (uid: string, extra: Partial<Entry> = {}): Entry => ({
  tbl: 'Match',
  uid,
  op: 'upsert',
  ts: 1,
  row: { note: 'hi' },
  ...extra
})

describe('segments', () => {
  it('round-trips, including multibyte text', () => {
    const entries = [
      upsert('a', { row: { note: '對局備註 🎴' }, tagUids: ['t'] }),
      { tbl: 'Tag', uid: 't', op: 'delete', ts: 2 } as Entry
    ]
    const parsed = parseSegment(serializeSegment(header, entries))
    expect(parsed?.header).toEqual(header)
    expect(parsed?.entries).toEqual(entries)
    expect(parsed?.skipped).toBe(0)
  })

  it('a torn last line costs that line, not the file', () => {
    const text = serializeSegment(header, [upsert('a'), upsert('b')])
    const parsed = parseSegment(text.slice(0, text.length - 10))
    expect(parsed?.entries.map((e) => e.uid)).toEqual(['a'])
    expect(parsed?.skipped).toBe(1)
  })

  it('without a readable header nothing can be applied', () => {
    expect(parseSegment('')).toBeNull()
    expect(parseSegment('not json\n{"tbl":"Match"}')).toBeNull()
    expect(parseSegment(JSON.stringify({ ...header, v: 2 }) + '\n')).toBeNull()
    expect(parseSegment(JSON.stringify({ ...header, device: '' }) + '\n')).toBeNull()
  })

  it('refuses entries that are not what they claim, rather than applying them', () => {
    const lines = [
      JSON.stringify(header),
      JSON.stringify({ tbl: 'Secrets', uid: 'x', op: 'upsert', ts: 1, row: {} }),
      JSON.stringify({ tbl: 'Match', uid: '', op: 'upsert', ts: 1, row: {} }),
      JSON.stringify({ tbl: 'Match', uid: 'x', op: 'nuke', ts: 1 }),
      JSON.stringify({ tbl: 'Match', uid: 'x', op: 'upsert', ts: 'soon', row: {} }),
      JSON.stringify({ tbl: 'Match', uid: 'x', op: 'upsert', ts: 1 }),
      JSON.stringify({ tbl: 'Match', uid: 'ok', op: 'upsert', ts: 1, row: {} })
    ]
    const parsed = parseSegment(lines.join('\n'))
    expect(parsed?.entries.map((e) => e.uid)).toEqual(['ok'])
    expect(parsed?.skipped).toBe(5)
  })

  it('splits by count and by size, loses nothing, and keeps order', () => {
    const many = Array.from({ length: MAX_SEGMENT_ENTRIES * 2 + 5 }, (_, i) => upsert(`m${i}`))
    const parts = splitEntries(many)
    expect(parts.map((p) => p.length)).toEqual([MAX_SEGMENT_ENTRIES, MAX_SEGMENT_ENTRIES, 5])
    expect(parts.flat().map((e) => e.uid)).toEqual(many.map((e) => e.uid))

    const big = 'x'.repeat(MAX_SEGMENT_BYTES / 3)
    const sized = Array.from({ length: 7 }, (_, i) => upsert(`b${i}`, { row: { note: big } }))
    const bySize = splitEntries(sized)
    expect(bySize.length).toBeGreaterThan(1)
    expect(bySize.flat()).toHaveLength(7)
  })

  it('an entry too big for any segment still gets one to itself', () => {
    const huge = upsert('h', { row: { note: 'x'.repeat(MAX_SEGMENT_BYTES * 2) } })
    expect(splitEntries([upsert('a'), huge, upsert('b')]).map((p) => p.length)).toEqual([1, 1, 1])
  })

  it('an empty list makes no segments', () => {
    expect(splitEntries([])).toEqual([])
  })
})
