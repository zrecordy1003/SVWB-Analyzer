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
 * `/v1/meta`, read past the edge cache.
 *
 * Nothing else in this script can assert what that document CONTAINS. Its
 * cache key is the normalised url - `days` and nothing else, extra parameters
 * dropped on purpose - so a second run inside `max-age` reads the first run's
 * answer. That is not hypothetical: an earlier version of the block below
 * "passed" against a response that predated the code it was testing.
 *
 * `Cache-Control: no-cache` is the standard way to ask for a fresh copy and
 * the Worker honours it (see the comment on the cache lookup in index.ts).
 */
const getFresh = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { 'cache-control': 'no-cache' } })
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

/* ------------------------------------------------------------------ /v1/meta
 *
 * The three things unit tests cannot reach, because all three live in the SQL:
 * the install floor, the per-install cap, and that the cap keeps the win ratio.
 *
 * Every read of `/v1/meta` here goes through `getFresh`, which asks the edge
 * cache to stand aside. See its comment: without that these assertions read
 * whatever a previous run left behind.
 */

/**
 * The privacy property, stated so it does not depend on what the database has
 * accumulated.
 *
 * The first version of this asserted "no cells are published yet", which was
 * true only against an empty database - the local D1 keeps every install any
 * previous run wrote, so by the third run the cell had six contributors and the
 * check failed while the code was correct.
 *
 * The invariant that actually matters is unconditional: a published cell always
 * stands on at least `minInstallsPerCell` separate installs. Nothing about how
 * much data is already there can make that false.
 */
const metaBelow = await getFresh('/v1/meta?days=1')
const floor = metaBelow.body?.sampling?.minInstallsPerCell
check('meta states the install floor it applied', typeof floor === 'number' && floor >= 2, {
  sampling: metaBelow.body?.sampling
})
check(
  'no cell is published that too few people stand behind',
  metaBelow.body.cells.every((c) => c.installs >= floor),
  metaBelow.body.cells.filter((c) => c.installs < floor)
)

// And the same thing from the other side: a pairing that exactly one fresh
// install has ever reported must not be on the page. `nemesis` mirrors are
// used for nothing else in this script, so this install is the only
// contributor unless a previous run left some - hence the `< floor` form
// rather than an equality.
const LONER = { myClass: 'nemesis', oppoClass: 'nemesis', playOrder: 'second' }
await post(
  payload(crypto.randomUUID(), '1.3.0', (p) => {
    p.days[0] = {
      date: day(0),
      abandoned: 0,
      manual: 0,
      buckets: [{ ...bucket(), ...LONER, count: 4 }]
    }
  })
)
const metaLoner = await getFresh('/v1/meta?days=1')
const lonerCell = metaLoner.body.cells.find(
  (c) =>
    c.myClass === LONER.myClass &&
    c.oppoClass === LONER.oppoClass &&
    c.playOrder === LONER.playOrder
)
/**
 * Conditional, and it has to be. `suppressedCells > 0` is NOT an invariant:
 * this script has been run against the same local database many times, each
 * run adding one more install to this pairing, so by the sixth run the pairing
 * is legitimately over the floor and nothing anywhere is suppressed. Asserting
 * it unconditionally failed while the code was correct - the second time this
 * file made that mistake.
 *
 * What holds either way: the cell is published only with enough installs
 * behind it, and if it is absent then it was suppressed and counted as such.
 */
check(
  "one person's own record is withheld, and counted as withheld",
  lonerCell ? lonerCell.installs >= floor : metaLoner.body.sampling.suppressedCells > 0,
  { lonerCell, sampling: metaLoner.body.sampling }
)

// Now push the same cell over the floor with fresh installs. One of them plays
// it far more than the others, which is what the cap is for.
const CELL = { myClass: 'witch', oppoClass: 'dragon', playOrder: 'first' }
const GRINDER_WINS = 18
const GRINDER_TOTAL = 20
const crowd = []
for (let i = 0; i < floor + 1; i += 1) crowd.push(crypto.randomUUID())

