/**
 * Records what the analyzer notices about its own uncertainty.
 *
 * Recognition failures are mostly invisible to the user: a template score that
 * has drifted to just under its threshold, an OCR read that came back as
 * nonsense, a result screen that could not be attributed to any game mode. The
 * user only ever sees "my match wasn't recorded" - which is not enough to
 * diagnose anything. So the app writes down its own doubts, and the user can
 * export them from the settings page if they want to report a problem.
 *
 * Everything here is local. Nothing is uploaded.
 *
 * This module runs inside the analyzer's `utilityProcess`, which cannot call
 * `app.getPath`, so the directory is handed in via `configureDiagnostics`.
 */
import fs from 'fs'
import path from 'path'

/** Anomaly categories. Only some are worth spending a saved frame on. */
export type DiagnosticKind =
  /** A score landed just below its threshold - a template drifting out of date. */
  | 'near-miss'
  /** OCR returned something that is not an integer. */
  | 'ocr-reject'
  /** A result screen that no mode probe could account for. */
  | 'mode-unattributable'
  /** Own/enemy class or play order could not be read, so the battle is dropped. */
  | 'class-unrecognised'
  /** The mode was never identified, so it was defaulted rather than detected. */
  | 'mode-guessed'
  /** A ranked match finished without a single BP/MP/CR value being captured. */
  | 'ranked-no-numbers'
  /** A tick took longer than its budget, which can miss short-lived overlays. */
  | 'tick-over-budget'
  /**
   * A weak, uncalibrated mode probe (plaza / custom) was accepted. Neither has
   * a verified positive sample, and one of them mislabelled a ranked match as
   * `weekendPlaza`, so every acceptance keeps its frame for review.
   */
  | 'weak-mode-accepted'
  /**
   * The result screen's score-system label contradicted an earlier mode guess
   * and overrode it. A rise here means a weak probe is firing on the wrong
   * screens - the correction worked, but the guess should not have happened.
   */
  | 'mode-corrected'
  /**
   * The wait for the final result screen ran all the way to its backstop - ten
   * minutes with no result screen, no next match and no replay. The player quit
   * to the title screen, or the capture died. It is NOT what a slow reward
   * screen produces any more; if this starts appearing again, one of the exits
   * in `Machine::close_on_missing_final_screen` has stopped working.
   */
  | 'final-screen-never-seen'
  /**
   * The next match's versus screen closed a match that was still waiting for its
   * result screen - the player skipped it and queued up again. The outcome is
   * kept; the numbers on the screen they skipped are not.
   */
  | 'closed-by-next-match'
  /** Capture stopped while a match was still waiting for its result screen. */
  | 'closed-by-capture-stop'

// Which kinds warrant a saved frame is decided by the engine, in
// `tools/engine/src/diagnostics.rs`, because that is the process that writes
// them. A copy of that list here would be a second source of truth for the same
// decision - the exact habit that produced `check-rois.cjs` and the 953-line
// replay mirror.

/**
 * Kinds that can fire on every tick, so they are counted and summarised rather
 * than written one row at a time.
 */
const AGGREGATED_KINDS: ReadonlySet<DiagnosticKind> = new Set<DiagnosticKind>([
  'near-miss',
  'tick-over-budget'
])

/** How far below a threshold still counts as a near miss. */
export const NEAR_MISS_BAND = 0.12

const EVENT_THROTTLE_MS = 60_000
const AGGREGATE_FLUSH_MS = 60_000
const MAX_EVENTS_BYTES = 512 * 1024

const EVENTS_FILE = 'events.jsonl'
const EVENTS_PREVIOUS_FILE = 'events.previous.jsonl'
const FRAMES_DIR = 'frames'

type Config = {
  dir: string
  enabled: boolean
  appVersion: string
  platform: string
}

type Aggregate = {
  count: number
  /** The single worst observation in this window. */
  worst: number
  threshold: number
  /** Whether a larger number is the bad direction - true for durations. */
  worseIsHigher: boolean
  firstAt: number
}

let config: Config | null = null
const lastEventAt = new Map<string, number>()
const aggregates = new Map<string, Aggregate>()
let aggregateTimer: NodeJS.Timeout | null = null

/** Called once from the analyzer's init handler. */
export function configureDiagnostics(next: Config): void {
  config = next
  if (!next.enabled) return
  try {
    fs.mkdirSync(path.join(next.dir, FRAMES_DIR), { recursive: true })
  } catch (e) {
    // Losing diagnostics must never stop the analyzer from doing its real job.
    console.warn('[Diag] cannot create diagnostics dir:', (e as Error).message)
    config = null
  }
}

export function isDiagnosticsEnabled(): boolean {
  return config !== null && config.enabled
}

