import { useEffect, useState } from 'react'

/**
 * Relative match times, following the convention every feed UI uses: recent
 * matches read as an elapsed distance ("3 天前"), old ones as a plain date,
 * because "37 個月前" is something the reader has to do arithmetic on.
 *
 * `Intl.RelativeTimeFormat` is built into Chromium, so this needs no
 * dependency - and unlike date-fns' zh-TW distances it produces "5 小時前"
 * instead of "大約 5 小時前".
 */
const relativeFormatter = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' })

/** Beyond this the elapsed distance stops being useful; show the date instead. */
const ABSOLUTE_AFTER_DAYS = 365

const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
})

const fullFormatter = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Calendar days apart, so an evening match seen the next morning reads as
 * 昨天 instead of "14 小時前". Sub-hour distances are answered before this,
 * so a match twenty minutes either side of midnight still reads in minutes.
 */
function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((b.getTime() - a.getTime()) / DAY)
}

/** Full date and time - the exact value, for tooltips. */
export function formatAbsoluteTime(value: Date | string | number): string {
  const date = toDate(value)
  return date ? fullFormatter.format(date) : ''
}

export function formatRelativeTime(value: Date | string | number, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return ''

  const elapsed = now.getTime() - date.getTime()
  // Clock skew or a match logged a moment ahead of the clock: treat as now
  // rather than saying "1 分鐘後".
  if (elapsed < 45_000) return '剛剛'
  if (elapsed < HOUR) return relativeFormatter.format(-Math.round(elapsed / MINUTE), 'minute')

  const days = calendarDaysBetween(date, now)
  if (elapsed < DAY && days === 0) {
    return relativeFormatter.format(-Math.floor(elapsed / HOUR), 'hour')
  }
  if (days < 7) return relativeFormatter.format(-Math.max(days, 1), 'day')
  if (days < 30) return relativeFormatter.format(-Math.floor(days / 7), 'week')
  if (days < ABSOLUTE_AFTER_DAYS) {
    const months =
      (now.getFullYear() - date.getFullYear()) * 12 +
      (now.getMonth() - date.getMonth()) -
      (now.getDate() < date.getDate() ? 1 : 0)
    return relativeFormatter.format(-Math.max(months, 1), 'month')
  }
  return dateFormatter.format(date)
}

/**
 * How long the current label stays correct. Refreshing on this cadence keeps
 * "剛剛" from lingering for an hour without waking a timer every second for a
 * match played last March.
 */
function refreshDelay(value: Date | string | number, now: Date): number {
  const date = toDate(value)
  if (!date) return DAY
  const elapsed = now.getTime() - date.getTime()
  if (elapsed < HOUR) return 15_000
  if (elapsed < DAY) return 5 * MINUTE
  return HOUR
}

/** Relative label that keeps itself current while the card is on screen. */
export function useRelativeTime(value: Date | string | number): string {
  // A Date instance is a new object on every render even when the match has
  // not changed, so the timestamp is what the effect keys on.
  const timestamp = toDate(value)?.getTime() ?? Number.NaN
  const [label, setLabel] = useState(() => formatRelativeTime(timestamp))

  useEffect(() => {
    if (Number.isNaN(timestamp)) return
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      const now = new Date()
      setLabel(formatRelativeTime(timestamp, now))
      timer = setTimeout(tick, refreshDelay(timestamp, now))
    }
    tick()
    return () => clearTimeout(timer)
  }, [timestamp])

  return label
}
