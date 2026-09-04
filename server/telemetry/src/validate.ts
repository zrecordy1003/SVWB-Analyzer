/**
 * What the Worker accepts, and what it refuses.
 *
 * Everything the client can send is whitelisted here against the same
 * constants the client builds from (`src/shared/telemetry.ts`), so an enum
 * value that is not in the app's vocabulary cannot become a row. The endpoint
 * is public and the client is open source, so this is not a defence against a
 * determined forger (docs/meta-stats-plan.md R-5) - it is what keeps a bug, a
 * typo or a lazy script from putting garbage keys into the aggregate.
 *
 * Refusal is per day where it can be. A payload with one absurd day and
 * thirteen fine ones stores thirteen and reports the one; the client logs the
 * report. Only a payload that is not the right shape at all is refused whole.
 *
 * Pure: takes parsed JSON and a clock, returns a verdict. Tested from the app's
 * vitest suite so the server's rules and the client's constants are checked in
 * the same run.
 */
import { CR_BAND_UNKNOWN } from '../../../src/shared/crBands'
import {
  TELEMETRY_ACCEPTED_SCHEMAS,
  TELEMETRY_CLASSES,
  TELEMETRY_CR_BANDS,
  TELEMETRY_MAX_MATCHES_PER_DAY,
  TELEMETRY_MODES,
  TELEMETRY_PLAY_ORDERS,
  TELEMETRY_RESULTS,
  TELEMETRY_TIERS,
  TELEMETRY_WINDOW_DAYS
} from '../../../src/shared/telemetry'

export type ValidBucket = {
  tier: string
  mode: string
  myClass: string
  oppoClass: string
  playOrder: string
  /** Always set. A schema-1 bucket has no such field and is stored as `unknown`. */
  crBand: string
  result: string
  count: number
}

export type ValidDay = {
  date: string
  abandoned: number
  manual: number
  buckets: ValidBucket[]
  /** Sum of bucket counts, precomputed for the `match_days` row. */
  matches: number
}

export type ValidPayload = {
  installId: string
  appVersion: string
  platform: string
  arch: string
  locale: string
  days: ValidDay[]
  rejected: Array<{ date: string; reason: string }>
}

export type Verdict =
  | { ok: true; value: ValidPayload }
  | { ok: false; status: number; error: string }

/** How far back a day may be and still be stored. Wider than the client's window on purpose. */
const MAX_DAY_AGE_DAYS = 30
/** Tolerance for a client clock that is a little ahead. */
const MAX_DAY_FUTURE_DAYS = 1
/** Every combination of the bucket dimensions. Nothing legitimate is near it. */
const MAX_BUCKETS_PER_DAY =
  TELEMETRY_TIERS.length *
  TELEMETRY_MODES.length *
  TELEMETRY_CLASSES.length *
  TELEMETRY_CLASSES.length *
  TELEMETRY_PLAY_ORDERS.length *
  TELEMETRY_CR_BANDS.length *
  TELEMETRY_RESULTS.length

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$/
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,32}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const DAY_MS = 86_400_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Parses `YYYY-MM-DD` strictly: the round trip must reproduce the input. */
function dateMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null
  const ms = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(ms) || utcDate(ms) !== date) return null
  return ms
}

/**
 * @param schema the payload's declared schema, which decides whether `crBand`
 *   is required. Absent-and-defaulted is correct for 1 and a client bug for 2,
 *   and the two must not look the same: `unknown` is already the majority band,
 *   so a client that quietly stopped sending the field would vanish into it.
 */
function validateBucket(raw: unknown, schema: number): ValidBucket | string {
  if (!isRecord(raw)) return 'bucket is not an object'
  const { tier, mode, myClass, oppoClass, playOrder, crBand, result, count } = raw
  if (typeof tier !== 'string' || !(TELEMETRY_TIERS as readonly string[]).includes(tier)) {
    return `unknown tier ${String(tier)}`
  }
  if (typeof mode !== 'string' || !TELEMETRY_MODES.includes(mode)) {
    return `unknown mode ${String(mode)}`
  }
  if (typeof myClass !== 'string' || !TELEMETRY_CLASSES.includes(myClass)) {
    return `unknown class ${String(myClass)}`
  }
  if (typeof oppoClass !== 'string' || !TELEMETRY_CLASSES.includes(oppoClass)) {
    return `unknown class ${String(oppoClass)}`
  }
  if (typeof playOrder !== 'string' || !TELEMETRY_PLAY_ORDERS.includes(playOrder)) {
    return `unknown play order ${String(playOrder)}`
  }
  if (typeof result !== 'string' || !(TELEMETRY_RESULTS as readonly string[]).includes(result)) {
    return `unknown result ${String(result)}`
  }
  let band: string
  if (typeof crBand === 'undefined') {
    if (schema >= 2) return 'missing crBand'
    band = CR_BAND_UNKNOWN
  } else if (typeof crBand === 'string' && TELEMETRY_CR_BANDS.includes(crBand)) {
    band = crBand
  } else {
    return `unknown cr band ${String(crBand)}`
  }
  if (!isCount(count, 1) || count > TELEMETRY_MAX_MATCHES_PER_DAY) {
    return `bad count ${String(count)}`
  }
  return { tier, mode, myClass, oppoClass, playOrder, crBand: band, result, count }
}

