/**
 * Pre-mulligan hands in, counting buckets out.
 *
 * The rules worth pinning here are the ones that cannot be fixed later. A
 * bucket that arrives without its rest-of-hand band can never have one added -
 * the band is computed from the hand and the hand is never uploaded - so
 * "which observations produce a bucket, and what is in its key" is a decision
 * this file exists to hold still.
 *
 * The unit is a COPY, not a match. That is the other thing a future change
 * could quietly break: if this ever started counting hands, the cloud numbers
 * would stop being comparable with the local advisor's, which counts copies.
 */
import { describe, expect, it } from 'vitest'

import {
  openingBucketsByDate,
  rollup,
  type OpeningMatchRow,
  type OpeningSlotRow
} from '../../src/main/telemetry/rollup'
import { validatePayload } from '../../server/telemetry/src/validate'
import { TELEMETRY_SCHEMA } from '../../src/shared/telemetry'

const NOW = Date.UTC(2026, 8, 2, 12)
const PLAYED = Date.UTC(2026, 8, 2, 9)
const DATE = '2026-09-02'

function match(over: Partial<OpeningMatchRow> = {}): OpeningMatchRow {
  return {
    id: 1,
    result: 1,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    playedAt: PLAYED,
    source: 'engine',
    current_cr: null,
    edited_fields: null,
    recog_flags: null,
    ...over
  } as OpeningMatchRow
}

/** A four-card hand at the given costs; `swapped` is a mask of the same length. */
function hand(
  matchId: number,
  cards: number[],
  costs: (number | null)[],
  swapped: boolean[]
): OpeningSlotRow[] {
  return cards.map((cardId, i) => ({ matchId, cardId, cost: costs[i], swapped: swapped[i] }))
}

const buckets = (m: OpeningMatchRow[], s: OpeningSlotRow[], now = NOW) =>
  openingBucketsByDate(m, s, now).get(DATE) ?? []

const FOUR_ONES = (id = 1) =>
  hand(id, [101, 102, 103, 104], [1, 1, 1, 1], [false, false, false, false])

describe('openingBucketsByDate', () => {
  it('counts a copy per slot, banded on the OTHER three cards', () => {
    // Costs 1,1,1,8. For the 8-drop the other three average 1.0 -> band 0;
    // for each 1-drop the others average (1+1+8)/3 = 3.33 -> band 1.
    const rows = buckets(
      [match()],
      hand(1, [101, 102, 103, 900], [1, 1, 1, 8], [false, false, false, true])
    )
    expect(rows).toHaveLength(4)
    expect(rows.find((r) => r.cardId === 900)).toMatchObject({
      kept: false,
      restBand: 0,
      result: 'win',
      count: 1
    })
    for (const id of [101, 102, 103]) {
      expect(rows.find((r) => r.cardId === id)).toMatchObject({ kept: true, restBand: 1 })
    }
  })

  it('merges two copies of one card into a single row with count 2', () => {
    const rows = buckets(
      [match()],
      hand(1, [101, 101, 103, 104], [2, 2, 2, 2], [false, false, false, false])
    )
    expect(rows.find((r) => r.cardId === 101)?.count).toBe(2)
    expect(rows).toHaveLength(3)
  })

  it('keeps a copy whose companion has no known cost, with a null band', () => {
    // The three priced cards each have the unpriced one as a companion and so
    // cannot be banded; the unpriced card itself can, because ITS three
    // companions are all priced. Dropping them instead would make the cloud
    // estimate differ from the local one on exactly the newest cards.
    const rows = buckets(
      [match()],
      hand(1, [101, 102, 103, 104], [1, 1, 1, null], [false, false, false, false])
    )
    expect(rows).toHaveLength(4)
    expect(rows.find((r) => r.cardId === 104)?.restBand).toBe(0)
    for (const id of [101, 102, 103]) {
      expect(rows.find((r) => r.cardId === id)?.restBand).toBeNull()
    }
  })

  it('drops a hand with an unnamed slot entirely, not just that slot', () => {
    const slots = FOUR_ONES()
    slots[2].cardId = null
    expect(buckets([match()], slots)).toHaveLength(0)
  })

  it('drops a hand that is not four slots', () => {
    expect(buckets([match()], hand(1, [101, 102, 103], [1, 1, 1], [false, false, false]))).toEqual(
      []
    )
  })

  it('drops a match with no result, and one a person typed in', () => {
    expect(buckets([match({ result: null })], FOUR_ONES())).toHaveLength(0)
    expect(buckets([match({ source: 'manual' })], FOUR_ONES())).toHaveLength(0)
  })

  it('drops a match this build did not write, the way the match buckets do', () => {
    // The seeder's rows. `classifyRow` fails closed on an unknown source, and
    // this half has to fail closed with it or fabricated hands upload - which
    // is the mistake that already happened once with the match buckets.
    expect(buckets([match({ source: 'demo-seed' })], FOUR_ONES())).toHaveLength(0)
  })

  it('carries the tier, so an edited match stays distinguishable downstream', () => {
    const rows = buckets([match({ edited_fields: '["result"]' })], FOUR_ONES())
    expect(rows[0]?.tier).toBe('edited')
  })

  it('ignores a match outside the window', () => {
    const old = match({ playedAt: Date.UTC(2026, 6, 1) })
    expect(openingBucketsByDate([old], FOUR_ONES(), NOW).size).toBe(0)
  })

  it('is byte-stable however the slots arrive', () => {
    // `content_hash` on the server skips a day whose bytes have not changed.
    // If slot order could reorder the output, every upload would rewrite the
    // whole window again - the exact bug that blew the D1 write budget.
    const forward = hand(1, [104, 103, 102, 101], [4, 3, 2, 1], [true, false, true, false])
    const backward = [...forward].reverse()
    expect(JSON.stringify(buckets([match()], backward))).toBe(
      JSON.stringify(buckets([match()], forward))
    )
  })
})

