/**
 * Query results in, JSON documents out.
 *
 * `index.ts` runs the SQL; this shapes what comes back into the two documents
 * the Worker serves. Pure, so the shapes can be tested without a database.
 */

// ------------------------------------------------------------------ /v1/meta

/**
 * One row per cell, already folded down from per-install rows by SQL.
 *
 * The per-install grouping happens in the query rather than here: the row
 * count of the ungrouped form is `installs x cells-they-occupy`, which grows
 * without bound, while what SQL hands over is one row per cell carrying both
 * the capped and the uncapped sums plus how many installs stood behind them.
 */
export type MatrixRow = {
  my_class: string
  oppo_class: string
  play_order: string
  /** Distinct installs that contributed to this cell. */
  installs: number
  /** Capped: no install counts for more than `maxPerInstallPerCell`. */
  wins: number
  total: number
  /** Uncapped, so the effect of the cap can be seen rather than trusted. */
  raw_wins: number
  raw_total: number
}

export type MetaCell = {
  myClass: string
  oppoClass: string
  playOrder: string
  /**
   * The numbers to plot. Capped per install (see `sampling`), so one player who
   * has ground out a matchup cannot be more than their cap's share of it.
   */
  wins: number
  total: number
  /** Sample size in PLAYERS, which is the one a matchup table lives or dies by. */
  installs: number
  /** The same cell with no cap applied, so the cap is auditable. */
  rawWins: number
  rawTotal: number
}

export type MetaDocument = {
  generatedAt: string
  /** What was counted: the filter the SQL applied. Stated so a chart can say it. */
  window: { since: string; days: number }
  mode: string
  tiers: string[]
  /** Distinct installs that contributed at least one bucket in the window. */
  installs: number
  /**
   * Sum of every published cell's capped total.
   *
   * Recorder-side observations, not distinct games: a match between two people
   * who both run this app is recorded by both and appears once in `(A vs B)`
   * and once in `(B vs A)`. There is no match id to deduplicate on, by design,
   * so this is an observation count - and `caveats` says so.
   */
  matches: number
  /**
   * One cell per (my class, opponent class, play order) that clears
   * `minInstallsPerCell`. Wins and totals only - the interval is the reader's
   * job (plan D-8), and a cell with a small `total` must be shown as such,
   * never as a bare rate.
   */
  cells: MetaCell[]
  /** Per-class totals from the recorder's side, under the same threshold. */
  byClass: Array<{ myClass: string; wins: number; total: number; installs: number }>
  /**
   * How the numbers above were bounded, and what that hid.
   *
   * Both constants are server-side and can be retuned without a client
   * release. That is the reason the client uploads all four tiers and lets the
   * server decide what to publish.
   */
  sampling: {
    maxPerInstallPerCell: number
    minInstallsPerCell: number
    /** Cells that existed but had too few contributing installs to publish. */
    suppressedCells: number
    /** Raw observations inside those cells, so their absence is not silent. */
    suppressedMatches: number
  }
  /** What these numbers cannot be read as. Travels with the data on purpose. */
  caveats: string[]
}

/**
 * The caveats no amount of code removes, so they ship with the document.
 *
 * A public number gets quoted without its context by default. Putting these in
 * the payload means a chart, a bot or a third party reading `/v1/meta` has them
 * in hand rather than in a README they never opened.
 */
export const META_CAVEATS: readonly string[] = [
  'People who run a tracker are not a random sample of players; read this as the meta among users of this app.',
  'All ranks are pooled. The upload carries no rank or MP, so this cannot be split by skill.',
  'A game between two users of this app is recorded by both and appears in both directions; matches counts observations, not distinct games.',
  'Only engine-recorded matches with nothing hand-corrected and no recognition warning are counted.'
]