for (const [i, id] of crowd.entries()) {
  // The last one is the grinder; everyone else plays the matchup twice.
  const wins = i === crowd.length - 1 ? GRINDER_WINS : 1
  const total = i === crowd.length - 1 ? GRINDER_TOTAL : 2
  const res = await post(
    payload(id, '1.3.0', (p) => {
      p.days[0] = {
        date: day(0),
        abandoned: 0,
        manual: 0,
        buckets: [
          { ...bucket(), count: wins },
          { ...bucket(), result: 'loss', count: total - wins }
        ]
      }
    })
  )
  check(`crowd install ${i + 1} accepted`, res.status === 200, res.body)
}

const metaAbove = await getFresh('/v1/meta?days=1')
const published = metaAbove.body.cells.find(
  (c) =>
    c.myClass === CELL.myClass && c.oppoClass === CELL.oppoClass && c.playOrder === CELL.playOrder
)
check('past the floor, the cell is published', Boolean(published), {
  cells: metaAbove.body.cells,
  sampling: metaAbove.body.sampling
})

const cap = metaAbove.body.sampling.maxPerInstallPerCell
check(
  'the cell counts every install that contributed',
  published.installs >= crowd.length,
  published
)
check(
  'the raw total includes all of the grinder games',
  published.rawTotal >= GRINDER_TOTAL,
  published
)
check(
  'the cap holds the grinder to its share',
  published.total < published.rawTotal && published.total <= (published.installs + 1) * cap,
  { published, cap }
)
// The cap damps a lopsided record; it must not invert or flatten it. This
// cannot tell scaling from truncation on its own - the two differ by a few
// points at this sample size - so the SQL ROUND is pinned separately, by
// running the CTE against D1 directly (see the comment on the query).
const cappedRate = published.wins / published.total
const rawRate = published.rawWins / published.rawTotal
check('and keeps the win ratio rather than flattening it', Math.abs(cappedRate - rawRate) < 0.15, {
  cappedRate,
  rawRate,
  published
})
check(
  'wins never exceed total',
  metaAbove.body.cells.every((c) => c.wins >= 0 && c.wins <= c.total),
  metaAbove.body.cells
)
check(
  'the caveats travel with the numbers',
  Array.isArray(metaAbove.body.caveats) && metaAbove.body.caveats.length > 0,
  metaAbove.body.caveats
)
check(
  'meta is edge-cacheable',
  /max-age=\d+/.test(metaAbove.res.headers.get('cache-control') ?? ''),
  metaAbove.res.headers.get('cache-control')
)

check('the admin route is closed without a token', (await get('/v1/admin/overview')).status === 401)
check('and to the wrong token', (await get('/v1/admin/overview', `${TOKEN}x`)).status === 401)
check('and open with the right one', (await get('/v1/admin/overview', TOKEN)).status === 200)

/* ------------------------------------------------------------ nightly prune
 *
 * The retention job cannot be reached over the public API - `/v1/ingest`
 * refuses a day more than 30 days old, so this script cannot create data that
 * is prunable in the first place. What it CAN check is the half that would be
 * catastrophic: that the comparison runs the right way round. A `date >`
 * where the code means `date <` deletes the live window instead of the tail,
 * and every other test here would still pass afterwards because they read
 * their own writes before it ran.
 *
 * `/cdn-cgi/handler/scheduled` is wrangler dev's trigger and does not exist on
 * a deployed Worker, so this is localhost-only. The tail-deleting half is
 * verified by hand against a seeded old row; see the README.
 */
if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(BASE)) {
  const before = await today()
  const fired = await fetch(`${BASE}/cdn-cgi/handler/scheduled`)
  check('the scheduled prune runs', fired.status === 200, fired.status)
  const after = await today()
  check(
    'and leaves everything inside the retention window alone',
    after.matches === before.matches &&
      after.abandoned === before.abandoned &&
      after.manual === before.manual,
    { before, after }
  )
}

check('a malformed body is a 4xx, not a 500', (await post('{')).status === 400)
const wrongSchema = await post(payload(A, '1.3.0', (p) => (p.schema = 99)))
check('an unknown schema is refused', wrongSchema.status === 400, wrongSchema)
const notAUuid = await post(payload('install-1', '1.3.0'))
check('an install id that is not a UUID is refused', notAUuid.status === 400, notAUuid)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
