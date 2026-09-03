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
  type NewInstallRow,
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
  /**
   * Rate limiters, declared in wrangler.toml.
   *
   * Optional on purpose. `/v1/ingest` is unauthenticated - it has to be, the
   * whole point is that an anonymous install can report - so a limiter that is
   * missing or broken must fail OPEN: telemetry going quiet is a bug, and a
   * Worker that refuses every upload because a binding was renamed is a worse
   * outcome than one that accepts too many for an afternoon.
   */
  INGEST_IP_LIMITER?: RateLimiter
  INGEST_INSTALL_LIMITER?: RateLimiter
  META_LIMITER?: RateLimiter
}

const META_CACHE_SECONDS = 900
const META_DEFAULT_DAYS = 14
const META_MAX_DAYS = 90
/** Which tiers the public aggregate counts. Server-side so it can change without a release. */
const META_TIERS = ['clean']
const META_MODE = 'ranked'

/**
 * The most any one install can contribute to any one published cell.
 *
 * Without it the public table is a plain sum, so an install with three hundred
 * ranked games in the window outweighs one with three by a hundred to one, and
 * at this project's scale a single grinder IS the meta. Ten bounds any single
 * person's share of any single number a reader looks at.
 *
 * It is applied per (install, cell) across the whole window, not per day: the
 * unit that matters is "one player's experience of this matchup", and a daily
 * cap of the same size would let the same player back in fourteen times over.
 *
 * The cap preserves the install's win RATIO rather than truncating wins and
 * losses separately - truncating them independently drags a lopsided record
 * toward 50% and would manufacture a signal rather than merely damp one.
 *
 * Server-side, so it can be retuned from the data without a client release.
 */
const META_MAX_PER_INSTALL_CELL = 10

/**
 * How many separate installs a cell needs before it is published at all.
 *
 * This one is about disclosure, not statistics. `/v1/meta` is public and
 * unauthenticated; a cell with one contributing install is that person's own
 * match record, and the document prints the install count beside it, so there
 * is no crowd to hide in. Five is the usual floor for this kind of
 * suppression and is cheap here - the cells it hides are the ones too small to
 * mean anything anyway.
 */
const META_MIN_INSTALLS_PER_CELL = 5
/** Bigger than any honest payload by an order of magnitude. */
const MAX_BODY_BYTES = 256 * 1024
/** D1 binds at most 100 parameters per statement; a bucket row takes 9. */
const BUCKET_ROWS_PER_STATEMENT = 11

const DAY_MS = 86_400_000

/** The shape of Cloudflare's rate-limiting binding, which has no ambient type. */
type RateLimiter = { limit: (opts: { key: string }) => Promise<{ success: boolean }> }

/**
 * Ask a limiter, and let the request through if it cannot answer.
 *
 * See `Env` for why this fails open. The `catch` matters as much as the
 * optional binding: `limit()` is a network call to Cloudflare's limiter and can
 * itself fail.
 */
async function withinLimit(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true
  try {
    const { success } = await limiter.limit({ key })
    return success
  } catch {
    return true
  }
}

/**
 * The caller's address, used for rate limiting and NEVER stored.
 *
 * Reading it is a change worth being explicit about: no table in
 * `migrations/0001_init.sql` has a column for it, no log line prints it, and it
 * exists inside these two functions only, as a limiter key. Without it the only
 * thing standing between the public aggregate and a few thousand invented
 * install ids is the 500-matches-a-day cap, which an attacker simply spreads
 * over more ids.
 */