export function buildMeta(
  rows: readonly MatrixRow[],
  opts: {
    installs: number
    since: string
    days: number
    mode: string
    tiers: string[]
    maxPerInstallPerCell: number
    minInstallsPerCell: number
    now: Date
  }
): MetaDocument {
  const cells: MetaCell[] = []
  const byClass = new Map<string, { myClass: string; wins: number; total: number }>()
  const classInstalls = new Map<string, number>()
  let matches = 0
  let suppressedCells = 0
  let suppressedMatches = 0

  for (const row of rows) {
    const total = Number(row.total) || 0
    if (total <= 0) continue

    const installs = Number(row.installs) || 0
    /**
     * k-anonymity, and on a PUBLIC endpoint it is not a nicety.
     *
     * With one contributing install a cell IS that person's match record - how
     * often they played this matchup and how it went - and the document prints
     * `installs: 1` beside it, so there is no crowd to hide in. At two or three
     * it stays close enough to that to be worth refusing. A cell is therefore
     * published only once enough separate people stand behind it, and the
     * count of what was withheld goes out in its place: a chart has to be able
     * to say "not enough data yet" rather than draw an empty grid.
     */
    if (installs < opts.minInstallsPerCell) {
      suppressedCells += 1
      suppressedMatches += Number(row.raw_total) || 0
      continue
    }

    const wins = Math.min(Math.max(Number(row.wins) || 0, 0), total)
    cells.push({
      myClass: row.my_class,
      oppoClass: row.oppo_class,
      playOrder: row.play_order,
      wins,
      total,
      installs,
      rawWins: Number(row.raw_wins) || 0,
      rawTotal: Number(row.raw_total) || 0
    })
    matches += total

    const cls = byClass.get(row.my_class) ?? { myClass: row.my_class, wins: 0, total: 0 }
    cls.total += total
    cls.wins += wins
    byClass.set(row.my_class, cls)
    // A class's player count is not the sum of its cells' - one person appears
    // in several of them - so the largest cell is used as the floor the class
    // is known to clear. Understated rather than invented.
    classInstalls.set(row.my_class, Math.max(classInstalls.get(row.my_class) ?? 0, installs))
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
    cells: cells.sort(
      (a, b) =>
        byKey(a, b) ||
        (a.oppoClass < b.oppoClass ? -1 : a.oppoClass > b.oppoClass ? 1 : 0) ||
        (a.playOrder < b.playOrder ? -1 : a.playOrder > b.playOrder ? 1 : 0)
    ),
    byClass: [...byClass.values()]
      .map((row) => ({ ...row, installs: classInstalls.get(row.myClass) ?? 0 }))
      .sort(byKey),
    sampling: {
      maxPerInstallPerCell: opts.maxPerInstallPerCell,
      minInstallsPerCell: opts.minInstallsPerCell,
      suppressedCells,
      suppressedMatches
    },
    caveats: [...META_CAVEATS]
  }
}

// -------------------------------------------------------- /v1/admin/overview

export type ActivityRow = { date: string; installs: number }
/** `installs.first_seen` truncated to its UTC date, grouped. */
export type NewInstallRow = { date: string; installs: number }
export type VersionRow = { app_version: string; installs: number }
export type UploadsRow = { n: number; c: number }
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
export type CrBandRow = {
  cr_band: string
  installs: number
  wins: number
  total: number
}
export type BandMatrixRow = {
  cr_band: string
  my_class: string
  oppo_class: string
  play_order: string
  installs: number
  wins: number
  total: number
}

