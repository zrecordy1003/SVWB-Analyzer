/**
 * The fold is a pure function over JSONL text, so it is tested as one: by what
 * must be true of any input, not by examples alone.
 */
import { describe, expect, it } from 'vitest'

import { foldJsonl } from '../../../server/sync/src/fold'

const HEADER = { device: 'd-1', seq: 9 }
const line = (o: object): string => JSON.stringify(o)
const doc = (...lines: object[]): string => lines.map(line).join('\n') + '\n'
const upsert = (tbl: string, uid: string, ts: number, extra: object = {}): object => ({
  tbl,
  uid,
  op: 'upsert',
  ts,
  row: { ts },
  ...extra
})

function parse(text: string): {
  header: Record<string, unknown>
  rows: Array<Record<string, unknown>>
} {
  const [head, ...rest] = text.trim().split('\n')
  return { header: JSON.parse(head), rows: rest.map((l) => JSON.parse(l)) }
}

/** Deterministic PRNG so a failing property is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomLines(seed: number, n: number, distinctTs = false): object[] {
  const r = rng(seed)
  const out: object[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      tbl: ['Match', 'Tag', 'Deck'][Math.floor(r() * 3)],
      uid: `u${Math.floor(r() * 6)}`,
      op: r() < 0.2 ? 'delete' : 'upsert',
      // Distinct timestamps when asked; otherwise a narrow range so ties happen.
      ts: distinctTs ? i * 7 + 1 : Math.floor(r() * 5),
      row: { i }
    })
  }
  return out
}

describe('foldJsonl', () => {
  it('keeps the highest ts per (tbl, uid)', () => {
    const out = foldJsonl(
      [
        doc(
          upsert('Match', 'a', 5),
          upsert('Match', 'a', 9),
          upsert('Match', 'a', 7),
          upsert('Tag', 'a', 1)
        )
      ],
      HEADER
    )
    const { rows } = parse(out.text)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.tbl === 'Match')!.ts).toBe(9)
    expect(out.lines).toBe(2)
  })

  it('on equal ts, the later line wins - within a text and across texts', () => {
    const a = foldJsonl(
      [
        doc(
          upsert('M', 'x', 5, { row: { v: 'first' } }),
          upsert('M', 'x', 5, { row: { v: 'second' } })
        )
      ],
      HEADER
    )
    expect(parse(a.text).rows[0].row).toEqual({ v: 'second' })
    const b = foldJsonl(
      [
        doc(upsert('M', 'x', 5, { row: { v: 'old text' } })),
        doc(upsert('M', 'x', 5, { row: { v: 'new text' } }))
      ],
      HEADER
    )
    expect(parse(b.text).rows[0].row).toEqual({ v: 'new text' })
  })

  it('keeps a delete as a tombstone when it is the newest, and drops the upsert it beat', () => {
    const out = foldJsonl(
      [doc(upsert('M', 'x', 5), { tbl: 'M', uid: 'x', op: 'delete', ts: 8 })],
      HEADER
    )
    expect(parse(out.text).rows).toEqual([{ tbl: 'M', uid: 'x', op: 'delete', ts: 8 }])
    // ...and a re-create after the delete wins over the tombstone.
    const back = foldJsonl(
      [doc({ tbl: 'M', uid: 'x', op: 'delete', ts: 8 }, upsert('M', 'x', 12))],
      HEADER
    )
    expect(parse(back.text).rows[0].op).toBe('upsert')
  })

  it('does not confuse keys whose parts could be concatenated into each other', () => {
    const out = foldJsonl(
      [doc(upsert('ab', 'c', 1), upsert('a', 'bc', 2), upsert('a\u0000b', 'c', 3))],
      HEADER
    )
    expect(parse(out.text).rows).toHaveLength(3)
  })

  it('writes one header: the device and seq it is given, the newest schemaVersion, an inherited hlc', () => {
    const out = foldJsonl(
      [
        doc({ v: 1, schemaVersion: 17, device: 'old', seq: 1, hlc: 100 }, upsert('M', 'a', 1)),
        doc({ v: 1, schemaVersion: 18, device: 'old', seq: 2, hlc: 200 }, upsert('M', 'b', 2)),
        doc({ v: 1, schemaVersion: 16, device: 'old', seq: 3, hlc: 300 })
      ],
      HEADER
    )
    const { header } = parse(out.text)
    expect(header).toEqual({ v: 1, schemaVersion: 18, device: 'd-1', seq: 9, hlc: 300 })
    expect(out.text.split('\n').filter((l) => l.includes('"v":1'))).toHaveLength(1)
  })

  it('synthesises a header when the input has none', () => {
    const out = foldJsonl([doc(upsert('M', 'a', 1))], HEADER)
    expect(parse(out.text).header).toEqual({ v: 1, device: 'd-1', seq: 9 })
  })

  it('drops lines it cannot key, and a torn last line, and says how many', () => {
    const text =
      doc(upsert('M', 'a', 1)) +
      'not json\n' +
      '[1,2]\n' +
      line({ tbl: 'M', uid: 'b' }) +
      '\n' + // no ts
      line({ tbl: 'M', uid: 'c', ts: 'soon' }) +
      '\n' +
      line({ tbl: 5, uid: 'c', ts: 1 }) +
      '\n' +
      line({ tbl: 'M', uid: '', ts: 1 }) +
      '\n' +
      '{"tbl":"M","uid":"torn","ts":'
    const out = foldJsonl([text], HEADER)
    expect(parse(out.text).rows).toHaveLength(1)
    expect(out.dropped).toBe(7)
  })

  it('tolerates CRLF and blank lines', () => {
    const text = doc(upsert('M', 'a', 1), upsert('M', 'a', 2)).replace(/\n/g, '\r\n') + '\r\n\r\n'
    expect(parse(foldJsonl([text], HEADER).text).rows).toHaveLength(1)
  })

  it('folds nothing into just a header', () => {
    const out = foldJsonl([], HEADER)
    expect(out.lines).toBe(0)
    expect(out.text).toBe('{"v":1,"device":"d-1","seq":9}\n')
  })

  describe('properties', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => i + 1)

    it.each(seeds)(
      'seed %i: one survivor per key, and it is the max ts (later wins ties)',
      (seed) => {
        const lines = randomLines(seed, 60)
        const out = parse(foldJsonl([doc(...lines)], HEADER).text)
        const expected = new Map<string, object>()
        for (const l of lines as Array<{ tbl: string; uid: string; ts: number }>) {
          const key = `${l.tbl}/${l.uid}`
          const cur = expected.get(key) as { ts: number } | undefined
          if (!cur || l.ts >= cur.ts) expected.set(key, l)
        }
        expect(out.rows).toHaveLength(expected.size)
        for (const row of out.rows as Array<{ tbl: string; uid: string }>) {
          expect(row).toEqual(expected.get(`${row.tbl}/${row.uid}`))
        }
      }
    )

    it.each(seeds)('seed %i: idempotent', (seed) => {
      const once = foldJsonl([doc(...randomLines(seed, 50))], HEADER).text
      expect(foldJsonl([once], HEADER).text).toBe(once)
    })

    it.each(seeds)('seed %i: folding in pieces equals folding the whole', (seed) => {
      const lines = randomLines(seed, 50)
      const whole = foldJsonl([doc(...lines)], HEADER).text
      const left = foldJsonl([doc(...lines.slice(0, 20))], HEADER).text
      const right = foldJsonl([doc(...lines.slice(20))], HEADER).text
      // The snapshot goes first and the segments after, exactly as the cron feeds it.
      expect(foldJsonl([left, right], HEADER).text).toBe(whole)
    })

    it.each(seeds)('seed %i: with distinct timestamps, input order does not matter', (seed) => {
      const lines = randomLines(seed, 40, true)
      const shuffled = [...lines].sort(() => rng(seed)() - 0.5)
      const reversed = [...lines].reverse()
      const base = foldJsonl([doc(...lines)], HEADER).text
      expect(foldJsonl([doc(...shuffled)], HEADER).text).toBe(base)
      expect(foldJsonl([doc(...reversed)], HEADER).text).toBe(base)
    })

    it.each(seeds)('seed %i: output is sorted by ts and every line is valid JSON', (seed) => {
      const { rows } = parse(foldJsonl([doc(...randomLines(seed, 50))], HEADER).text)
      const ts = rows.map((r) => r.ts as number)
      expect(ts).toEqual([...ts].sort((a, b) => a - b))
    })
  })
})
