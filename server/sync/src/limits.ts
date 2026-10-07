/**
 * Every number the server enforces, and the policy that can change without a
 * release. The constants are protocol (the client assumes them); the `Config`
 * values are policy (docs/account-sync-plan.md J-2: "server-side switches").
 */
import { ApiError } from './http'
import type { Config, Deps, RateLimiterLike } from './types'

export const MAX_SEGMENT_BYTES = 1024 * 1024
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_SEQ = 999_999

export const ACCESS_TTL_MS = 15 * 60_000
export const GRANT_TTL_MS = 5 * 60_000
/** The Google round trip: how long a user has to finish the consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000
export const RETIRE_AFTER_MS = 90 * 24 * 3600_000
/**
 * `lastSeenAt` is only rewritten when it is this stale. It is informational
 * ("last active 5 minutes ago" is as useful as "last active 12 seconds ago"),
 * and every authenticated request would otherwise be a D1 write - the exact
 * pattern that exhausted the telemetry database.
 */
export const LAST_SEEN_GRANULARITY_MS = 10 * 60_000
export const RETRY_AFTER_RATE_LIMIT = 60
export const RETRY_AFTER_KILL_SWITCH = 3600

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Google's `sub` is a decimal string; this is a strict superset that is still safe in an R2 key. */
export const SUB_RE = /^[A-Za-z0-9_-]{1,255}$/

export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024
export const DEFAULT_ROUNDS_PER_DAY = 200

function positiveInt(raw: string | undefined, fallback: number, allowZero = false): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || (n === 0 && !allowZero)) return fallback
  return n
}

/**
 * Parse the Worker's string vars. A malformed value falls back to the default
 * rather than throwing: a typo in the dashboard must not take sync down, and
 * "100 MB" is a safe thing to be wrong about in the strict direction.
 */
export function parseConfig(vars: {
  QUOTA_BYTES?: string
  ROUNDS_PER_DAY?: string
  MAX_DEVICES?: string
  KILL_SWITCH?: string
}): Config {
  const kill = (vars.KILL_SWITCH ?? '').trim().toLowerCase()
  return {
    quotaBytes: positiveInt(vars.QUOTA_BYTES, DEFAULT_QUOTA_BYTES),
    roundsPerDay: positiveInt(vars.ROUNDS_PER_DAY, DEFAULT_ROUNDS_PER_DAY),
    maxDevices: positiveInt(vars.MAX_DEVICES, 0, true),
    killSwitch: kill === '1' || kill === 'true'
  }
}

/**
 * Ask a limiter; fail OPEN. `limit()` is itself a network call to Cloudflare
 * and can fail, and a Worker that refuses every request because its limiter
 * hiccuped is a worse outcome than one that is briefly too generous.
 */
export async function withinLimit(
  limiter: RateLimiterLike | undefined,
  key: string
): Promise<boolean> {
  if (!limiter) return true
  try {
    return (await limiter.limit({ key })).success
  } catch {
    return true
  }
}

export function rateLimited(message = 'Too many requests.'): ApiError {
  return new ApiError(429, 'rate_limited', message, {
    'retry-after': String(RETRY_AFTER_RATE_LIMIT)
  })
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function secondsUntilUtcMidnight(ms: number): number {
  const next = new Date(ms)
  next.setUTCHours(24, 0, 0, 0)
  return Math.max(1, Math.ceil((next.getTime() - ms) / 1000))
}

/**
 * Count one sync round for this account today, or say the day's allowance is
 * spent. One statement: the upsert only fires its UPDATE while `n < limit`, so
 * a burst of parallel rounds cannot overshoot, and `changes` tells us whether
 * it counted. Write cost: one row per account per day plus its increments,
 * which is inherent to counting.
 */
export async function countRound(deps: Deps, sub: string): Promise<void> {
  const result = await deps.db
    .prepare(
      `INSERT INTO rounds (sub, day, n) VALUES (?1, ?2, 1)
       ON CONFLICT (sub, day) DO UPDATE SET n = n + 1 WHERE n < ?3`
    )
    .bind(sub, utcDay(deps.now()), deps.config.roundsPerDay)
    .run()
  if (result.meta.changes === 0) {
    throw new ApiError(429, 'rate_limited', 'This account has used its sync rounds for today.', {
      'retry-after': String(secondsUntilUtcMidnight(deps.now()))
    })
  }
}

export async function roundsToday(deps: Deps, sub: string): Promise<number> {
  const row = await deps.db
    .prepare(`SELECT n FROM rounds WHERE sub = ?1 AND day = ?2`)
    .bind(sub, utcDay(deps.now()))
    .first<{ n: number }>()
  return row?.n ?? 0
}
