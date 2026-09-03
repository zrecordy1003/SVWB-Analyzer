/**
 * What the one-second game poll decides, as a pure function.
 *
 * # Why this is not in `index.ts` any more
 *
 * It was: `startPollingForGame()` held six pieces of mutable state in one
 * closure and from them decided capture attach/detach, the analyzer's
 * lifecycle, idle shutdown by three separate routes, the change-gated
 * `game:status` broadcast, and a one-shot notification. It had no tests, and
 * `docs/project-status-roadmap.md` has called it the highest
 * value-per-hour item on the list for a while - because it is where the
 * remaining hard-to-reproduce bugs live, and because an end-to-end test cannot
 * reach most of its branches: nearly all of them need a real game window and a
 * real `hwnd`.
 *
 * The engine solved the same problem the same way. `tools/engine/src/machine.rs`
 * is a pure `(phase, reading, now) -> decision`, and that is what let the
 * incident history buried in the old analyzer's comments become `#[test]`s.
 * This is that move applied to the host: `(state, observation) -> actions`,
 * with the clock, the OS and the windows all on the caller's side.
 *
 * # The shape
 *
 * `decidePoll` returns the NEXT state and an ORDERED list of actions. Order is
 * part of the contract, not an accident: the analyzer must be up before a
 * capture attach, because the engine owns capture and cannot be attached to
 * before it exists.
 *
 * Nothing here reads a clock, a store or a window. `now` and `systemIdle`
 * arrive in the observation, which is what makes a thirty-minute timeout
 * testable in a microsecond.
 */
import type { GameStatus } from '../shared/types.js'

/** Thirty minutes, in seconds - the shape `powerMonitor.getSystemIdleTime` wants. */
export const IDLE_THRESHOLD_SECONDS = 1800

const IDLE_THRESHOLD_MS = IDLE_THRESHOLD_SECONDS * 1000

/**
 * A minimised window's origin on Windows.
 *
 * Not a sentinel this code invented: Win32 parks minimised windows there, so
 * `-32000` is how a minimise is detected without asking for a window state the
 * detector does not read.
 */
export const MINIMIZED_ORIGIN = -32000

/** Everything one tick learns from outside the process. */
export type PollObservation = {
  now: number
  running: boolean
  /**
   * The window's origin, or null when the detector could not read one.
   *
   * Absent bounds and a minimised window are treated the same way - neither
   * can be captured - but they are distinct observations and the notification
   * says so.
   */
  bounds: { x: number; y: number } | null
  hwnd: number | null
  /** The engine has decoded at least one frame from its current attachment. */
  receivingFrames: boolean
  /** `powerMonitor.getSystemIdleTime()` past the threshold. */
  systemIdle: boolean
}

/**
 * What the poll remembers between ticks.
 *
 * The two timestamps are the whole of the timeout logic: everything else is
 * derived from them and `now`. They are null until the game has been seen at
 * all, which is why a fresh launch with no game never shuts an analyzer down
 * that it never started.
 */
export type PollState = {
  /** Whether an attach has been requested and still needs a matching detach. */
  captureRequested: boolean
  analyzerRunning: boolean
  /** One-shot debounce for the minimised notification. */
  minimizedNoticeSent: boolean
  /** Last time the game was running, minimised or not. */
  lastRunningAt: number | null
  /** Last time the game was running AND capturable. */
  lastUnpausedAt: number | null
  /** Last status broadcast, so the change gate is a comparison and not a side effect. */
  lastStatus: GameStatus | null
}

export const initialPollState: PollState = {
  captureRequested: false,
  analyzerRunning: false,
  minimizedNoticeSent: false,
  lastRunningAt: null,
  lastUnpausedAt: null,
  lastStatus: null
}

/**
 * What the caller should do, in this order.
 *
 * `startAnalyzer` before `attachCapture` is the one ordering that matters -
 * see the header - and the tests assert on the array rather than on a set for
 * that reason.
 */
export type PollAction =
  | { type: 'broadcastStatus'; status: GameStatus }
  | { type: 'startAnalyzer' }
  | { type: 'stopAnalyzer' }
  | { type: 'attachCapture'; hwnd: number }
  | { type: 'detachCapture' }
  | { type: 'notifyMinimized' }

export type PollDecision = { state: PollState; actions: PollAction[] }

const sameStatus = (a: GameStatus | null, b: GameStatus): boolean =>
  a !== null && a.running === b.running && a.paused === b.paused && a.capturing === b.capturing

