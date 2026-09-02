/**
 * The telemetry Worker: three routes over one D1 database.
 *
 *   POST /v1/ingest          the app's upload; replaces (installId, date) rows
 *   GET  /v1/meta            public aggregate - what the in-app page and the
 *                            web version will read. Cached at the edge.
 *   GET  /v1/admin/overview  the maintainer's numbers; bearer token
 *
 * Storage is four tables (see migrations/0001_init.sql). `installs` and
 * `activity` answer "who is running what"; `match_days` and `buckets` answer
 * "what is being recorded". An upload writes all four in one batch, and D1
 * runs a batch as one transaction, so a client that dies mid-request leaves
 * either the old rows or the new ones, never a mix.
 *
 * The public aggregate is computed on request and cached for
 * `META_CACHE_SECONDS`. At today's scale that is a few thousand rows scanned
 * per cache miss; if the install count grows two orders of magnitude, move the
 * GROUP BY into a scheduled handler that writes a snapshot to KV, exactly as
 * docs/meta-stats-plan.md sketched. The response shape would not change.
 */
import {
  buildMeta,
  buildOverview,
  type ActivityRow,
  type MatchDayRow,
  type MatrixRow,
  type ModeRow,
  type PlatformRow,
  type TierRow,
  type VersionRow
} from './aggregate'
import { validatePayload, type ValidDay } from './validate'

export interface Env {
  DB: D1Database
  /** `wrangler secret put ADMIN_TOKEN`. Unset means the admin route is closed. */
  ADMIN_TOKEN?: string
}

const META_CACHE_SECONDS = 900
const META_DEFAULT_DAYS = 14
const META_MAX_DAYS = 90
/** Which tiers the public aggregate counts. Server-side so it can change without a release. */
const META_TIERS = ['clean']
const META_MODE = 'ranked'
/** Bigger than any honest payload by an order of magnitude. */
const MAX_BODY_BYTES = 256 * 1024
/** D1 binds at most 100 parameters per statement; a bucket row takes 9. */
const BUCKET_ROWS_PER_STATEMENT = 11

const DAY_MS = 86_400_000

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  })

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const daysAgo = (now: Date, days: number): string =>
  utcDate(Math.floor(now.getTime() / DAY_MS) * DAY_MS - days * DAY_MS)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/v1/ingest' && request.method === 'POST') {
        return await ingest(request, env)
      }
      if (url.pathname === '/v1/meta' && request.method === 'GET') {
        return await meta(request, env, ctx)
      }
      if (url.pathname === '/v1/admin/overview' && request.method === 'GET') {
        return await overview(request, env)
      }
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ ok: true, service: 'svwb-telemetry' })
      }
      return json({ ok: false, error: 'not found' }, 404)
    } catch (e) {
      console.error('unhandled', e)
      return json({ ok: false, error: 'internal error' }, 500)
    }
  }
}

// ------------------------------------------------------------------- ingest

async function ingest(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return json({ ok: false, error: 'body too large' }, 413)

  let body: unknown
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return json({ ok: false, error: 'body too large' }, 413)
    body = JSON.parse(text)
  } catch {
    return json({ ok: false, error: 'body is not JSON' }, 400)
  }

  const now = new Date()
  const verdict = validatePayload(body, now)
  if (!verdict.ok) return json({ ok: false, error: verdict.error }, verdict.status)
  const payload = verdict.value

  const receivedAt = now.toISOString()
  const today = utcDate(now.getTime())
  const statements: D1PreparedStatement[] = []

  statements.push(
    env.DB.prepare(
      `INSERT INTO installs (install_id, first_seen, last_seen, app_version, platform, arch, locale, uploads)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, 1)
       ON CONFLICT(install_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         app_version = excluded.app_version,
         platform = excluded.platform,
         arch = excluded.arch,
         locale = excluded.locale,
         uploads = installs.uploads + 1`
    ).bind(
      payload.installId,
      receivedAt,
      payload.appVersion,
      payload.platform,
      payload.arch,
      payload.locale
    )
  )

  // Keyed on the day the upload ARRIVED. This is the heartbeat; the match
  // days below are about when games were played, which is a different thing.
  statements.push(
    env.DB.prepare(
      `INSERT INTO activity (install_id, date, app_version)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(install_id, date) DO UPDATE SET app_version = excluded.app_version`
    ).bind(payload.installId, today, payload.appVersion)
  )

  for (const day of payload.days) {
    statements.push(...dayStatements(env, payload.installId, day, receivedAt))
  }

  await env.DB.batch(statements)

  return json({ ok: true, accepted: payload.days.length, rejected: payload.rejected })
}

/** Replace everything stored for one (install, date). */
function dayStatements(
  env: Env,
  installId: string,
  day: ValidDay,
  receivedAt: string
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = []
  out.push(
    env.DB.prepare(`DELETE FROM buckets WHERE install_id = ?1 AND date = ?2`).bind(
      installId,
      day.date
    )
  )
  for (let i = 0; i < day.buckets.length; i += BUCKET_ROWS_PER_STATEMENT) {
    const chunk = day.buckets.slice(i, i + BUCKET_ROWS_PER_STATEMENT)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const values = chunk.flatMap((b) => [
      installId,
      day.date,
      b.tier,
      b.mode,
      b.myClass,
      b.oppoClass,
      b.playOrder,
      b.result,
      b.count
    ])
    out.push(
      env.DB.prepare(
        `INSERT INTO buckets (install_id, date, tier, mode, my_class, oppo_class, play_order, result, count)
         VALUES ${placeholders}`
      ).bind(...values)
    )
  }
  out.push(
    env.DB.prepare(
      `INSERT INTO match_days (install_id, date, matches, abandoned, manual, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(install_id, date) DO UPDATE SET
         matches = excluded.matches,
         abandoned = excluded.abandoned,
         manual = excluded.manual,
         received_at = excluded.received_at`
    ).bind(installId, day.date, day.matches, day.abandoned, day.manual, receivedAt)
  )
  return out
}

