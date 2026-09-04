/**
 * Match rows in, counting buckets out.
 *
 * This is the whole privacy argument in one function: whatever leaves the
 * machine passes through here, and here is where deck ids, notes, tags,
 * timestamps and numbers stop existing. The output is a count per
 * `(UTC date, tier, mode, my class, opponent class, play order, CR band,
 * result)`.
 *
 * `current_cr` is the one number that gets read and does not survive: it is
 * turned into one of five bands (`crBandOf`) and the value is dropped. That
 * asymmetry is deliberate. A rank split is worth having; a per-install series
 * of exact CR values is a ladder trajectory, and this function is the only
 * place standing between the two.
 *
 * Pure. The caller reads the rows and does the network; this only counts, so
 * it can be tested against fixed rows and a fixed clock.
 */
import type { Selectable } from 'kysely'
import type { MatchRow } from '../data/db/client.js'
import { OBSERVED_COLUMNS } from '../data/provenance.js'
import { crBandOf } from '../../shared/crBands.js'
import {
  TELEMETRY_CLASSES,
  TELEMETRY_MODES,
  TELEMETRY_PLAY_ORDERS,
  TELEMETRY_WINDOW_DAYS,
  type TelemetryBucket,
  type TelemetryDay,
  type TelemetryTier
} from '../../shared/telemetry.js'

/** The columns this module reads. Everything else on a row never gets here. */
export type RollupRow = Pick<
  Selectable<MatchRow>,
  | 'result'
  | 'play_order'
  | 'my_class'
  | 'oppo_class'
  | 'mode'
  | 'playedAt'
  | 'source'
  | 'current_cr'
  | 'edited_fields'
  | 'recog_flags'
>

/**
 * Flags that move a row out of `clean`.
 *
 * These are the engine saying "I was not sure about the mode" or "I never saw
 * the screen that settles the result". Whether they actually predict a wrong
 * value is what the provenance cross-tab (main/data/provenanceStats.ts) is
 * measuring; until it has an answer, the rows travel under their own tier and
 * the server decides what to count.
 *
 * `ranked-no-numbers` is deliberately absent: a ranked match with no BP read is
 * still a correctly classified win or loss, and no number is uploaded anyway.
 */
export const DEMOTING_FLAGS: readonly string[] = [
  'weak-mode-accepted',
  'mode-guessed',
  'mode-corrected',
  'final-screen-never-seen'
]

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` in UTC. Plan D-7: buckets use UTC so installs in different zones line up. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** UTC midnight of the oldest day in the window. */
export function windowStartMs(now: number, days = TELEMETRY_WINDOW_DAYS): number {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  return today - (days - 1) * DAY_MS
}

/** Every date in the window, oldest first, today last. */
export function windowDates(now: number, days = TELEMETRY_WINDOW_DAYS): string[] {
  const start = windowStartMs(now, days)
  const dates: string[] = []
  for (let i = 0; i < days; i += 1) dates.push(utcDate(start + i * DAY_MS))
  return dates
}

function parseArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export type RowClass = TelemetryTier | 'manual' | 'abandoned' | 'invalid'

/**
 * Where one row goes.
 *
 * Order matters. A hand-typed row is `manual` whatever else is true of it - it
 * was never observed, so no tier applies. A row without a result is
 * `abandoned` even if it is otherwise pristine, because a bucket needs a
 * result to be keyed on. Only then does trust come into it.
 */
export function classifyRow(row: RollupRow): RowClass {
  if (row.source === 'manual') return 'manual'
  if (
    !TELEMETRY_CLASSES.includes(row.my_class) ||
    !TELEMETRY_CLASSES.includes(row.oppo_class) ||
    !TELEMETRY_PLAY_ORDERS.includes(row.play_order) ||
    (row.mode !== null && !TELEMETRY_MODES.includes(row.mode))
  ) {
    // Not the engine's vocabulary. Nothing writes such a row today; if
    // something ever does, it must not reach the server as a bucket key.
    return 'invalid'
  }
  if (row.result === null) return 'abandoned'
  if (row.source === null) return 'legacy'
  const edits = parseArray(row.edited_fields)
  if (edits.some((field) => (OBSERVED_COLUMNS as readonly string[]).includes(field))) {
    return 'edited'
  }
  const flags = parseArray(row.recog_flags)
  if (flags.some((flag) => DEMOTING_FLAGS.includes(flag))) return 'flagged'
  return 'clean'
}

type MutableDay = {
  date: string
  abandoned: number
  manual: number
  buckets: Map<string, TelemetryBucket>
}

/**
 * Roll the rows in the window up into one `TelemetryDay` per date.
 *
 * Every date in the window is present in the output even when nothing was
 * played - an empty day is a fact the server needs (it is how a deleted match
 * leaves the aggregate), and today's row is the heartbeat. Rows outside the
 * window are ignored rather than rejected, so the caller's query can be loose.
 *
 * Buckets within a day are sorted by key so the same rows always produce the
 * same bytes; the tests rely on that and so does anyone diffing two payloads.
 */
export function rollup(rows: readonly RollupRow[], now: number): TelemetryDay[] {
  const days = new Map<string, MutableDay>()
  for (const date of windowDates(now)) {
    days.set(date, { date, abandoned: 0, manual: 0, buckets: new Map() })
  }

  for (const row of rows) {
    const day = days.get(utcDate(row.playedAt))
    if (!day) continue

    const kind = classifyRow(row)
    if (kind === 'invalid') continue
    if (kind === 'manual') {
      day.manual += 1
      continue
    }
    if (kind === 'abandoned') {
      day.abandoned += 1
      continue
    }

    const bucket: Omit<TelemetryBucket, 'count'> = {
      tier: kind,
      mode: row.mode ?? 'unknown',
      myClass: row.my_class,
      oppoClass: row.oppo_class,
      playOrder: row.play_order,
      crBand: crBandOf(row.current_cr),
      result: row.result === 1 ? 'win' : 'loss'
    }
    const key = [
      bucket.tier,
      bucket.mode,
      bucket.myClass,
      bucket.oppoClass,
      bucket.playOrder,
      bucket.crBand,
      bucket.result
    ].join('|')
    const held = day.buckets.get(key)
    if (held) held.count += 1
    else day.buckets.set(key, { ...bucket, count: 1 })
  }

  return [...days.values()].map((day) => ({
    date: day.date,
    abandoned: day.abandoned,
    manual: day.manual,
    buckets: [...day.buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, bucket]) => bucket)
  }))
}
