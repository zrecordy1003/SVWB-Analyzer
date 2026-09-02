/**
 * End-to-end check of a running Worker: real HTTP, real D1, real routing.
 *
 * The vitest suites cover the pure parts (`validate.ts`, `aggregate.ts`, and
 * the app-side `rollup()` that feeds them). What they cannot cover is the SQL
 * and the routing: whether an upload actually lands in four tables, whether
 * `(installId, date)` really overwrites instead of accumulating, whether the
 * admin route is closed to everyone without the token. This script asserts
 * exactly that, and nothing a unit test already proves.
 *
 * Against a local `wrangler dev` (see README):
 *
 *   node smoke.mjs                        # 127.0.0.1:8787, token from .dev.vars
 *   SVWB_TELEMETRY_URL=... SVWB_TELEMETRY_ADMIN_TOKEN=... node smoke.mjs
 *
 * It writes two throwaway installs worth of rows, so point it at a local
 * database, not at production - `--allow-remote` is required to aim it
 * anywhere that is not localhost, and even then it only ever adds two random
 * install ids.
 */
import { readFileSync } from 'node:fs'

const BASE = (process.env.SVWB_TELEMETRY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const TOKEN = process.env.SVWB_TELEMETRY_ADMIN_TOKEN ?? devVarsToken()

/**
 * Read from the shared source rather than repeated here: a client that widens
 * its window and a server that does not is exactly the kind of mismatch this
 * script exists to catch. Plain node cannot import the .ts, hence the regex.
 */
const WINDOW = (() => {
  const src = readFileSync(new URL('../../src/shared/telemetry.ts', import.meta.url), 'utf8')
  const m = /TELEMETRY_WINDOW_DAYS = (\d+)/.exec(src)
  if (!m) throw new Error('TELEMETRY_WINDOW_DAYS not found in src/shared/telemetry.ts')
  return Number(m[1])
})()

if (
  !/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(BASE) &&
  !process.argv.includes('--allow-remote')
) {
  console.error(`${BASE} is not local. Re-run with --allow-remote if you really mean it.`)
  process.exit(2)
}
if (!TOKEN) {
  console.error('No admin token. Put ADMIN_TOKEN in .dev.vars or set SVWB_TELEMETRY_ADMIN_TOKEN.')
  process.exit(2)
}

/** The local dev token lives in .dev.vars, the same file `wrangler dev` reads. */
function devVarsToken() {
  try {
    const line = readFileSync(new URL('.dev.vars', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('ADMIN_TOKEN='))
    return line?.slice('ADMIN_TOKEN='.length).trim() ?? ''
  } catch {
    return ''
  }
}

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures += 1
    console.log('      ', JSON.stringify(detail))
  }
}

const now = new Date()
const day = (back) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back))
    .toISOString()
    .slice(0, 10)

/** What the client sends every time: the whole window, empty days included. */
const payload = (installId, appVersion, fill) => {
  const p = {
    schema: 1,
    installId,
    appVersion,
    platform: 'win32',
    arch: 'x64',
    locale: 'zh-TW',
    sentAt: new Date().toISOString(),
    days: Array.from({ length: WINDOW }, (_, i) => ({
      date: day(i),
      abandoned: 0,
      manual: 0,
      buckets: []
    }))
  }
  fill?.(p)
  return p
}

const bucket = (over = {}) => ({
  tier: 'clean',
  mode: 'ranked',
  myClass: 'witch',
  oppoClass: 'dragon',
  playOrder: 'first',
  result: 'win',
  count: 1,
  ...over
})

