#!/usr/bin/env node
/**
 * The maintainer's view of the telemetry server, in a terminal.
 *
 *   SVWB_TELEMETRY_URL=https://svwb-telemetry.<account>.workers.dev \
 *   SVWB_TELEMETRY_ADMIN_TOKEN=... \
 *   pnpm telemetry:report
 *
 * Reads `/v1/admin/overview` and prints active installs, the version split and
 * the daily series. Pass `--json` to get the raw document instead, and
 * `--meta` to print the public `/v1/meta` aggregate the app will read.
 */

const url = (process.env.SVWB_TELEMETRY_URL ?? '').replace(/\/+$/, '')
const token = process.env.SVWB_TELEMETRY_ADMIN_TOKEN ?? ''
const args = new Set(process.argv.slice(2))

if (!url) {
  console.error('Set SVWB_TELEMETRY_URL to the Worker origin.')
  process.exit(2)
}

async function fetchJson(path, headers = {}) {
  const res = await fetch(`${url}${path}`, { headers })
  const text = await res.text()
  if (!res.ok) {
    console.error(`${path} -> HTTP ${res.status}: ${text}`)
    process.exit(1)
  }
  return JSON.parse(text)
}

if (args.has('--meta')) {
  const meta = await fetchJson('/v1/meta')
  if (args.has('--json')) {
    console.log(JSON.stringify(meta, null, 2))
  } else {
    console.log(
      `${meta.mode} · tiers ${meta.tiers.join(',')} · since ${meta.window.since} · ` +
        `${meta.installs} installs · ${meta.matches} matches`
    )
    console.table(
      meta.byClass.map((row) => ({
        class: row.myClass,
        games: row.total,
        winrate: row.total ? `${((100 * row.wins) / row.total).toFixed(1)}%` : '-'
      }))
    )
  }
  process.exit(0)
}

if (!token) {
  console.error(
    'Set SVWB_TELEMETRY_ADMIN_TOKEN (the value given to `wrangler secret put ADMIN_TOKEN`).'
  )
  process.exit(2)
}

const overview = await fetchJson('/v1/admin/overview', { authorization: `Bearer ${token}` })

if (args.has('--json')) {
  console.log(JSON.stringify(overview, null, 2))
  process.exit(0)
}

console.log(`Generated ${overview.generatedAt} (UTC today: ${overview.today})`)
console.log(
  `Active installs: today ${overview.active.today} · 7d ${overview.active.last7d} · ` +
    `30d ${overview.active.last30d} · ever ${overview.installs}`
)
// `new` counts install IDS first seen in the period, so a reinstall or a
// cleared profile reads as a new one - an upper bound on new users, not a
// count of them.
console.log(`New installs: 7d ${overview.newInstalls.last7d} · 30d ${overview.newInstalls.last30d}`)
console.log('\nVersions (installs active in the period, by last reported version):')
console.table(
  overview.versions.map((row) => ({
    version: row.appVersion,
    '7d': row.active7d,
    '30d': row.active30d
  }))
)
console.log('Platforms (30d):')
console.table(overview.platforms.map((row) => ({ platform: row.platform, '30d': row.active30d })))

const m = overview.matchesLast30d
console.log(
  `\nMatches uploaded for the last 30 days: ${m.total}` +
    ` · by tier ${JSON.stringify(m.byTier)}` +
    ` · by mode ${JSON.stringify(m.byMode)}`
)
console.log('\nDaily (last 30 days):')
console.table(
  overview.series.map((row) => ({
    date: row.date,
    active: row.activeInstalls,
    new: row.newInstalls,
    recording: row.recordingInstalls,
    matches: row.matches,
    abandoned: row.abandoned,
    manual: row.manual
  }))
)