function appendEvent(record: Record<string, unknown>): void {
  if (!config) return
  const file = path.join(config.dir, EVENTS_FILE)
  try {
    // Keep one previous generation so a burst cannot erase earlier context.
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size > MAX_EVENTS_BYTES) {
      fs.renameSync(file, path.join(config.dir, EVENTS_PREVIOUS_FILE))
    }
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        at: new Date().toISOString(),
        appVersion: config.appVersion,
        ...record
      })}\n`
    )
  } catch (e) {
    console.warn('[Diag] cannot write event:', (e as Error).message)
  }
}

/** True when this key may write again. */
function passesThrottle(map: Map<string, number>, key: string, windowMs: number): boolean {
  const now = Date.now()
  const last = map.get(key)
  if (last !== undefined && now - last < windowMs) return false
  map.set(key, now)
  return true
}

function flushAggregates(): void {
  if (!config || aggregates.size === 0) return
  for (const [key, agg] of aggregates) {
    // A label may contain spaces, so split on the first separator only.
    const sep = key.indexOf(' ')
    appendEvent({
      kind: key.slice(0, sep),
      label: key.slice(sep + 1),
      count: agg.count,
      worst: Number(agg.worst.toFixed(4)),
      threshold: agg.threshold,
      windowStartedAt: new Date(agg.firstAt).toISOString()
    })
  }
  aggregates.clear()
}

function bumpAggregate(
  kind: DiagnosticKind,
  label: string,
  value: number,
  threshold: number,
  worseIsHigher: boolean
): void {
  const key = `${kind} ${label}`
  const existing = aggregates.get(key)
  if (existing) {
    existing.count += 1
    existing.worst = worseIsHigher
      ? Math.max(existing.worst, value)
      : Math.min(existing.worst, value)
  } else {
    aggregates.set(key, { count: 1, worst: value, threshold, worseIsHigher, firstAt: Date.now() })
  }

  if (!aggregateTimer) {
    aggregateTimer = setTimeout(() => {
      aggregateTimer = null
      flushAggregates()
    }, AGGREGATE_FLUSH_MS)
    // Never hold the process open just to flush counters.
    aggregateTimer.unref?.()
  }
}

/**
 * Note a score that came close to its threshold without clearing it.
 *
 * Silent unless the score is inside the near-miss band, so this is safe to call
 * on every comparison. These are the failures a user can never report, because
 * nothing visibly goes wrong until the score finally drops far enough.
 */
export function noteScore(label: string, score: number, threshold: number): void {
  if (!isDiagnosticsEnabled()) return
  if (score >= threshold || score < threshold - NEAR_MISS_BAND) return
  bumpAggregate('near-miss', label, score, threshold, false)
}

/**
 * Note a tick that exceeded its budget. Worth tracking because the play-order
 * overlay is only visible for about two ticks - a slow tick can miss it outright.
 */
export function noteSlowTick(elapsedMs: number, budgetMs: number): void {
  if (!isDiagnosticsEnabled()) return
  bumpAggregate('tick-over-budget', 'tick', elapsedMs, budgetMs, true)
}

/** Note a one-off anomaly that does not need a frame to understand. */
export function noteEvent(
  kind: DiagnosticKind,
  label: string,
  detail: Record<string, unknown> = {}
): void {
  if (!isDiagnosticsEnabled()) return
  if (AGGREGATED_KINDS.has(kind)) return
  if (!passesThrottle(lastEventAt, `${kind} ${label}`, EVENT_THROTTLE_MS)) return
  appendEvent({ kind, label, ...detail })
}

/**
 * Note an anomaly the engine already saved a frame for.
 *
 * The engine writes the PNG, because it is the process holding the pixels; this
 * writes the sidecar beside it and the row in `events.jsonl`, because this is
 * the process holding the bookkeeping. Each side also throttles what it writes -
 * a throttle here applied after the engine had written a PNG would leave orphans
 * on disk, so the frame cap and its 30s window live in `tools/engine/src/
 * diagnostics.rs` and only the event throttle lives here.
 *
 * `frameFile` is absent for kinds that do not warrant an image, which is the
 * ordinary case - it still produces an event.
 */
export function noteFromEngine(
  kind: DiagnosticKind,
  label: string,
  detail: Record<string, unknown> = {}
): void {
  if (!isDiagnosticsEnabled() || !config) return
  if (AGGREGATED_KINDS.has(kind)) return
  if (!passesThrottle(lastEventAt, `${kind} ${label}`, EVENT_THROTTLE_MS)) return
  appendEvent({ kind, label, ...detail })

  const frameFile = typeof detail.frame === 'string' ? detail.frame : null
  if (!frameFile) return

  // The sidecar mirrors the shape tools/vision-node-addon/check-*.cjs consume,
  // so a user's report can be dropped straight into tests/fixtures/captures as a
  // regression case.
  const base = path.join(config.dir, FRAMES_DIR, frameFile.replace(/\.png$/, ''))
  try {
    fs.writeFileSync(
      `${base}.json`,
      `${JSON.stringify(
        {
          kind,
          label,
          at: new Date().toISOString(),
          appVersion: config.appVersion,
          platform: config.platform,
          ...detail
        },
        null,
        2
      )}
`
    )
  } catch (e) {
    console.warn('[Diag] cannot write frame sidecar:', (e as Error).message)
  }
}

/** Write out any pending counters, e.g. before the process stops. */
export function flushDiagnostics(): void {
  if (!isDiagnosticsEnabled()) return
  if (aggregateTimer) {
    clearTimeout(aggregateTimer)
    aggregateTimer = null
  }
  flushAggregates()
}