export function decidePoll(state: PollState, observation: PollObservation): PollDecision {
  const { now, running, bounds, hwnd, receivingFrames, systemIdle } = observation
  const actions: PollAction[] = []

  const hasBounds = bounds !== null
  const minimized = hasBounds && bounds.x === MINIMIZED_ORIGIN && bounds.y === MINIMIZED_ORIGIN
  /** Running but not capturable. Absent bounds counts, the same as minimised. */
  const paused = running && (!hasBounds || minimized)
  const capturable = running && !paused && hwnd !== null

  // A visible window is merely a capture target. Only the engine's first-frame
  // event proves that pixels have actually reached recognition.
  const status: GameStatus = { running, paused, capturing: capturable && receivingFrames }
  if (!sameStatus(state.lastStatus, status)) {
    actions.push({ type: 'broadcastStatus', status })
  }

  // Written before the timeouts are measured, which is what makes a running
  // game's elapsed time zero rather than one tick.
  const lastRunningAt = running ? now : state.lastRunningAt
  const lastUnpausedAt = running && !paused ? now : state.lastUnpausedAt

  const closedTooLong =
    !running && lastRunningAt !== null && now - lastRunningAt >= IDLE_THRESHOLD_MS
  const minimizedTooLong =
    running && lastUnpausedAt !== null && now - lastUnpausedAt >= IDLE_THRESHOLD_MS

  let analyzerRunning = state.analyzerRunning
  let captureRequested = state.captureRequested

  /**
   * Capture follows the window, and it needs the analyzer first.
   *
   * The attach is re-issued on every capturable tick, not only on the edge.
   * That is deliberate and load-bearing: the attach is idempotent, and
   * re-sending it is what re-establishes capture after the engine has
   * restarted - there is no other signal that it did.
   */
  if (capturable) {
    if (!analyzerRunning) {
      actions.push({ type: 'startAnalyzer' })
      analyzerRunning = true
    }
    actions.push({ type: 'attachCapture', hwnd: hwnd as number })
    captureRequested = true
  } else if (captureRequested) {
    actions.push({ type: 'detachCapture' })
    captureRequested = false
  }

  /**
   * The minimised notification: once per minimise, and only while the game is
   * running.
   *
   * The flag is cleared when the window comes back rather than when the game
   * closes, so alt-tabbing away and back twice notifies twice. Closing the
   * game clears it too, which is what makes the next launch able to notify.
   */
  let minimizedNoticeSent = state.minimizedNoticeSent
  if (running) {
    if (minimizedNoticeSent && !minimized && hasBounds) minimizedNoticeSent = false
    if (!minimizedNoticeSent && (minimized || !hasBounds)) {
      minimizedNoticeSent = true
      actions.push({ type: 'notifyMinimized' })
    }
  } else {
    minimizedNoticeSent = false
  }

  /**
   * The analyzer outlives the game window by half an hour, on purpose: closing
   * it on every alt-tab would mean paying the engine's start-up cost for a
   * coffee break. Three routes to a shutdown, and idle is the only one that
   * does not involve the game at all.
   */
  const stopAnalyzer = systemIdle || closedTooLong || minimizedTooLong
  if (stopAnalyzer) {
    if (analyzerRunning) {
      actions.push({ type: 'stopAnalyzer' })
      analyzerRunning = false
      /**
       * Capture goes with it, and it has to be said out loud.
       *
       * The engine owns capture, so stopping the engine ends capture whether
       * anyone tracks that or not. What used to happen: the idle rule fires
       * while the window is still capturable, the capture block above has
       * already re-attached and left the request active. The engine's capture
       * state is now independent and is cleared by `stopAnalyzer`; this flag
       * only ensures the matching detach is still sent.
       *
       * The two game-side routes cannot reach here with a request active: both
       * of them require the window to be uncapturable, which detached it
       * above. So in practice this is the idle route, which is exactly the one
       * that can stop the analyzer with a perfectly good window on screen.
       */
      if (captureRequested) {
        captureRequested = false
        actions.push({ type: 'detachCapture' })
      }
    }
  } else if (running && !analyzerRunning) {
    // Warm standby: a running game keeps the analyzer up even while the window
    // cannot be captured, so coming back from a minimise costs nothing.
    actions.push({ type: 'startAnalyzer' })
    analyzerRunning = true
  }

  return {
    state: {
      captureRequested,
      analyzerRunning,
      minimizedNoticeSent,
      lastRunningAt,
      lastUnpausedAt,
      lastStatus: actions.some((a) => a.type === 'broadcastStatus') ? status : state.lastStatus
    },
    actions
  }
}