function validateDay(
  raw: unknown,
  now: Date,
  schema: number
): ValidDay | { date: string; reason: string } {
  const date = isRecord(raw) && typeof raw.date === 'string' ? raw.date : '(invalid)'
  const fail = (reason: string): { date: string; reason: string } => ({ date, reason })

  if (!isRecord(raw)) return fail('day is not an object')
  const ms = dateMs(date)
  if (ms === null) return fail('bad date')
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  if (ms < today - MAX_DAY_AGE_DAYS * DAY_MS) return fail('too old')
  if (ms > today + MAX_DAY_FUTURE_DAYS * DAY_MS) return fail('in the future')

  if (!isCount(raw.abandoned, 0) || raw.abandoned > TELEMETRY_MAX_MATCHES_PER_DAY) {
    return fail('bad abandoned count')
  }
  if (!isCount(raw.manual, 0) || raw.manual > TELEMETRY_MAX_MATCHES_PER_DAY) {
    return fail('bad manual count')
  }
  if (!Array.isArray(raw.buckets)) return fail('buckets is not an array')
  if (raw.buckets.length > MAX_BUCKETS_PER_DAY) return fail('too many buckets')

  const buckets: ValidBucket[] = []
  const seen = new Set<string>()
  let matches = 0
  for (const entry of raw.buckets) {
    const bucket = validateBucket(entry, schema)
    if (typeof bucket === 'string') return fail(bucket)
    const key = [
      bucket.tier,
      bucket.mode,
      bucket.myClass,
      bucket.oppoClass,
      bucket.playOrder,
      bucket.crBand,
      bucket.result
    ].join('|')
    if (seen.has(key)) return fail('duplicate bucket')
    seen.add(key)
    buckets.push(bucket)
    matches += bucket.count
  }
  if (matches + raw.abandoned + raw.manual > TELEMETRY_MAX_MATCHES_PER_DAY) {
    return fail('too many matches for one day')
  }
  return { date, abandoned: raw.abandoned, manual: raw.manual, buckets, matches }
}

export function validatePayload(body: unknown, now: Date): Verdict {
  if (!isRecord(body)) return { ok: false, status: 400, error: 'body is not an object' }
  /**
   * Both live schemas, and this list only ever grows.
   *
   * The endpoint is compiled into the installer, so an install that never
   * updates keeps sending its schema forever. Dropping 1 here would not
   * "migrate" those installs; it would silently stop counting them.
   */
  if (
    typeof body.schema !== 'number' ||
    !(TELEMETRY_ACCEPTED_SCHEMAS as readonly number[]).includes(body.schema)
  ) {
    return { ok: false, status: 400, error: `unsupported schema ${String(body.schema)}` }
  }
  const schema = body.schema
  const { installId, appVersion, platform, arch, locale, days } = body
  if (typeof installId !== 'string' || !UUID_RE.test(installId)) {
    return { ok: false, status: 400, error: 'bad installId' }
  }
  if (typeof appVersion !== 'string' || !VERSION_RE.test(appVersion)) {
    return { ok: false, status: 400, error: 'bad appVersion' }
  }
  for (const [name, value] of [
    ['platform', platform],
    ['arch', arch],
    ['locale', locale]
  ] as const) {
    if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
      return { ok: false, status: 400, error: `bad ${name}` }
    }
  }
  if (!Array.isArray(days)) return { ok: false, status: 400, error: 'days is not an array' }
  // A little over the window, so a client whose clock crossed midnight while
  // building the payload is not refused for being one day long.
  if (days.length > TELEMETRY_WINDOW_DAYS + 2) {
    return { ok: false, status: 400, error: 'too many days' }
  }

  const accepted: ValidDay[] = []
  const rejected: Array<{ date: string; reason: string }> = []
  const dates = new Set<string>()
  for (const raw of days) {
    const day = validateDay(raw, now, schema)
    if ('reason' in day) {
      rejected.push(day)
      continue
    }
    if (dates.has(day.date)) {
      rejected.push({ date: day.date, reason: 'duplicate date' })
      continue
    }
    dates.add(day.date)
    accepted.push(day)
  }

  return {
    ok: true,
    value: {
      installId: installId.toLowerCase(),
      appVersion,
      platform: platform as string,
      arch: arch as string,
      locale: locale as string,
      days: accepted,
      rejected
    }
  }
}
