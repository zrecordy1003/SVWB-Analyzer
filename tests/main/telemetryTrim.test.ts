/**
 * What gets dropped when a payload will not fit, and in what order.
 *
 * The server refuses an oversized body, so a client that keeps producing one
 * never uploads again - a 413 every time, and nothing on the user's screen to
 * say so. This is the valve. It is worth its own file because both of its
 * properties are invisible in normal use and both matter:
 *
 * - the MATCH buckets are never dropped, so the heartbeat and the metagame
 *   aggregate survive whatever the hands cost;
 * - the oldest days go first, because those days were already uploaded whole
 *   when they were recent, and the server leaves a stored day alone when the
 *   client says nothing about its hands.
 *
 * Dropping every day's hands at once would be simpler and is the wrong shape:
 * it silences the players with the most matches, who are exactly the ones the
 * cross-player estimate needs.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
  app: { getVersion: () => '1.4.0', getLocale: () => 'zh-TW', isPackaged: true },
  net: { fetch: vi.fn() }
}))

// `telemetry.ts` reaches `store.ts`, which builds an ElectronStore at module
// scope and needs an app name that only a running Electron has.
vi.mock('../../src/main/store.js', () => ({
  store: { get: () => undefined, set: () => undefined }
}))

const { trimToBudget } = await import('../../src/main/telemetry/telemetry')
import type { TelemetryDay, TelemetryOpeningBucket } from '../../src/shared/telemetry'

const opening = (cardId: number): TelemetryOpeningBucket => ({
  tier: 'clean',
  mode: 'ranked',
  myClass: 'witch',
  oppoClass: 'dragon',
  playOrder: 'first',
  cardId,
  kept: true,
  restBand: 1,
  result: 'win',
  count: 1
})

/** Five days, oldest first, each carrying `rows` opening buckets. */
function days(rows: number): TelemetryDay[] {
  return ['09-01', '09-02', '09-03', '09-04', '09-05'].map((d) => ({
    date: `2026-${d}`,
    abandoned: 0,
    manual: 0,
    buckets: [
      {
        tier: 'clean',
        mode: 'ranked',
        myClass: 'witch',
        oppoClass: 'dragon',
        playOrder: 'first',
        crBand: 'unknown',
        result: 'win',
        count: 3
      }
    ],
    openingBuckets: Array.from({ length: rows }, (_, i) => opening(10031000 + i))
  }))
}

describe('trimToBudget', () => {
  it('changes nothing when it already fits', () => {
    const input = days(4)
    const before = JSON.stringify(input)
    expect(JSON.stringify(trimToBudget(input, 1_000_000))).toBe(before)
  })

  it('drops the oldest days first and stops as soon as it fits', () => {
    const input = days(10)
    const full = JSON.stringify(input).length
    // A budget that forces roughly the first two days to go.
    const trimmed = trimToBudget(input, Math.floor(full * 0.65))
    expect(trimmed[0].openingBuckets).toBeUndefined()
    // The newest day is the last one it would ever give up.
    expect(trimmed.at(-1)?.openingBuckets).toBeDefined()
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(Math.floor(full * 0.65))
  })

  it('never drops a match bucket, however small the budget', () => {
    const input = days(10)
    const trimmed = trimToBudget(input, 1)
    expect(trimmed.every((d) => d.buckets.length === 1)).toBe(true)
    expect(trimmed.every((d) => d.openingBuckets === undefined)).toBe(true)
  })

  it('omits the field rather than emptying it', () => {
    // `[]` means "this day had no hands" and REPLACES what the server stores;
    // absent means "no statement" and leaves it. Emptying here would delete
    // rows that were uploaded correctly a week ago.
    const trimmed = trimToBudget(days(10), 1)
    for (const day of trimmed) {
      expect(Object.prototype.hasOwnProperty.call(day, 'openingBuckets')).toBe(false)
    }
  })
})
