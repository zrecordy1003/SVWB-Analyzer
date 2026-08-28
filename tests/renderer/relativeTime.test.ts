import { describe, expect, it } from 'vitest'

import { formatRelativeTime } from '../../src/renderer/src/utils/relativeTime'

/**
 * Anchors are built in LOCAL time on purpose.
 *
 * `formatRelativeTime` switches from hours to 昨天 on a calendar-day boundary
 * in the reader's own timezone, which is the behaviour users want. Pinning the
 * anchors to a fixed offset instead made these assertions true only in +08:00:
 * on a UTC runner `NOW` landed at 13:00, so "20 hours back" crossed midnight
 * and read 昨天. Local constructors keep the intent - 21:00, whatever zone the
 * test happens to run in - so the suite checks the same behaviour everywhere.
 */
const NOW = new Date(2026, 7, 26, 21, 0, 0)
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  it('collapses anything within the last minute to 剛剛', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('剛剛')
    expect(formatRelativeTime(ago(30_000), NOW)).toBe('剛剛')
    // A match logged a moment ahead of the clock must not read as "1 分鐘後".
    expect(formatRelativeTime(new Date(NOW.getTime() + 5_000), NOW)).toBe('剛剛')
  })

  it('counts minutes and hours while the match is same-day', () => {
    expect(formatRelativeTime(ago(23 * MINUTE), NOW)).toBe('23 分鐘前')
    expect(formatRelativeTime(ago(5 * HOUR), NOW)).toBe('5 小時前')
  })

  it('switches to calendar days once the date changes', () => {
    // 20 hours back is still the same calendar day at 01:00, so it stays in hours.
    expect(formatRelativeTime(ago(20 * HOUR), NOW)).toBe('20 小時前')
    expect(formatRelativeTime(ago(DAY), NOW)).toBe('昨天')
    expect(formatRelativeTime(ago(3 * DAY), NOW)).toBe('3 天前')
  })

  it('keeps minutes and hours across a midnight boundary', () => {
    // A match twenty minutes old is "20 分鐘前" even though the date rolled
    // over; jumping straight to 昨天 would overstate how long ago it was.
    const justBeforeMidnight = new Date(2026, 7, 25, 23, 50, 0)
    const justAfter = new Date(2026, 7, 26, 0, 10, 0)
    expect(formatRelativeTime(justBeforeMidnight, justAfter)).toBe('20 分鐘前')
  })

  it('escalates to weeks and months', () => {
    expect(formatRelativeTime(ago(9 * DAY), NOW)).toBe('上週')
    expect(formatRelativeTime(ago(20 * DAY), NOW)).toBe('2 週前')
    expect(formatRelativeTime(ago(70 * DAY), NOW)).toBe('2 個月前')
  })

  it('falls back to an absolute date beyond a year, where a distance stops helping', () => {
    expect(formatRelativeTime(new Date(2025, 2, 14, 10, 0, 0), NOW)).toBe('2025/3/14')
  })

  it('returns an empty string for an unusable value', () => {
    expect(formatRelativeTime('not a date', NOW)).toBe('')
  })
})
