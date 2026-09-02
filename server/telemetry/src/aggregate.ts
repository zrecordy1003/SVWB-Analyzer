/**
 * Query results in, JSON documents out.
 *
 * `index.ts` runs the SQL; this shapes what comes back into the two documents
 * the Worker serves. Pure, so the shapes can be tested without a database.
 */

// ------------------------------------------------------------------ /v1/meta

export type MatrixRow = {
  my_class: string
  oppo_class: string
  play_order: string
  result: string
  n: number
}

export type MetaCell = {
  myClass: string
  oppoClass: string
  playOrder: string
  wins: number
  total: number
}

export type MetaDocument = {
  generatedAt: string
  /** What was counted: the filter the SQL applied. Stated so a chart can say it. */
  window: { since: string; days: number }
  mode: string
  tiers: string[]
  /** Distinct installs that contributed at least one bucket in the window. */
  installs: number
  /** Sum of every cell's total. Each match appears once, from its recorder's side. */
  matches: number
  /**
   * One cell per (my class, opponent class, play order) that has any data.
   * Wins and totals only - the interval is the reader's job (plan D-8), and a
   * cell with a small `total` must be shown as such, never as a bare rate.
   */
  cells: MetaCell[]
  /** Per-class totals from the recorder's side: how often each class was played. */
  byClass: Array<{ myClass: string; wins: number; total: number }>
}

export function buildMeta(
  rows: readonly MatrixRow[],
  opts: { installs: number; since: string; days: number; mode: string; tiers: string[]; now: Date }
): MetaDocument {
  const cells = new Map<string, MetaCell>()
  const byClass = new Map<string, { myClass: string; wins: number; total: number }>()
  let matches = 0

  for (const row of rows) {
    const n = Number(row.n) || 0
    if (n <= 0) continue
    const key = `${row.my_class}|${row.oppo_class}|${row.play_order}`
    const cell = cells.get(key) ?? {
      myClass: row.my_class,
      oppoClass: row.oppo_class,
      playOrder: row.play_order,
      wins: 0,
      total: 0
    }
    cell.total += n
    if (row.result === 'win') cell.wins += n
    cells.set(key, cell)

    const cls = byClass.get(row.my_class) ?? { myClass: row.my_class, wins: 0, total: 0 }
    cls.total += n
    if (row.result === 'win') cls.wins += n
    byClass.set(row.my_class, cls)

    matches += n
  }

  const byKey = <T extends { myClass: string }>(a: T, b: T): number =>
    a.myClass < b.myClass ? -1 : a.myClass > b.myClass ? 1 : 0

  return {
    generatedAt: opts.now.toISOString(),
    window: { since: opts.since, days: opts.days },
    mode: opts.mode,
    tiers: opts.tiers,
    installs: opts.installs,
    matches,
    cells: [...cells.values()].sort(
      (a, b) =>
        byKey(a, b) ||
        (a.oppoClass < b.oppoClass ? -1 : a.oppoClass > b.oppoClass ? 1 : 0) ||
        (a.playOrder < b.playOrder ? -1 : a.playOrder > b.playOrder ? 1 : 0)
    ),
    byClass: [...byClass.values()].sort(byKey)
  }
}

// -------------------------------------------------------- /v1/admin/overview

export type ActivityRow = { date: string; installs: number }
export type VersionRow = { app_version: string; installs: number }
export type PlatformRow = { platform: string; installs: number }
export type MatchDayRow = {
  date: string
  installs: number
  matches: number
  abandoned: number
  manual: number
}
export type TierRow = { tier: string; n: number }
export type ModeRow = { mode: string; n: number }

export type OverviewDocument = {
  generatedAt: string
  today: string
  /** Distinct installs that uploaded at least once in the period. */
  active: { today: number; last7d: number; last30d: number }
  /** Every install ever seen. */
  installs: number
  /** By the version each install last reported, among installs active in the period. */
  versions: Array<{ appVersion: string; active7d: number; active30d: number }>
  platforms: Array<{ platform: string; active30d: number }>
  /** One row per day for the last 30 days, oldest first; days with no data are present as zeros. */
  series: Array<{
    date: string
    activeInstalls: number
    /** Installs that had at least one match-day row for this date. */
    recordingInstalls: number
    matches: number
    abandoned: number
    manual: number
  }>
  /** Bucketed matches in the last 30 days, split the two ways the server can split them. */
  matchesLast30d: { total: number; byTier: Record<string, number>; byMode: Record<string, number> }
}

const DAY_MS = 86_400_000

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function lastDates(now: Date, days: number): string[] {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const out: string[] = []
  for (let i = days - 1; i >= 0; i -= 1) out.push(utcDate(today - i * DAY_MS))
  return out
}

export function buildOverview(input: {
  now: Date
  activeToday: number
  active7d: number
  active30d: number
  installs: number
  versions7d: readonly VersionRow[]
  versions30d: readonly VersionRow[]
  platforms30d: readonly PlatformRow[]
  activity: readonly ActivityRow[]
  matchDays: readonly MatchDayRow[]
  tiers: readonly TierRow[]
  modes: readonly ModeRow[]
}): OverviewDocument {
  const versions = new Map<string, { appVersion: string; active7d: number; active30d: number }>()
  for (const row of input.versions30d) {
    versions.set(row.app_version, {
      appVersion: row.app_version,
      active7d: 0,
      active30d: Number(row.installs) || 0
    })
  }
  for (const row of input.versions7d) {
    const held = versions.get(row.app_version) ?? {
      appVersion: row.app_version,
      active7d: 0,
      active30d: 0
    }
    held.active7d = Number(row.installs) || 0
    versions.set(row.app_version, held)
  }

  const activity = new Map(input.activity.map((row) => [row.date, Number(row.installs) || 0]))
  const matchDays = new Map(input.matchDays.map((row) => [row.date, row]))
  const series = lastDates(input.now, 30).map((date) => {
    const day = matchDays.get(date)
    return {
      date,
      activeInstalls: activity.get(date) ?? 0,
      recordingInstalls: Number(day?.installs) || 0,
      matches: Number(day?.matches) || 0,
      abandoned: Number(day?.abandoned) || 0,
      manual: Number(day?.manual) || 0
    }
  })

  const byTier: Record<string, number> = {}
  let total = 0
  for (const row of input.tiers) {
    const n = Number(row.n) || 0
    byTier[row.tier] = n
    total += n
  }
  const byMode: Record<string, number> = {}
  for (const row of input.modes) byMode[row.mode] = Number(row.n) || 0

  return {
    generatedAt: input.now.toISOString(),
    today: utcDate(input.now.getTime()),
    active: { today: input.activeToday, last7d: input.active7d, last30d: input.active30d },
    installs: input.installs,
    versions: [...versions.values()].sort(
      (a, b) => b.active30d - a.active30d || (a.appVersion < b.appVersion ? 1 : -1)
    ),
    platforms: input.platforms30d
      .map((row) => ({ platform: row.platform, active30d: Number(row.installs) || 0 }))
      .sort((a, b) => b.active30d - a.active30d),
    series,
    matchesLast30d: { total, byTier, byMode }
  }
}
