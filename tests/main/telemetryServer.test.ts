/**
 * The Worker's pure parts, tested here so the server's whitelist and the
 * client's rollup are checked against the same constants in one run.
 */
import { describe, expect, it } from 'vitest'
import { buildMeta, buildOverview, lastDates } from '../../server/telemetry/src/aggregate'
import { validatePayload } from '../../server/telemetry/src/validate'
import { rollup, type RollupRow } from '../../src/main/telemetry/rollup'
import { TELEMETRY_MAX_MATCHES_PER_DAY } from '../../src/shared/telemetry'

const NOW = new Date('2026-09-02T10:00:00Z')
const INSTALL = '6f0d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b'

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    installId: INSTALL,
    appVersion: '1.3.0',
    platform: 'win32',
    arch: 'x64',
    locale: 'zh-TW',
    sentAt: NOW.toISOString(),
    days: [
      {
        date: '2026-09-02',
        abandoned: 1,
        manual: 0,
        buckets: [
          {
            tier: 'clean',
            mode: 'ranked',
            myClass: 'witch',
            oppoClass: 'dragon',
            playOrder: 'first',
            result: 'win',
            count: 3
          }
        ]
      }
    ],
    ...overrides
  }
}

describe('validatePayload', () => {
  it('accepts what the client actually produces', () => {
    const rows: RollupRow[] = [
      {
        result: 1,
        play_order: 'first',
        my_class: 'witch',
        oppo_class: 'dragon',
        mode: 'ranked',
        playedAt: NOW.getTime() - 60_000,
        source: 'engine',
        edited_fields: null,
        recog_flags: null
      },
      {
        result: null,
        play_order: 'second',
        my_class: 'elf',
        oppo_class: 'elf',
        mode: null,
        playedAt: NOW.getTime() - 120_000,
        source: null,
        edited_fields: null,
        recog_flags: null
      }
    ]
    const verdict = validatePayload(payload({ days: rollup(rows, NOW.getTime()) }), NOW)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.days).toHaveLength(14)
    expect(verdict.value.rejected).toEqual([])
    const today = verdict.value.days.at(-1)!
    expect(today.matches).toBe(1)
    expect(today.abandoned).toBe(1)
  })

  it('refuses a payload that is not the right shape at all', () => {
    for (const bad of [
      null,
      [],
      payload({ schema: 2 }),
      payload({ installId: 'not-a-uuid' }),
      payload({ appVersion: '1.3' }),
      payload({ platform: 'win 32' }),
      payload({ locale: 'a'.repeat(40) }),
      payload({ days: 'today' }),
      payload({ days: new Array(20).fill({}) })
    ]) {
      const verdict = validatePayload(bad, NOW)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.status).toBe(400)
    }
  })

  it('lower-cases the install id so one machine cannot be two rows', () => {
    const verdict = validatePayload(payload({ installId: INSTALL.toUpperCase() }), NOW)
    expect(verdict.ok && verdict.value.installId).toBe(INSTALL)
  })

  it('rejects a bad day and keeps the good ones', () => {
    const good = (payload().days as unknown[])[0]
    const verdict = validatePayload(
      payload({
        days: [
          good,
          { date: '2026-13-40', abandoned: 0, manual: 0, buckets: [] },
          { date: '2026-07-01', abandoned: 0, manual: 0, buckets: [] },
          { date: '2026-09-05', abandoned: 0, manual: 0, buckets: [] },
          { date: '2026-09-01', abandoned: 0, manual: 0, buckets: [{ tier: 'gold' }] },
          { date: '2026-09-02', abandoned: 0, manual: 0, buckets: [] }
        ]
      }),
      NOW
    )
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.days.map((d) => d.date)).toEqual(['2026-09-02'])
    expect(verdict.value.rejected.map((r) => [r.date, r.reason])).toEqual([
      ['2026-13-40', 'bad date'],
      ['2026-07-01', 'too old'],
      ['2026-09-05', 'in the future'],
      ['2026-09-01', 'unknown tier gold'],
      ['2026-09-02', 'duplicate date']
    ])
  })

  it('tolerates a client clock one day ahead', () => {
    const verdict = validatePayload(
      payload({ days: [{ date: '2026-09-03', abandoned: 0, manual: 0, buckets: [] }] }),
      NOW
    )
    expect(verdict.ok && verdict.value.days).toHaveLength(1)
  })

  it('refuses a day that claims more matches than a person can play', () => {
    const bucket = (payload().days as any[])[0].buckets[0]
    const verdict = validatePayload(
      payload({
        days: [
          {
            date: '2026-09-02',
            abandoned: 0,
            manual: 0,
            buckets: [{ ...bucket, count: TELEMETRY_MAX_MATCHES_PER_DAY }]
          },
          {
            date: '2026-09-01',
            abandoned: 1,
            manual: 0,
            buckets: [{ ...bucket, count: TELEMETRY_MAX_MATCHES_PER_DAY }]
          }
        ]
      }),
      NOW
    )
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.value.days.map((d) => d.date)).toEqual(['2026-09-02'])
    expect(verdict.value.rejected[0].reason).toBe('too many matches for one day')
  })

  it('refuses duplicate buckets, zero counts and unknown enum values', () => {
    const bucket = (payload().days as any[])[0].buckets[0]
    const cases: Array<[unknown[], string]> = [
      [[bucket, bucket], 'duplicate bucket'],
      [[{ ...bucket, count: 0 }], 'bad count 0'],
      [[{ ...bucket, count: 1.5 }], 'bad count 1.5'],
      [[{ ...bucket, mode: 'arena' }], 'unknown mode arena'],
      [[{ ...bucket, myClass: 'paladin' }], 'unknown class paladin'],
      [[{ ...bucket, playOrder: 'third' }], 'unknown play order third'],
      [[{ ...bucket, result: 'draw' }], 'unknown result draw']
    ]
    for (const [buckets, reason] of cases) {
      const verdict = validatePayload(
        payload({ days: [{ date: '2026-09-02', abandoned: 0, manual: 0, buckets }] }),
        NOW
      )
      expect(verdict.ok).toBe(true)
      if (verdict.ok) expect(verdict.value.rejected[0]?.reason).toBe(reason)
    }
  })
})