export type OverviewDocument = {
  generatedAt: string
  today: string
  /** Distinct installs that uploaded at least once in the period. */
  active: { today: number; last7d: number; last30d: number }
  /** Every install ever seen. */
  installs: number
  /**
   * Installs whose `first_seen` falls in the period - the growth number.
   *
   * Not derivable from `active`: an install that arrives and keeps running
   * shows up in `active` every day thereafter, so a flat `active` line can
   * mean either "the same people are staying" or "as many are leaving as
   * arriving", and only this tells the two apart.
   *
   * Counts INSTALLS, not people. A reinstall, a cleared profile or a second
   * machine is a new id here, so read it as an upper bound on new users.
   */
  newInstalls: { last7d: number; last30d: number }
  /**
   * Upload volume, from `installs.uploads` - the other column that was written
   * from the first migration and read by nothing.
   *
   * `perActiveInstall30d` is the operational one. The client aims for one
   * upload shortly after launch, one every six hours it stays open, and one
   * ten minutes after a match, with a 60s floor between attempts - so a figure
   * far above that says the schedule is firing more than it should, and one
   * near zero with a healthy `active` says uploads are being refused
   * somewhere. Neither is visible from active-install counts alone, because a
   * single upload a day and thirty both read as "active".
   */
  uploads: { total30dActive: number; perActiveInstall30d: number }
  /** By the version each install last reported, among installs active in the period. */
  versions: Array<{ appVersion: string; active7d: number; active30d: number }>
  platforms: Array<{ platform: string; active30d: number }>
  /** One row per day for the last 30 days, oldest first; days with no data are present as zeros. */
  series: Array<{
    date: string
    activeInstalls: number
    /** Installs that had at least one match-day row for this date. */
    recordingInstalls: number
    /** Installs seen for the first time on this date. */
    newInstalls: number
    matches: number
    abandoned: number
    manual: number
  }>
  /** Bucketed matches in the last 30 days, split the two ways the server can split them. */
  matchesLast30d: { total: number; byTier: Record<string, number>; byMode: Record<string, number> }
  /**
   * The rank split, on the maintainer's route rather than the public one.
   *
   * Deliberately here and not in `/v1/meta`, and the reason is arithmetic. A
   * public cell needs `META_MIN_INSTALLS_PER_CELL` distinct installs, and every
   * cell that currently clears that floor does so with between five and eleven;
   * multiplying the cell count by the number of bands would take the published
   * matrix to approximately zero. So the dimension is collected now - history
   * cannot be recovered later - and served where there is no floor, while the
   * public aggregate stays unsplit until the install base can carry it. Turning
   * it on there is a constant change with no client release.
   *
   * `crBand: 'unknown'` will dominate for a long time and that is not a fault:
   * CR only exists on the ranked screen, the engine does not always read it,
   * and every row uploaded before schema 2 is `unknown` by definition. Summing
   * the bands reproduces the unsplit totals exactly.
   */
  rank: {
    /** One row per band, ranked mode and the public tiers only. */
    bands: Array<{
      crBand: string
      installs: number
      wins: number
      total: number
    }>
    /**
     * Per band, the matchup cells - no k-anonymity floor applied, because this
     * route is bearer-authenticated and serves one person: its owner.
     */
    cells: Array<{
      crBand: string
      myClass: string
      oppoClass: string
      playOrder: string
      installs: number
      wins: number
      total: number
    }>
  }
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
  uploads30d: UploadsRow | null
  versions7d: readonly VersionRow[]
  versions30d: readonly VersionRow[]
  platforms30d: readonly PlatformRow[]
  activity: readonly ActivityRow[]
  newInstalls: readonly NewInstallRow[]
  matchDays: readonly MatchDayRow[]
  tiers: readonly TierRow[]
  modes: readonly ModeRow[]
  crBands: readonly CrBandRow[]
  bandCells: readonly BandMatrixRow[]
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
  const fresh = new Map(input.newInstalls.map((row) => [row.date, Number(row.installs) || 0]))
  const matchDays = new Map(input.matchDays.map((row) => [row.date, row]))
  const dates = lastDates(input.now, 30)
  const series = dates.map((date) => {
    const day = matchDays.get(date)
    return {
      date,
      activeInstalls: activity.get(date) ?? 0,
      recordingInstalls: Number(day?.installs) || 0,
      newInstalls: fresh.get(date) ?? 0,
      matches: Number(day?.matches) || 0,
      abandoned: Number(day?.abandoned) || 0,
      manual: Number(day?.manual) || 0
    }
  })

  // Summed from the series rather than asked of the database twice, so the
  // totals cannot disagree with the days they are the total of.
  const sinceDay7 = dates[dates.length - 7]
  const newInstalls = {
    last7d: series.reduce((n, row) => (row.date >= sinceDay7 ? n + row.newInstalls : n), 0),
    last30d: series.reduce((n, row) => n + row.newInstalls, 0)
  }

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
    newInstalls,
    uploads: {
      total30dActive: Number(input.uploads30d?.n) || 0,
      // Rounded to one place: it is a ratio read at a glance, and the extra
      // digits would only invite reading precision into it that is not there.
      perActiveInstall30d: input.uploads30d?.c
        ? Math.round((Number(input.uploads30d.n) / Number(input.uploads30d.c)) * 10) / 10
        : 0
    },
    versions: [...versions.values()].sort(
      (a, b) => b.active30d - a.active30d || (a.appVersion < b.appVersion ? 1 : -1)
    ),
    platforms: input.platforms30d
      .map((row) => ({ platform: row.platform, active30d: Number(row.installs) || 0 }))
      .sort((a, b) => b.active30d - a.active30d),
    series,
    matchesLast30d: { total, byTier, byMode },
    rank: {
      bands: input.crBands
        .map((row) => ({
          crBand: row.cr_band,
          installs: Number(row.installs) || 0,
          wins: Number(row.wins) || 0,
          total: Number(row.total) || 0
        }))
        .sort((a, b) => b.total - a.total),
      cells: input.bandCells.map((row) => ({
        crBand: row.cr_band,
        myClass: row.my_class,
        oppoClass: row.oppo_class,
        playOrder: row.play_order,
        installs: Number(row.installs) || 0,
        wins: Number(row.wins) || 0,
        total: Number(row.total) || 0
      }))
    }
  }
}
