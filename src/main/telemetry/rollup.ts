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
  type TelemetryOpeningBucket,
  type TelemetryTier
} from '../../shared/telemetry.js'
import { restBand } from '../../shared/openingStats.js'

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
 * One slot of one pre-mulligan hand, as the opening rollup needs it.
 *
 * Joined to its match by `matchId` only - everything else about the match
 * (class, opponent, result) comes from the `RollupRow` this is matched
 * against, so the two queries cannot disagree about what a match was.
 */
/** Four. A pre hand that is not this is not a hand this can read. */
const HAND_SIZE = 4

export type OpeningSlotRow = {
  matchId: number
  /** Null when the engine saw a card it could not name. Costs the whole hand. */
  cardId: number | null
  /** The card's mana cost, from `Card`. Null when the cache has no row. */
  cost: number | null
  /** True when this copy was thrown back. */
  swapped: number | boolean | null
}

/** A match, as the opening rollup needs to key its slots. */
export type OpeningMatchRow = { id: number } & RollupRow

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
  // A source this build does not recognise is excluded, not trusted.
  //
  // This used to fall through to `clean`, which made the check fail OPEN: any
  // row written by something other than the engine or the manual form counted
  // as the most trustworthy tier there is. That is not hypothetical - the demo
  // seeder (`tools/seed-opening-demo.mjs`) writes `source = 'demo-seed'`, and
  // 583 fabricated matches duly uploaded themselves as `clean` before anyone
  // noticed. Ten of them reached the published meta document.
  //
  // `legacy` is the one unrecognised value that is still real: rows predating
  // migration 008 have no source at all, and they are handled below as their
  // own tier. Everything else is somebody's tooling.
  if (row.source !== null && row.source !== 'engine') return 'invalid'
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
export function rollup(
  rows: readonly RollupRow[],
  now: number,
  /**
   * The opening buckets for the same window, from `openingBucketsByDate`.
   *
   * Optional, and its absence is NOT the same as an empty map. Omitted means
   * this caller does not carry opening data at all and every day comes back
   * without the field; an empty map means it does, and the days it has nothing
   * for get an empty array. Only the second is a statement about what was
   * played. The schema number is what tells the server which kind of client it
   * is talking to; this argument is what makes the payload match.
   */
  openingByDate?: Map<string, TelemetryOpeningBucket[]>
): TelemetryDay[] {
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
      .map(([, bucket]) => bucket),
    ...(openingByDate ? { openingBuckets: openingByDate.get(day.date) ?? [] } : {})
  }))
}

/**
 * The pre-mulligan hands of the window, as one bucket list per UTC date.
 *
 * Separate from `rollup` rather than folded into it, because the two read
 * different tables and a caller that cannot supply the hands (a test, an old
 * code path) should not have to pretend it can. `rollup` takes the result of
 * this as an optional argument and merges it into the days it already built.
 *
 * # What is dropped, and why each one
 *
 * - **A match whose tier is not a tier.** `classifyRow` decides, exactly as it
 *   does for the match buckets, so the two halves of a day can never disagree
 *   about whether a match counted. `manual` and `abandoned` are dropped rather
 *   than counted: nothing observed a hand-typed match, and a match with no
 *   result has no outcome to key on.
 * - **A hand that is not four named cards.** The band of a copy is the mean
 *   cost of the three beside it, so one unnamed slot does not cost one
 *   observation, it costs all four — there is no "other three" to speak of.
 *   This is the same rule `mulligan.ts` applies locally.
 * - **Nothing else.** A copy whose companions include an unknown cost keeps
 *   its row with `restBand: null`; see the field's comment.
 *
 * The unit is a COPY. A hand with two of a card sends two observations, which
 * is what the local advisor counts and therefore what makes the two
 * comparable.
 */
export function openingBucketsByDate(
  matches: readonly OpeningMatchRow[],
  slots: readonly OpeningSlotRow[],
  now: number
): Map<string, TelemetryOpeningBucket[]> {
  const window = new Set(windowDates(now))
  const byMatch = new Map<number, OpeningSlotRow[]>()
  for (const slot of slots) {
    const held = byMatch.get(slot.matchId)
    if (held) held.push(slot)
    else byMatch.set(slot.matchId, [slot])
  }

  const days = new Map<string, Map<string, TelemetryOpeningBucket>>()
  for (const match of matches) {
    const date = utcDate(match.playedAt)
    if (!window.has(date)) continue
    const tier = classifyRow(match)
    if (tier !== 'clean' && tier !== 'edited' && tier !== 'flagged' && tier !== 'legacy') continue
    const hand = byMatch.get(match.id)
    if (!hand || hand.length !== HAND_SIZE) continue
    if (hand.some((slot) => slot.cardId === null)) continue

    const bucketsForDay = days.get(date) ?? new Map<string, TelemetryOpeningBucket>()
    days.set(date, bucketsForDay)

    for (let i = 0; i < hand.length; i++) {
      const slot = hand[i]
      const others = hand.filter((_, j) => j !== i).map((other) => other.cost ?? null)
      const bucket: Omit<TelemetryOpeningBucket, 'count'> = {
        tier,
        mode: match.mode ?? 'unknown',
        myClass: match.my_class,
        oppoClass: match.oppo_class,
        playOrder: match.play_order,
        cardId: slot.cardId as number,
        kept: slot.swapped !== true && slot.swapped !== 1,
        restBand: restBand(others),
        result: match.result === 1 ? 'win' : 'loss'
      }
      const key = [
        bucket.tier,
        bucket.mode,
        bucket.myClass,
        bucket.oppoClass,
        bucket.playOrder,
        bucket.cardId,
        bucket.kept ? 'k' : 's',
        bucket.restBand ?? 'x',
        bucket.result
      ].join('|')
      const held = bucketsForDay.get(key)
      if (held) held.count += 1
      else bucketsForDay.set(key, { ...bucket, count: 1 })
    }
  }

  // Sorted by key, for the same reason the match buckets are: the same hands
  // must produce the same bytes, or `content_hash` never matches and every
  // upload rewrites the whole window.
  return new Map(
    [...days.entries()].map(([date, buckets]) => [
      date,
      [...buckets.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, bucket]) => bucket)
    ])
  )
}
