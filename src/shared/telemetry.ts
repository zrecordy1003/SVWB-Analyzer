/**
 * The wire format between the app and the telemetry Worker.
 *
 * One upload per install per launch (and every few hours after), carrying two
 * things that used to be planned as separate pipelines:
 *
 * - **who is running what**: `appVersion`, `platform`, `arch`, `locale`. The
 *   upload itself is the heartbeat - the server's `activity` table keys on the
 *   UTC date it was *received*, and that is what "active installs" counts.
 * - **what was recorded**: the last `TELEMETRY_WINDOW_DAYS` UTC days of match
 *   history, collapsed into counting buckets. See docs/meta-stats-plan.md D-1.
 *
 * A bucket is a count keyed on the statistical dimensions only. There is no
 * deck name, note, tag, timestamp, BP or MP anywhere in this payload, and no
 * CR *value*: schema 2 carries the five-band `crBand` the match was played in,
 * never the number. The distinction is the whole privacy argument. A CR value
 * changes every game and is close to unique, so a series of them per install
 * reconstructs a ladder trajectory that can be matched against the in-game
 * leaderboard; a band is one more categorical dimension, the same shape as
 * class or play order. The finest thing this payload can say is "this install
 * won 3 ranked games as witch against dragon going first at CR 1750-1849 on
 * 2026-09-02".
 *
 * Every day in the window is sent every time, including empty ones. The server
 * replaces its rows for `(installId, date)` wholesale, so a match the user
 * deleted or corrected disappears or moves on the next upload without any
 * change tracking on either side (plan D-4, and the J-8 decision).
 *
 * Shared by main, the renderer (the settings page shows the payload it would
 * send), the tests, and `server/telemetry` - which imports this file directly
 * so the whitelist it validates against is the one the client writes.
 */
import { ClassName, GameMode, PlayOrder } from './domain.js'
import { CR_BAND_KEYS } from './crBands.js'

/**
 * 2 added `crBand` to every bucket.
 *
 * The server accepts 1 and 2 and will have to keep doing so: the endpoint is
 * compiled into the installer, so an install that never updates sends 1
 * forever. A schema-1 bucket is stored with `crBand = 'unknown'`, which is the
 * same value a schema-2 client sends for a match whose CR was never read - so
 * the two are indistinguishable downstream, and that is correct. Neither says
 * anything about the rank it was played at.
 */
export const TELEMETRY_SCHEMA = 2 as const

/** Schemas the server still ingests. Dropping one silently discards uploads. */
export const TELEMETRY_ACCEPTED_SCHEMAS = [1, 2] as const

/** How many UTC days, today included, each upload covers. */
export const TELEMETRY_WINDOW_DAYS = 14

/**
 * More matches than this in one UTC day is not a person. The server drops the
 * day (and only the day); the client never gets near it. A hard-core 2Pick
 * session tops out well under 100.
 */
export const TELEMETRY_MAX_MATCHES_PER_DAY = 500

/**
 * How much the engine's own record says a row can be trusted.
 *
 * `clean`   - engine-written, no observed column edited, no demoting flag.
 * `edited`  - a person overwrote something a statistic reads (see
 *             `OBSERVED_COLUMNS` in main/data/provenance.ts). The corrected
 *             value is what gets counted; whether that is better or worse than
 *             the engine's is exactly the question P0b in meta-stats-plan is
 *             trying to answer, so the two must stay distinguishable.
 * `flagged` - the engine raised one of `DEMOTING_FLAGS` about this row.
 * `legacy`  - predates migration 008; provenance unknown.
 *
 * All four are uploaded. Which ones a public chart may use is a server-side
 * decision that can change without a client release.
 */
export const TELEMETRY_TIERS = ['clean', 'edited', 'flagged', 'legacy'] as const
export type TelemetryTier = (typeof TELEMETRY_TIERS)[number]

export const TELEMETRY_RESULTS = ['win', 'loss'] as const
export type TelemetryResult = (typeof TELEMETRY_RESULTS)[number]

export const TELEMETRY_CLASSES: readonly string[] = Object.values(ClassName)
export const TELEMETRY_MODES: readonly string[] = Object.values(GameMode)
export const TELEMETRY_PLAY_ORDERS: readonly string[] = Object.values(PlayOrder)
/** `CR_BANDS`' keys plus `unknown`. Defined in `crBands.ts`; see the note there
 *  about why a cut point must never be moved once it has shipped. */
export const TELEMETRY_CR_BANDS: readonly string[] = CR_BAND_KEYS

export type TelemetryBucket = {
  tier: TelemetryTier
  /** `GameMode`; a row whose mode is NULL is sent as `'unknown'`. */
  mode: string
  myClass: string
  oppoClass: string
  playOrder: string
  /**
   * Which `CR_BANDS` band the match was played in, or `'unknown'`.
   *
   * `unknown` is a real value with a real meaning and will be the majority for
   * a long time: CR is only on the ranked screen, the engine does not always
   * read it, and `legacy` rows predate the field entirely. Summing every band
   * therefore reproduces the unsplit numbers exactly - which is the property
   * that lets the server keep serving an unsplit public aggregate while this
   * dimension accumulates.
   */
  crBand: string
  result: TelemetryResult
  count: number
}

export type TelemetryDay = {
  /** UTC calendar date, `YYYY-MM-DD`. */
  date: string
  /** Rows with `result IS NULL` - opened and never closed. Plan D-6. */
  abandoned: number
  /**
   * Rows a person typed in (`source = 'manual'`). Counted so the maintainer can
   * see how much hand entry happens, never bucketed: nothing observed them.
   */
  manual: number
  buckets: TelemetryBucket[]
}

export type TelemetryPayload = {
  schema: typeof TELEMETRY_SCHEMA
  /** Random UUID, minted the first time telemetry is switched on. */
  installId: string
  appVersion: string
  /** `process.platform` */
  platform: string
  /** `process.arch` */
  arch: string
  /** `app.getLocale()` - a BCP 47 tag, e.g. `zh-TW`. */
  locale: string
  /** ISO 8601, the client's clock. Informational; the server stamps its own. */
  sentAt: string
  days: TelemetryDay[]
}

/** What the settings page shows. */
export type TelemetryStatus = {
  enabled: boolean
  /** False when the build has no endpoint to talk to; the switch is then inert. */
  configured: boolean
  endpoint: string | null
  installId: string | null
  /** ISO 8601 of the last upload the server accepted. */
  lastUploadAt: string | null
  /** The most recent failure, cleared by the next success. */
  lastError: string | null
}

/** The server's answer to a successful ingest. */
export type TelemetryIngestResponse = {
  ok: true
  /** Days stored. */
  accepted: number
  /** Days refused, with the reason, so a client bug shows up somewhere. */
  rejected: Array<{ date: string; reason: string }>
}