// --------------------------------------------------------------------- meta

async function meta(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const requested = Number(url.searchParams.get('days') ?? META_DEFAULT_DAYS)
  const days = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), META_MAX_DAYS)
    : META_DEFAULT_DAYS

  // Normalised key, so `?days=14&x=1` and `?days=14` share one cache entry.
  const cacheKey = new Request(`${url.origin}/v1/meta?days=${days}`, { method: 'GET' })
  const cache = caches.default
  const hit = await cache.match(cacheKey)
  if (hit) return hit

  const now = new Date()
  const since = daysAgo(now, days - 1)
  const tierList = META_TIERS.map(() => '?').join(', ')

  const [matrix, installs] = await Promise.all([
    env.DB.prepare(
      `SELECT my_class, oppo_class, play_order, result, SUM(count) AS n
       FROM buckets
       WHERE date >= ?1 AND mode = ?2 AND tier IN (${tierList})
       GROUP BY my_class, oppo_class, play_order, result`
    )
      .bind(since, META_MODE, ...META_TIERS)
      .all<MatrixRow>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT install_id) AS n
       FROM buckets
       WHERE date >= ?1 AND mode = ?2 AND tier IN (${tierList})`
    )
      .bind(since, META_MODE, ...META_TIERS)
      .first<{ n: number }>()
  ])

  const document = buildMeta(matrix.results, {
    installs: Number(installs?.n) || 0,
    since,
    days,
    mode: META_MODE,
    tiers: META_TIERS,
    now
  })

  const response = json(document, 200, {
    'cache-control': `public, max-age=${META_CACHE_SECONDS}`,
    // The web version will live on another origin.
    'access-control-allow-origin': '*'
  })
  ctx.waitUntil(cache.put(cacheKey, response.clone()))
  return response
}

// ----------------------------------------------------------------- overview

async function overview(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: 'admin token not configured' }, 503)
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!presented || !timingSafeEqual(presented, env.ADMIN_TOKEN)) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  const now = new Date()
  const today = utcDate(now.getTime())
  const since7 = daysAgo(now, 6)
  const since30 = daysAgo(now, 29)
  // `last_seen` is an ISO timestamp; comparing against a date prefix works
  // because both sort lexically and the timestamp is longer.
  const [
    activeToday,
    active7d,
    active30d,
    installs,
    versions7d,
    versions30d,
    platforms30d,
    activity,
    matchDays,
    tiers,
    modes
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM activity WHERE date = ?1`)
      .bind(today)
      .first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT install_id) AS n FROM activity WHERE date >= ?1`)
      .bind(since7)
      .first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT install_id) AS n FROM activity WHERE date >= ?1`)
      .bind(since30)
      .first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM installs`).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT app_version, COUNT(*) AS installs FROM installs
       WHERE last_seen >= ?1 GROUP BY app_version`
    )
      .bind(since7)
      .all<VersionRow>(),
    env.DB.prepare(
      `SELECT app_version, COUNT(*) AS installs FROM installs
       WHERE last_seen >= ?1 GROUP BY app_version`
    )
      .bind(since30)
      .all<VersionRow>(),
    env.DB.prepare(
      `SELECT platform, COUNT(*) AS installs FROM installs
       WHERE last_seen >= ?1 GROUP BY platform`
    )
      .bind(since30)
      .all<PlatformRow>(),
    env.DB.prepare(`SELECT date, COUNT(*) AS installs FROM activity WHERE date >= ?1 GROUP BY date`)
      .bind(since30)
      .all<ActivityRow>(),
    env.DB.prepare(
      `SELECT date, COUNT(*) AS installs, SUM(matches) AS matches,
              SUM(abandoned) AS abandoned, SUM(manual) AS manual
       FROM match_days WHERE date >= ?1 AND (matches > 0 OR abandoned > 0 OR manual > 0)
       GROUP BY date`
    )
      .bind(since30)
      .all<MatchDayRow>(),
    env.DB.prepare(`SELECT tier, SUM(count) AS n FROM buckets WHERE date >= ?1 GROUP BY tier`)
      .bind(since30)
      .all<TierRow>(),
    env.DB.prepare(`SELECT mode, SUM(count) AS n FROM buckets WHERE date >= ?1 GROUP BY mode`)
      .bind(since30)
      .all<ModeRow>()
  ])

  return json(
    buildOverview({
      now,
      activeToday: Number(activeToday?.n) || 0,
      active7d: Number(active7d?.n) || 0,
      active30d: Number(active30d?.n) || 0,
      installs: Number(installs?.n) || 0,
      versions7d: versions7d.results,
      versions30d: versions30d.results,
      platforms30d: platforms30d.results,
      activity: activity.results,
      matchDays: matchDays.results,
      tiers: tiers.results,
      modes: modes.results
    }),
    200,
    { 'cache-control': 'no-store' }
  )
}

/** Constant-time string comparison, so the token cannot be guessed a byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  if (x.byteLength !== y.byteLength) return false
  let diff = 0
  for (let i = 0; i < x.byteLength; i += 1) diff |= x[i] ^ y[i]
  return diff === 0
}
