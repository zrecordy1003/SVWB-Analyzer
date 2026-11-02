/**
 * The public aggregate's wire format: what `GET /v1/meta` answers with.
 *
 * This is the other half of `shared/telemetry.ts`. That file is what an install
 * SENDS; this is what the Worker gives back once every install's buckets have
 * been folded together - the 環境 page's whole data source, and the one document
 * a web version or a third party would read too.
 *
 * It lives in `src/shared` rather than beside the Worker for the same reason
 * the upload format does: both processes and the server speak it, so a change
 * that the server makes and the page does not expect must fail to compile
 * rather than fail on screen. `server/telemetry/src/aggregate.ts` imports these
 * types and re-exports them; there is no second declaration to keep in sync.
 *
 * Two properties of the document are worth knowing before reading a field:
 *
 * - **It carries counts, never rates.** Every cell is `wins` and `total`, and
 *   the interval is computed where it is drawn (plan D-8). A server that
 *   published `winRate: 100` for a 1-0 cell would be handing out a number that
 *   cannot be qualified afterwards.
 * - **It is bounded, and it says how.** `sampling` states the per-install cap
 *   and the k-anonymity floor that produced the numbers above it, including how
 *   much was withheld - so a page can say "not enough data yet" rather than
 *   draw an empty grid and let the reader assume nobody plays that matchup.
 */

/** One (my class, opponent class, play order) cell of the public matrix. */
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
  /**
   * What was counted: the filter the SQL applied. Stated so a chart can say it.
   *
   * `days` is the span actually counted, which is shorter than the one asked
   * for when a card pack came out inside it. `season` names that pack; it is
   * absent from documents made before the Worker knew about seasons, and when
   * no release in `CARD_PACK_RELEASES` has happened yet.
   */
  window: { since: string; days: number; season?: MetaSeason }
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
 * The windows the page offers, in days.
 *
 * Fourteen first because it is the server's own default and therefore the one
 * window whose response is already warm in the edge cache; 7 for "since the
 * patch", 30 for "the season so far". Nothing longer: the Worker prunes
 * `buckets` at `RETAIN_MATCH_DAYS`, so a 90-day request - which the endpoint
 * would accept - returns the same rows as 30 does today while implying it
 * looked further back.
 */
export const META_WINDOW_DAYS = [7, 14, 30] as const
export type MetaWindowDays = (typeof META_WINDOW_DAYS)[number]

/** A card pack that started a new environment, as the document reports it. */
export type MetaSeason = {
  name: string
  /** The release instant, ISO 8601 in UTC. */
  releasedAt: string
}

/**
 * Card pack releases, oldest first. The public aggregate never counts a day
 * from before the latest one that has happened: a matchup table that mixes two
 * card pools describes neither.
 *
 * Adding a pack is adding a line here and redeploying the Worker - nothing
 * else reads a date. An entry may go in ahead of time; it takes effect once
 * `releasedAt` has passed. Old clients need no update, since the cut is made in
 * the server's query.
 *
 * `releasedAt` is when the pack went live (the end of the release maintenance),
 * not the date on the announcement, because the boundary is drawn from it to
 * the hour - see `metaSeasonStart`.
 */
export const CARD_PACK_RELEASES: readonly MetaSeason[] = [
  // 第 10 彈「ニーゲルヘリア神殺事件」。維護 10/28 14:00–17:00 JST，17:00 JST 開放。
  // https://x.com/shadowverse_jp/status/2111034415589855531
  { name: '第 10 彈 Deicide in Nacreheim', releasedAt: '2026-10-28T08:00:00Z' }
]

/** The latest release that has happened by `now`, or null before the first one. */
export function currentSeason(
  now: Date,
  releases: readonly MetaSeason[] = CARD_PACK_RELEASES
): MetaSeason | null {
  let current: MetaSeason | null = null
  for (const release of releases) {
    const at = Date.parse(release.releasedAt)
    if (at <= now.getTime() && (!current || at > Date.parse(current.releasedAt))) current = release
  }
  return current
}

/**
 * The first UTC date that holds only games from `season`.
 *
 * Buckets are per UTC date (plan D-7), so a release at 08:00 UTC shares its
 * date with eight hours of the old environment, and there is no finer grain
 * to split it on. That day is left out rather than let in: losing most of a
 * day of the new pool costs a little sample, while counting the old one is
 * the exact thing this cut exists to prevent. A release at UTC midnight starts
 * on its own date.
 */
export function metaSeasonStart(season: MetaSeason): string {
  const DAY_MS = 86_400_000
  const at = Date.parse(season.releasedAt)
  return new Date(Math.ceil(at / DAY_MS) * DAY_MS).toISOString().slice(0, 10)
}

/**
 * A fetched document plus the two things the page has to say about it that the
 * document itself cannot.
 *
 * `fetchedAt` is when THIS app last received it, which is not `generatedAt`:
 * the Worker caches for 15 minutes at the edge, so a document generated at
 * 10:00 can be received at 10:14, and a page that showed only `generatedAt`
 * would look stale to someone who just pressed refresh.
 */
export type MetaSnapshot = {
  document: MetaDocument
  fetchedAt: string
  /** Answered from this process's own copy rather than the network. */
  cached: boolean
}
