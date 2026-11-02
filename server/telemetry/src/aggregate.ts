/**
 * Query results in, JSON documents out.
 *
 * `index.ts` runs the SQL; this shapes what comes back into the two documents
 * the Worker serves. Pure, so the shapes can be tested without a database.
 */
import {
  CARD_PACK_RELEASES,
  currentSeason,
  metaSeasonStart,
  type MetaCell,
  type MetaDocument,
  type MetaSeason
} from '../../../src/shared/meta'

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

/**
 * The published shapes are declared in `src/shared/meta.ts` and re-exported
 * here.
 *
 * They are the wire format, and the app reads them: keeping a second copy
 * beside the query that fills it is how a server field and the page that draws
 * it drift apart while both compile. Same arrangement as `validate.ts`, which
 * validates against the client's own constants rather than a transcription of
 * them.
 */
export type { MetaCell, MetaDocument } from '../../../src/shared/meta'

/**
 * The caveats no amount of code removes, so they ship with the document.
 *
 * Written in Traditional Chinese because the only client is this app and its
 * interface is Chinese, and because a caveat nobody reads is a caveat that does
 * not work. Translating on the client was the alternative and it was rejected:
 * the page's whole claim is that it says what the server says, so that the day
 * the sampling rules change the wording changes with them - a lookup table in
 * the renderer would go stale silently the first time a fifth caveat appeared.
 * A future non-Chinese client is the cost, and the fix then is a `Lang` header
 * here, not a dictionary over there.
 *
 * A public number gets quoted without its context by default. Putting these in
 * the payload means a chart, a bot or a third party reading `/v1/meta` has them
 * in hand rather than in a README they never opened.
 */
export const META_CAVEATS: readonly string[] = [
  '會裝分析工具的玩家不是隨機抽樣，所以這是「這個 app 的使用者之間」的環境，不等於天梯全體。',
  '所有段位混在一起算。上傳的內容不含段位與 MP，所以拆不開。',
  '兩個都在用這個 app 的人對戰，同一場會被雙方各記一次、在矩陣的兩個方向各出現一次；場次算的是觀測數，不是不重複的對局數。',
  '只計入引擎自己記錄、沒有手動修改過、也沒有辨識警告的對局。'
]

/**
 * The dates `/v1/meta` counts: the last `days` UTC dates up to today, cut at
 * the start of the current card pack's environment.
 *
 * `days` in the result is the span actually counted, so a page that prints
 * "14 天" never does so over four days of data. It is 0 on a release day,
 * whose first clean date is tomorrow; the query then matches nothing, which is
 * the honest answer.
 */
export function metaWindow(
  now: Date,
  days: number,
  releases: readonly MetaSeason[] = CARD_PACK_RELEASES
): { since: string; days: number; season?: MetaSeason } {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const windowStart = utcDate(today - (days - 1) * DAY_MS)
  const season = currentSeason(now, releases)
  if (!season) return { since: windowStart, days }

  const seasonStart = metaSeasonStart(season)
  if (seasonStart <= windowStart) return { since: windowStart, days, season }
  return {
    since: seasonStart,
    days: Math.max(0, (today - Date.parse(`${seasonStart}T00:00:00Z`)) / DAY_MS + 1),
    season
  }
}