describe('buildMeta', () => {
  it('folds win/loss rows into cells and per-class totals', () => {
    const doc = buildMeta(
      [
        { my_class: 'witch', oppo_class: 'dragon', play_order: 'first', result: 'win', n: 7 },
        { my_class: 'witch', oppo_class: 'dragon', play_order: 'first', result: 'loss', n: 3 },
        { my_class: 'witch', oppo_class: 'elf', play_order: 'second', result: 'loss', n: 2 },
        { my_class: 'elf', oppo_class: 'witch', play_order: 'first', result: 'win', n: 1 }
      ],
      { installs: 4, since: '2026-08-20', days: 14, mode: 'ranked', tiers: ['clean'], now: NOW }
    )
    expect(doc.matches).toBe(13)
    expect(doc.installs).toBe(4)
    expect(doc.cells).toEqual([
      { myClass: 'elf', oppoClass: 'witch', playOrder: 'first', wins: 1, total: 1 },
      { myClass: 'witch', oppoClass: 'dragon', playOrder: 'first', wins: 7, total: 10 },
      { myClass: 'witch', oppoClass: 'elf', playOrder: 'second', wins: 0, total: 2 }
    ])
    expect(doc.byClass).toEqual([
      { myClass: 'elf', wins: 1, total: 1 },
      { myClass: 'witch', wins: 7, total: 12 }
    ])
  })
})

describe('buildOverview', () => {
  it('fills the daily series with zeros and merges the version splits', () => {
    const doc = buildOverview({
      now: NOW,
      activeToday: 3,
      active7d: 10,
      active30d: 25,
      installs: 40,
      versions7d: [{ app_version: '1.3.0', installs: 8 }],
      versions30d: [
        { app_version: '1.3.0', installs: 15 },
        { app_version: '1.2.0', installs: 10 }
      ],
      platforms30d: [{ platform: 'win32', installs: 25 }],
      activity: [{ date: '2026-09-02', installs: 3 }],
      // One inside the 7-day window, one only inside the 30-day one, and one
      // older than the series - the third must not reach either total.
      newInstalls: [
        { date: '2026-09-01', installs: 2 },
        { date: '2026-08-20', installs: 5 },
        { date: '2026-07-01', installs: 99 }
      ],
      matchDays: [{ date: '2026-09-01', installs: 2, matches: 9, abandoned: 1, manual: 0 }],
      tiers: [
        { tier: 'clean', n: 8 },
        { tier: 'legacy', n: 1 }
      ],
      modes: [{ mode: 'ranked', n: 9 }]
    })
    expect(doc.today).toBe('2026-09-02')
    expect(doc.active).toEqual({ today: 3, last7d: 10, last30d: 25 })
    expect(doc.versions).toEqual([
      { appVersion: '1.3.0', active7d: 8, active30d: 15 },
      { appVersion: '1.2.0', active7d: 0, active30d: 10 }
    ])
    expect(doc.series).toHaveLength(30)
    expect(doc.series.at(-1)).toEqual({
      date: '2026-09-02',
      activeInstalls: 3,
      recordingInstalls: 0,
      newInstalls: 0,
      matches: 0,
      abandoned: 0,
      manual: 0
    })
    expect(doc.series.at(-2)).toMatchObject({
      date: '2026-09-01',
      matches: 9,
      abandoned: 1,
      newInstalls: 2
    })
    // 7d is the last seven series days (2026-08-27..09-02), so the 08-20 row
    // counts only towards 30d and the 07-01 row towards neither: it is outside
    // the series the totals are summed from.
    expect(doc.newInstalls).toEqual({ last7d: 2, last30d: 7 })
    expect(doc.matchesLast30d).toEqual({
      total: 9,
      byTier: { clean: 8, legacy: 1 },
      byMode: { ranked: 9 }
    })
  })

  it('lastDates runs oldest to newest and ends today', () => {
    const dates = lastDates(NOW, 3)
    expect(dates).toEqual(['2026-08-31', '2026-09-01', '2026-09-02'])
  })
})