const callerKey = (request: Request): string => request.headers.get('cf-connecting-ip') ?? 'unknown'

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
  // Before the body is even read: a flood costs nothing to refuse here and a
  // D1 batch to refuse later.
  if (!(await withinLimit(env.INGEST_IP_LIMITER, callerKey(request)))) {
    return json({ ok: false, error: 'too many requests' }, 429)
  }

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

  /**
   * And again per install, now that the payload has been validated enough to
   * know which one it claims to be.
   *
   * The IP limit above stops one machine flooding; this stops one install id
   * being written far more often than the client could possibly send it. The
   * client uploads on a schedule with a 60s floor between attempts
   * (`MIN_GAP_MS` in main/telemetry/telemetry.ts), so a real install cannot
   * approach this.
   */
  if (!(await withinLimit(env.INGEST_INSTALL_LIMITER, payload.installId))) {
    return json({ ok: false, error: 'too many requests for this install' }, 429)
  }

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
  // The cached path is nearly free, but a `no-cache` flood is not - and this
  // route is public. One limiter covers both.
  if (!(await withinLimit(env.META_LIMITER, callerKey(request)))) {
    return json({ ok: false, error: 'too many requests' }, 429)
  }

  const url = new URL(request.url)
  const requested = Number(url.searchParams.get('days') ?? META_DEFAULT_DAYS)
  const days = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), META_MAX_DAYS)
    : META_DEFAULT_DAYS

  // Normalised key, so `?days=14&x=1` and `?days=14` share one cache entry.
  const cacheKey = new Request(`${url.origin}/v1/meta?days=${days}`, { method: 'GET' })
  const cache = caches.default
  /**
   * `Cache-Control: no-cache` on the REQUEST skips the read, as HTTP says it
   * should.
   *
   * Two reasons, and neither is a testing backdoor - this is the standard
   * meaning of the header. A deploy does not change what the public sees for
   * up to `META_CACHE_SECONDS`, which for a change to the suppression rules is
   * exactly the wrong property; and `smoke.mjs` cannot otherwise assert
   * anything about this document's CONTENT, because the cache key is the
   * normalised url and extra parameters are dropped from it by design.
   *
   * Cheap to abuse, so it is behind the same limiter as everything else on
   * this route. The write still happens, so one fresh read repopulates the
   * cache for everyone.
   */
  const bypass = /(^|,)\s*no-cache\s*(,|$)/i.test(request.headers.get('cache-control') ?? '')
  if (!bypass) {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  }

  const now = new Date()
  const since = daysAgo(now, days - 1)
  const tierList = META_TIERS.map(() => '?').join(', ')

  const [matrix, installs] = await Promise.all([
    /**
     * Two passes in one statement.
     *
     * `per_install` collapses each install's whole window down to one row per
     * cell, which is the granularity the cap has to be applied at. The outer
     * query then sums those rows twice: once untouched (`raw_*`) and once with
     * each install held to `META_MAX_PER_INSTALL_CELL`.
     *
     * The capped win count is scaled rather than truncated -
     * `round(w * cap / t)` - so an install that went 18-2 contributes 9-1 and
     * not 10-2. Truncating the two independently would pull every lopsided
     * record toward even and invent a signal in the process.
     *
     * `COUNT(*)` on the outer query counts `per_install` rows, and there is
     * exactly one per install per cell, so it IS the distinct install count.
     */
    env.DB.prepare(
      `WITH per_install AS (
         SELECT install_id, my_class, oppo_class, play_order,
                SUM(count) AS t,
                SUM(CASE WHEN result = 'win' THEN count ELSE 0 END) AS w
         FROM buckets
         WHERE date >= ?1 AND mode = ?2 AND tier IN (${tierList})
         GROUP BY install_id, my_class, oppo_class, play_order
       )
       SELECT my_class, oppo_class, play_order,
              COUNT(*) AS installs,
              SUM(t) AS raw_total,
              SUM(w) AS raw_wins,
              SUM(MIN(t, ${META_MAX_PER_INSTALL_CELL})) AS total,
              SUM(CASE WHEN t <= ${META_MAX_PER_INSTALL_CELL} THEN w
                       ELSE CAST(ROUND(w * 1.0 * ${META_MAX_PER_INSTALL_CELL} / t) AS INTEGER)
                  END) AS wins
       FROM per_install
       GROUP BY my_class, oppo_class, play_order`
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
    maxPerInstallPerCell: META_MAX_PER_INSTALL_CELL,
    minInstallsPerCell: META_MIN_INSTALLS_PER_CELL,
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
    newInstalls,
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
    // Growth. `first_seen` has been written since the first migration and was
    // never read by anything until now, so a flat `active` line could not be
    // told apart from equal churn in both directions.
    //
    // `substr` because `first_seen` is a full ISO timestamp and the series is
    // keyed on the UTC date; the `>=` against a bare date works for the same
    // lexical reason as `last_seen` above.
    env.DB.prepare(
      `SELECT substr(first_seen, 1, 10) AS date, COUNT(*) AS installs
       FROM installs WHERE first_seen >= ?1 GROUP BY substr(first_seen, 1, 10)`
    )
      .bind(since30)
      .all<NewInstallRow>(),
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
      newInstalls: newInstalls.results,
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
