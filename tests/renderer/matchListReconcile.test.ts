import { describe, expect, it } from 'vitest'

import { reconcileRecent } from '../../src/renderer/src/components/MatchList/hooks/useInfiniteMatches'

const CHUNK = 3

/**
 * Only the fields the reconciliation reads.
 *
 * This used to build a whole match row and finish with `as MatchRow`, and the
 * cast had been wrong since migration 008 added the provenance columns - the
 * object was missing six required fields. It survived because `tests/` was not
 * type-checked; `tsconfig.tests.json` now catches exactly this.
 *
 * `reconcileRecent` is generic over `{ id, playedAt }` for the same reason, so
 * this is the honest shape rather than a narrower cast.
 */
type Row = { id: number; playedAt: Date; result: boolean | null }

function row(id: number, playedAt: string, result: boolean | null = null): Row {
  return { id, playedAt: new Date(playedAt), result }
}

const ids = (rows: Row[]): number[] => rows.map((r) => r.id)

describe('reconcileRecent', () => {
  it('replaces a held row with its updated version', () => {
    // The reported bug: the engine opens a row with result null, then fills the
    // result in on the same row. Prepend-only refreshes kept showing 未定.
    const held = [row(3, '2026-08-29T12:00:00Z', null), row(2, '2026-08-29T11:00:00Z', true)]
    const chunk = [row(3, '2026-08-29T12:00:00Z', true), row(2, '2026-08-29T11:00:00Z', true)]

    const next = reconcileRecent(held, chunk, CHUNK)

    expect(ids(next)).toEqual([3, 2])
    expect(next[0].result).toBe(true)
  })

  it('prepends a match that was not held before', () => {
    const held = [row(2, '2026-08-29T11:00:00Z')]
    const chunk = [row(3, '2026-08-29T12:00:00Z'), row(2, '2026-08-29T11:00:00Z')]

    expect(ids(reconcileRecent(held, chunk, CHUNK))).toEqual([3, 2])
  })

  it('drops a row the query no longer returns', () => {
    // matchAbandoned: the engine deletes the row a replay opened, so it must
    // leave the list rather than linger as a phantom entry.
    const held = [row(3, '2026-08-29T12:00:00Z'), row(2, '2026-08-29T11:00:00Z')]
    const chunk = [row(2, '2026-08-29T11:00:00Z')]

    expect(ids(reconcileRecent(held, chunk, CHUNK))).toEqual([2])
  })

  it('empties the list when the last match is deleted', () => {
    expect(reconcileRecent([row(1, '2026-08-29T10:00:00Z')], [], CHUNK)).toEqual([])
  })

  it('keeps scrolled-in older rows that the page never covered', () => {
    // A full chunk means there may be more below it, so rows older than the
    // chunk's oldest are outside the window and must survive untouched.
    const held = [
      row(5, '2026-08-29T15:00:00Z'),
      row(4, '2026-08-29T14:00:00Z'),
      row(3, '2026-08-29T13:00:00Z'),
      row(2, '2026-08-29T12:00:00Z'),
      row(1, '2026-08-29T11:00:00Z')
    ]
    const chunk = [
      row(5, '2026-08-29T15:00:00Z'),
      row(4, '2026-08-29T14:00:00Z'),
      row(3, '2026-08-29T13:00:00Z')
    ]

    expect(ids(reconcileRecent(held, chunk, CHUNK))).toEqual([5, 4, 3, 2, 1])
  })

  it('does not mistake a page-limit cutoff at the boundary for a deletion', () => {
    // Row 3 shares the chunk's oldest timestamp and was cut off by the limit.
    // Showing it one refresh too long beats dropping a match that still exists.
    const held = [
      row(5, '2026-08-29T15:00:00Z'),
      row(4, '2026-08-29T13:00:00Z'),
      row(3, '2026-08-29T13:00:00Z')
    ]
    const chunk = [
      row(6, '2026-08-29T16:00:00Z'),
      row(5, '2026-08-29T15:00:00Z'),
      row(4, '2026-08-29T13:00:00Z')
    ]

    expect(ids(reconcileRecent(held, chunk, CHUNK))).toEqual([6, 5, 4, 3])
  })

  it('never returns the same id twice', () => {
    const held = [row(2, '2026-08-29T11:00:00Z'), row(1, '2026-08-29T10:00:00Z')]
    const chunk = [row(2, '2026-08-29T11:00:00Z'), row(1, '2026-08-29T10:00:00Z')]

    const next = reconcileRecent(held, chunk, CHUNK)
    expect(new Set(ids(next)).size).toBe(next.length)
  })
})