export function buildMeta(
  rows: readonly MatrixRow[],
  opts: {
    installs: number
    since: string
    days: number
    season?: MetaSeason
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
    window: {
      since: opts.since,
      days: opts.days,
      ...(opts.season ? { season: { ...opts.season } } : {})
    },
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
export type RawMatrixRow = {
  tier: string
  my_class: string
  oppo_class: string
  play_order: string
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
  /**
   * The matrix with nothing held back: no per-install cap, no k-anonymity
   * floor, and every tier rather than only `clean`.
   *
   * This answers a different question from `/v1/meta` and must not be confused
   * with it. The public document deliberately bounds what any one person can
   * contribute to a cell and refuses to publish a cell too few people stand
   * behind; both of those exist because that endpoint is public and
   * unauthenticated. Here there is one reader, holding a bearer token, who
   * needs to know what the raw pile actually contains - including the cells the
   * public path withholds and the tiers it does not trust.
   *
   * `installs` is still reported per cell, and that is the point rather than a
   * leftover: with the floor gone, the honest replacement for suppression is
   * showing the concentration instead of hiding it. A cell of 40 games from one
   * install is one person's record and the number says so.
   *
   * Scoped to `META_MODE` so it stays a matchup table - mixing 2Pick into a
   * constructed matrix compares different formats - but keyed by tier so the
   * reader can decide what to trust without another request.
   */
  raw: {
    /** What was counted, so a chart can state it rather than imply it. */
    scope: { days: number; mode: string }
    cells: Array<{
      tier: string
      myClass: string
      oppoClass: string
      playOrder: string
      installs: number
      wins: number
      total: number
    }>
  }
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
  rawCells: readonly RawMatrixRow[]
  rawScope: { days: number; mode: string }
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
    raw: {
      scope: input.rawScope,
      cells: input.rawCells.map((row) => ({
        tier: row.tier,
        myClass: row.my_class,
        oppoClass: row.oppo_class,
        playOrder: row.play_order,
        installs: Number(row.installs) || 0,
        wins: Number(row.wins) || 0,
        total: Number(row.total) || 0
      }))
    },
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

// --------------------------------------------------------- /v1/admin/opening

/**
 * One grouped row of `opening_buckets`: a card, a mulligan decision, the band
 * the rest of the hand fell in, and how that went.
 *
 * The grouping is deliberately NOT folded down to one row per card in SQL. The
 * whole reason `rest_band` is in the table (see `0004_opening_buckets.sql`) is
 * that kept-versus-swapped compared without it compares two different
 * populations; a query that summed the bands away here would hand the
 * dashboard exactly the confounded number the column exists to prevent.
 */
export type OpeningCellRow = {
  card_id: number
  /** SQLite has no boolean: 1 = survived the mulligan, 0 = thrown back. */
  kept: number
  rest_band: number | null
  result: string
  n: number
}

/** Per card, the two things a per-(card, kept, band, result) grouping cannot give. */
export type OpeningCardRow = {
  card_id: number
  /** Distinct installs. Not derivable by summing the grouped rows - the same
   *  install appears in several of them. */
  installs: number
  n: number
}

export type OpeningDayRow = { date: string; installs: number; n: number }

/** One stratum of one card's keep comparison. `band: null` is a real band. */
export type OpeningBand = {
  /** 0 = the other three cards were cheapest, 2 = most expensive, null = a
   *  companion's cost was unknown to the client. */
  band: number | null
  keptWins: number
  keptTotal: number
  swappedWins: number
  swappedTotal: number
}

export type OpeningCard = {
  cardId: number
  /** Distinct installs that ever had this card in a pre-mulligan hand. */
  installs: number
  /** COPIES dealt, not matches: a hand holding two of something counts twice,
   *  which is the unit the client's own advisor counts in. */
  dealt: number
  kept: number
  bands: OpeningBand[]
}

export type OpeningDocument = {
  generatedAt: string
  window: { since: string; days: number }
  /** What was counted, so the page can state it rather than imply it. */
  scope: { mode: string; tiers: string[] }
  coverage: {
    observations: number
    installs: number
    cards: number
    /**
     * Observations whose `rest_band` is null, i.e. the client could not price
     * one of the other three cards.
     *
     * Reported rather than quietly dropped because it is the one number that
     * says how much of the pile the stratified comparison may use. Those rows
     * are usable pooled and unusable stratified, exactly as the in-app advisor
     * treats them, so a large share here means the adjusted differences below
     * rest on much less data than `observations` suggests.
     */
    unbanded: number
    /** Cards omitted from `cards` by `maxCards`, so truncation is visible. */
    truncatedCards: number
    /**
     * The whole window's observations by tier and by mode, INCLUDING the ones
     * `scope` filters out.
     *
     * The point is to show what the scope dropped. A tier split computed after
     * filtering to `clean` would be a bar chart with one bar, which answers
     * nothing about whether the filter is throwing away half the data.
     */
    byTier: Record<string, number>
    byMode: Record<string, number>
  }
  /** One row per day, oldest first, zero-filled. */
  series: Array<{ date: string; observations: number; installs: number }>
  /** Sorted by `dealt`, descending, capped at `maxCards`. */
  cards: OpeningCard[]
}

/**
 * Shape the opening-hand pile into the document above.
 *
 * Counts only, no rates, no intervals, no verdicts - the same division of
 * labour as `/v1/meta` (`docs/meta-stats-plan.md` D-8). Whether a card has
 * enough observations to say anything about, and what "enough" means, is a
 * presentation decision that the dashboard makes and can change without
 * touching a deployed Worker.
 *
 * No k-anonymity floor: this route is bearer-authenticated and serves its
 * owner. `installs` is reported per card for the same reason it is on the raw
 * matrix - with no floor, the honest replacement for suppression is showing
 * the concentration rather than hiding it.
 */
export function buildOpening(input: {
  now: Date
  since: string
  days: number
  mode: string
  tiers: string[]
  cells: readonly OpeningCellRow[]
  cardTotals: readonly OpeningCardRow[]
  dayRows: readonly OpeningDayRow[]
  tierSplit: readonly TierRow[]
  modeSplit: readonly ModeRow[]
  installs: number
  maxCards: number
}): OpeningDocument {
  const byCard = new Map<number, OpeningCard>()
  let observations = 0
  let unbanded = 0

  for (const row of input.cells) {
    const cardId = Number(row.card_id)
    const n = Number(row.n) || 0
    if (!Number.isFinite(cardId) || n <= 0) continue

    const card = byCard.get(cardId) ?? { cardId, installs: 0, dealt: 0, kept: 0, bands: [] }
    const band = row.rest_band === null ? null : Number(row.rest_band)
    let stratum = card.bands.find((entry) => entry.band === band)
    if (!stratum) {
      stratum = { band, keptWins: 0, keptTotal: 0, swappedWins: 0, swappedTotal: 0 }
      card.bands.push(stratum)
    }

    const won = row.result === 'win'
    if (Number(row.kept) === 1) {
      stratum.keptTotal += n
      if (won) stratum.keptWins += n
      card.kept += n
    } else {
      stratum.swappedTotal += n
      if (won) stratum.swappedWins += n
    }
    card.dealt += n
    observations += n
    if (band === null) unbanded += n
    byCard.set(cardId, card)
  }

  for (const row of input.cardTotals) {
    const card = byCard.get(Number(row.card_id))
    if (card) card.installs = Number(row.installs) || 0
  }

  // `null` last: it is the band that cannot enter the stratified comparison,
  // and a reader scanning the drill-down should meet 0/1/2 in order first.
  const ordered = [...byCard.values()].sort((a, b) => b.dealt - a.dealt || a.cardId - b.cardId)
  for (const card of ordered) {
    card.bands.sort((a, b) =>
      a.band === null ? 1 : b.band === null ? -1 : a.band - b.band
    )
  }

  const byTier: Record<string, number> = {}
  for (const row of input.tierSplit) byTier[row.tier] = Number(row.n) || 0
  const byMode: Record<string, number> = {}
  for (const row of input.modeSplit) byMode[row.mode] = Number(row.n) || 0

  const days = new Map(input.dayRows.map((row) => [row.date, row]))
  const series = lastDates(input.now, input.days).map((date) => ({
    date,
    observations: Number(days.get(date)?.n) || 0,
    installs: Number(days.get(date)?.installs) || 0
  }))

  return {
    generatedAt: input.now.toISOString(),
    window: { since: input.since, days: input.days },
    scope: { mode: input.mode, tiers: [...input.tiers] },
    coverage: {
      observations,
      installs: input.installs,
      cards: ordered.length,
      unbanded,
      truncatedCards: Math.max(0, ordered.length - input.maxCards),
      byTier,
      byMode
    },
    series,
    cards: ordered.slice(0, input.maxCards)
  }
}