describe('rollup, with and without hands', () => {
  it('omits the field entirely when no opening data was passed', () => {
    for (const day of rollup([match()], NOW)) {
      expect(day).not.toHaveProperty('openingBuckets')
    }
  })

  it('gives every day the field once opening data is passed, empty days included', () => {
    const days = rollup([match()], NOW, openingBucketsByDate([match()], FOUR_ONES(), NOW))
    expect(days.every((d) => Array.isArray(d.openingBuckets))).toBe(true)
    expect(days.find((d) => d.date === DATE)?.openingBuckets).toHaveLength(4)
    // A day nobody played: carried, and empty. Not the same as absent.
    expect(days.find((d) => d.date !== DATE)?.openingBuckets).toEqual([])
  })
})

describe('what the client builds, through the real server validator', () => {
  const envelope = {
    installId: '22656b3c-98cf-4011-b45f-0577eb409c26',
    appVersion: '1.4.0',
    platform: 'win32',
    arch: 'x64',
    locale: 'zh-TW'
  }

  it('round-trips unchanged', () => {
    const slots = hand(1, [101, 101, 103, 900], [2, 2, 3, 8], [false, true, false, true])
    const days = rollup([match()], NOW, openingBucketsByDate([match()], slots, NOW))
    const verdict = validatePayload(
      JSON.parse(JSON.stringify({ schema: TELEMETRY_SCHEMA, ...envelope, days })),
      new Date(NOW)
    )
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.rejected).toEqual([])
    expect(verdict.value.days.find((d) => d.date === DATE)?.openingBuckets).toEqual(
      days.find((d) => d.date === DATE)?.openingBuckets
    )
  })

  it('reads a schema-2 day as "no statement", not as "no hands"', () => {
    // An install that has not updated must not look like a player whose hands
    // stopped being recorded - the server leaves stored rows alone on null and
    // replaces them on [].
    const verdict = validatePayload(
      { schema: 2, ...envelope, days: rollup([match()], NOW) },
      new Date(NOW)
    )
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.days.every((d) => d.openingBuckets === null)).toBe(true)
  })

  it('refuses a band the client could not have produced', () => {
    const days = rollup([match()], NOW, openingBucketsByDate([match()], FOUR_ONES(), NOW))
    const today = days.find((d) => d.date === DATE)!
    today.openingBuckets![0].restBand = 9
    const verdict = validatePayload({ schema: TELEMETRY_SCHEMA, ...envelope, days }, new Date(NOW))
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.rejected.map((r) => r.date)).toContain(DATE)
  })

  it('refuses two rows that are the same bucket', () => {
    const days = rollup([match()], NOW, openingBucketsByDate([match()], FOUR_ONES(), NOW))
    const today = days.find((d) => d.date === DATE)!
    today.openingBuckets!.push({ ...today.openingBuckets![0] })
    const verdict = validatePayload({ schema: TELEMETRY_SCHEMA, ...envelope, days }, new Date(NOW))
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.rejected.map((r) => r.reason)).toContain('duplicate opening bucket')
  })

  it('refuses more copies than the day has matches to hold', () => {
    const days = rollup([match()], NOW, openingBucketsByDate([match()], FOUR_ONES(), NOW))
    const today = days.find((d) => d.date === DATE)!
    // One match can hold four copies. Claiming forty says the client is not
    // counting copies, whatever else the row looks like.
    today.openingBuckets![0].count = 40
    const verdict = validatePayload({ schema: TELEMETRY_SCHEMA, ...envelope, days }, new Date(NOW))
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.rejected.map((r) => r.reason)).toContain(
      'more opening copies than the day has matches for'
    )
  })
})
