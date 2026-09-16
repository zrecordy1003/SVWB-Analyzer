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