const post = async (body) => {
  const res = await fetch(`${BASE}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const get = async (path, token) => {
  const res = await fetch(
    `${BASE}${path}`,
    token ? { headers: { authorization: `Bearer ${token}` } } : undefined
  )
  return { res, status: res.status, body: await res.json().catch(() => null) }
}

/**
 * Today's row of the admin series. The public `/v1/meta` is cached at the edge
 * for 15 minutes, so it cannot answer "did that write land"; this can.
 */
const today = async () => {
  const o = await get('/v1/admin/overview', TOKEN)
  if (o.status !== 200) throw new Error(`overview ${o.status}: ${JSON.stringify(o.body)}`)
  const row = o.body.series?.find((r) => r.date === day(0)) ?? {
    matches: 0,
    abandoned: 0,
    manual: 0
  }
  return { matches: row.matches, abandoned: row.abandoned, manual: row.manual }
}

const A = crypto.randomUUID()
const B = crypto.randomUUID()

check('health answers', (await get('/health')).body?.ok === true)
const base = await today()

// A: five matches today (three clean, two edited), one abandoned, one manual.
const aDay = () => ({
  date: day(0),
  abandoned: 1,
  manual: 1,
  buckets: [
    bucket({ count: 3 }),
    bucket({ tier: 'edited', playOrder: 'second', result: 'loss', count: 2 })
  ]
})
const a1 = await post(payload(A, '1.3.0', (p) => (p.days[0] = aDay())))
check(
  'the whole window is accepted',
  a1.status === 200 && a1.body.accepted === WINDOW && a1.body.rejected.length === 0,
  a1
)

// B: one match today, plus a day naming a class that is not in the whitelist.
const b1 = await post(
  payload(B, '1.2.0', (p) => {
    p.days[0].buckets = [bucket()]
    p.days[1].buckets = [bucket({ myClass: 'wizard', count: 9 })]
  })
)
check(
  'a bad day is refused on its own, the rest of the upload survives',
  b1.status === 200 && b1.body.accepted === WINDOW - 1 && b1.body.rejected?.[0]?.date === day(1),
  b1
)

const afterFirst = await today()
check('both installs are counted', afterFirst.matches === base.matches + 6, { base, afterFirst })
check(
  'abandoned and manual are counted apart from the buckets',
  afterFirst.abandoned === base.abandoned + 1 && afterFirst.manual === base.manual + 1,
  { base, afterFirst }
)

// The client re-sends the same window every few hours; that must be a no-op.
const a2 = await post(payload(A, '1.3.0', (p) => (p.days[0] = aDay())))
check('an identical re-send is accepted', a2.status === 200 && a2.body.accepted === WINDOW, a2)
const afterResend = await today()
check('and changes nothing', afterResend.matches === afterFirst.matches, {
  afterFirst,
  afterResend
})

// The user deletes four of the five: the day is replaced, not added to.
const a3 = await post(payload(A, '1.3.0', (p) => (p.days[0].buckets = [bucket()])))
check('a corrected day is accepted', a3.status === 200 && a3.body.accepted === WINDOW, a3)
const afterCorrection = await today()
check('the day is replaced wholesale', afterCorrection.matches === base.matches + 2, {
  base,
  afterCorrection
})
check(
  'the abandoned and manual counts go with it',
  afterCorrection.abandoned === base.abandoned && afterCorrection.manual === base.manual,
  { base, afterCorrection }
)

const meta = await get('/v1/meta?days=1')
check(
  'meta answers with the matchup',
  Array.isArray(meta.body?.cells) && meta.body.cells.length > 0,
  meta.body
)
check(
  'meta is edge-cacheable',
  /max-age=\d+/.test(meta.res.headers.get('cache-control') ?? ''),
  meta.res.headers.get('cache-control')
)

check('the admin route is closed without a token', (await get('/v1/admin/overview')).status === 401)
check('and to the wrong token', (await get('/v1/admin/overview', `${TOKEN}x`)).status === 401)
check('and open with the right one', (await get('/v1/admin/overview', TOKEN)).status === 200)

check('a malformed body is a 4xx, not a 500', (await post('{')).status === 400)
const wrongSchema = await post(payload(A, '1.3.0', (p) => (p.schema = 99)))
check('an unknown schema is refused', wrongSchema.status === 400, wrongSchema)
const notAUuid = await post(payload('install-1', '1.3.0'))
check('an install id that is not a UUID is refused', notAUuid.status === 400, notAUuid)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
