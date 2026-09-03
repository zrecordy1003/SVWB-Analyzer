/**
 * The game poll's decisions.
 *
 * This is the host's answer to `tools/engine/src/machine/scenarios.rs`: one
 * case per behaviour the poll is supposed to have, against a pure function, so
 * a thirty-minute timeout is a number rather than a wait. None of this was
 * testable while the logic lived in a closure in `index.ts` interleaved with
 * its own side effects, and the E2E suite cannot reach most of it - almost
 * every branch needs a real game window and a real `hwnd`.
 *
 * The assertions are on the ACTION ARRAY, in order, not on a set. Order is
 * part of the contract: the analyzer has to be up before a capture attach,
 * because the engine owns capture and cannot be attached to before it exists.
 */
import { describe, expect, it } from 'vitest'

import {
  IDLE_THRESHOLD_SECONDS,
  MINIMIZED_ORIGIN,
  decidePoll,
  initialPollState,
  type PollAction,
  type PollObservation,
  type PollState
} from '../../src/main/gamePoll'

const T0 = Date.parse('2026-09-03T12:00:00Z')
const THRESHOLD_MS = IDLE_THRESHOLD_SECONDS * 1000

/** A capturable game window, unless overridden. */
function seen(over: Partial<PollObservation> = {}): PollObservation {
  return {
    now: T0,
    running: true,
    bounds: { x: 100, y: 100 },
    hwnd: 4242,
    systemIdle: false,
    ...over
  }
}

const gone = (over: Partial<PollObservation> = {}): PollObservation =>
  seen({ running: false, bounds: null, hwnd: null, ...over })

const minimized = (over: Partial<PollObservation> = {}): PollObservation =>
  seen({ bounds: { x: MINIMIZED_ORIGIN, y: MINIMIZED_ORIGIN }, ...over })

const kinds = (actions: PollAction[]): string[] => actions.map((a) => a.type)

/** Run a sequence of observations, returning every step's decision. */
function run(observations: PollObservation[], from: PollState = initialPollState) {
  let state = from
  const steps: { actions: PollAction[]; state: PollState }[] = []
  for (const observation of observations) {
    const decision = decidePoll(state, observation)
    state = decision.state
    steps.push({ actions: decision.actions, state })
  }
  return { state, steps }
}

describe('starting up', () => {
  it('brings the analyzer up before attaching capture', () => {
    const { actions, state } = decidePoll(initialPollState, seen())
    // The ordering this whole module exists to state.
    expect(kinds(actions)).toEqual([
      'broadcastStatus',
      'startAnalyzer',
      'attachCapture',
      'captureStatus'
    ])
    expect(actions).toContainEqual({ type: 'attachCapture', hwnd: 4242 })
    expect(actions).toContainEqual({ type: 'captureStatus', capturing: true })
    expect(state).toMatchObject({ analyzerRunning: true, capturing: true })
  })

  it('says nothing at all when there is no game and nothing has changed', () => {
    // First tick has to broadcast, because there is no previous status to
    // compare against - "not running" is news to a window that just opened.
    const { steps } = run([gone(), gone({ now: T0 + 1000 }), gone({ now: T0 + 2000 })])
    expect(kinds(steps[0].actions)).toEqual(['broadcastStatus'])
    expect(steps[1].actions).toEqual([])
    expect(steps[2].actions).toEqual([])
  })

  it('re-attaches on every capturable tick, so an engine restart recovers', () => {
    // The attach is idempotent and there is no other signal that the engine
    // came back, so this repetition is the recovery mechanism. Losing it would
    // leave capture dead until the game was minimised and restored.
    const { steps } = run([seen(), seen({ now: T0 + 1000 }), seen({ now: T0 + 2000 })])
    for (const step of steps.slice(1)) {
      expect(kinds(step.actions)).toEqual(['attachCapture'])
    }
  })
})

describe('the window going away', () => {
  it('detaches and tells the renderer when the game minimises', () => {
    const { steps } = run([seen(), minimized({ now: T0 + 1000 })])
    expect(kinds(steps[1].actions)).toEqual([
      'broadcastStatus',
      'detachCapture',
      'captureStatus',
      'notifyMinimized'
    ])
    expect(steps[1].actions).toContainEqual({ type: 'captureStatus', capturing: false })
    // The analyzer stays up: warm standby, so coming back costs nothing.
    expect(steps[1].state).toMatchObject({ analyzerRunning: true, capturing: false })
  })

  it('treats a window with no readable bounds as uncapturable', () => {
    // Distinct observation, same conclusion - and the notification still fires,
    // because from the user's side "we cannot see the window" is the same
    // event whether the cause is a minimise or a detector that came back empty.
    const { steps } = run([seen(), seen({ now: T0 + 1000, bounds: null })])
    expect(kinds(steps[1].actions)).toContain('detachCapture')
    expect(kinds(steps[1].actions)).toContain('notifyMinimized')
  })

  it('does not capture a running game whose hwnd is unknown', () => {
    const { actions, state } = decidePoll(initialPollState, seen({ hwnd: null }))
    expect(kinds(actions)).toEqual(['broadcastStatus', 'startAnalyzer'])
    expect(state).toMatchObject({ capturing: false, analyzerRunning: true })
  })

  it('notifies once per minimise, not once per tick', () => {
    const { steps } = run([
      seen(),
      minimized({ now: T0 + 1000 }),
      minimized({ now: T0 + 2000 }),
      minimized({ now: T0 + 3000 })
    ])
    expect(kinds(steps[1].actions)).toContain('notifyMinimized')
    expect(kinds(steps[2].actions)).not.toContain('notifyMinimized')
    expect(kinds(steps[3].actions)).not.toContain('notifyMinimized')
  })

  it('notifies again after the window comes back and goes away once more', () => {
    const { steps } = run([
      seen(),
      minimized({ now: T0 + 1000 }),
      seen({ now: T0 + 2000 }),
      minimized({ now: T0 + 3000 })
    ])
    expect(kinds(steps[1].actions)).toContain('notifyMinimized')
    expect(kinds(steps[3].actions)).toContain('notifyMinimized')
  })
})

describe('the broadcast is gated on change', () => {
  it('sends once per transition and not once per second', () => {
    const { steps } = run([
      seen(),
      seen({ now: T0 + 1000 }),
      minimized({ now: T0 + 2000 }),
      minimized({ now: T0 + 3000 }),
      gone({ now: T0 + 4000 })
    ])
    expect(kinds(steps[0].actions)).toContain('broadcastStatus')
    expect(kinds(steps[1].actions)).not.toContain('broadcastStatus')
    expect(kinds(steps[2].actions)).toContain('broadcastStatus')
    expect(kinds(steps[3].actions)).not.toContain('broadcastStatus')
    expect(kinds(steps[4].actions)).toContain('broadcastStatus')
  })

  it('distinguishes paused from not running', () => {
    // The distinction the HUD needs: "the game is minimised" and "the game is
    // not open" are different sentences, and folding them together is the
    // failure this status exists to prevent.
    const paused = decidePoll(initialPollState, minimized()).actions.find(
      (a) => a.type === 'broadcastStatus'
    )
    const closed = decidePoll(initialPollState, gone()).actions.find(
      (a) => a.type === 'broadcastStatus'
    )
    expect(paused).toEqual({
      type: 'broadcastStatus',
      status: { running: true, paused: true, capturing: false }
    })
    expect(closed).toEqual({
      type: 'broadcastStatus',
      status: { running: false, paused: false, capturing: false }
    })
  })
})

describe('the analyzer outlives the game by half an hour', () => {
  it('keeps running while the game is closed but not for long', () => {
    const { state, steps } = run([seen(), gone({ now: T0 + THRESHOLD_MS - 1 })])
    expect(kinds(steps[1].actions)).not.toContain('stopAnalyzer')
    expect(state.analyzerRunning).toBe(true)
  })

  it('stops once the game has been closed for the full threshold', () => {
    const { state, steps } = run([seen(), gone({ now: T0 + THRESHOLD_MS })])
    expect(kinds(steps[1].actions)).toContain('stopAnalyzer')
    expect(state.analyzerRunning).toBe(false)
  })

  it('stops once the window has been uncapturable for the full threshold', () => {
    // The third route, and the easiest to miss: the game is still running, so
    // neither the idle check nor the closed check fires.
    const { state, steps } = run([seen(), minimized({ now: T0 + THRESHOLD_MS })])
    expect(kinds(steps[1].actions)).toContain('stopAnalyzer')
    expect(state.analyzerRunning).toBe(false)
  })

  it('stops immediately when the system is idle, game or no game', () => {
    const { state } = run([seen(), seen({ now: T0 + 1000, systemIdle: true })])
    expect(state.analyzerRunning).toBe(false)
  })

  it('does not stop an analyzer it never started', () => {
    // A fresh launch with no game and an idle machine: both timestamps are
    // null, so neither timeout can fire, and there is nothing to stop.
    const { steps, state } = run([gone({ systemIdle: true })])
    expect(kinds(steps[0].actions)).toEqual(['broadcastStatus'])
    expect(state.analyzerRunning).toBe(false)
  })

  it('a running game resets the clock every tick', () => {
    // Thirty minutes of play must not trip the closed-too-long timeout.
    const observations = Array.from({ length: 5 }, (_, i) =>
      seen({ now: T0 + i * (THRESHOLD_MS / 4) })
    )
    const { state, steps } = run(observations)
    expect(steps.flatMap((s) => kinds(s.actions))).not.toContain('stopAnalyzer')
    expect(state.analyzerRunning).toBe(true)
  })

  it('brings the analyzer back when the game returns after a shutdown', () => {
    const { state, steps } = run([
      seen(),
      gone({ now: T0 + THRESHOLD_MS }),
      seen({ now: T0 + THRESHOLD_MS + 1000 })
    ])
    expect(kinds(steps[1].actions)).toContain('stopAnalyzer')
    expect(kinds(steps[2].actions)).toContain('startAnalyzer')
    expect(state).toMatchObject({ analyzerRunning: true, capturing: true })
  })

  /**
   * Recorded, not endorsed.
   *
   * The idle rule stops the analyzer and leaves `capturing` true, because the
   * capture block runs first and the window is still capturable. So the engine
   * process is gone while the renderer's capture indicator - and the HUD's
   * `game:status.capturing` - still say capture is live. Nothing re-sends
   * `captureStatus` either, because the flag never changed.
   *
   * This is the behaviour the closure had; this extraction is deliberately
   * behaviour-preserving, so the case states what happens rather than what
   * should. The fix is its own change.
   */
  it('idling with the game up stops the analyzer but leaves capture believing it is on', () => {
    const { state, steps } = run([seen(), seen({ now: T0 + 1000, systemIdle: true })])
    expect(kinds(steps[1].actions)).toEqual(['attachCapture', 'stopAnalyzer'])
    expect(state).toMatchObject({ analyzerRunning: false, capturing: true })
  })

  it('restarts the analyzer on the tick after idle ends', () => {
    const { state, steps } = run([
      seen(),
      seen({ now: T0 + 1000, systemIdle: true }),
      seen({ now: T0 + 2000, systemIdle: false })
    ])
    expect(kinds(steps[2].actions)).toContain('startAnalyzer')
    expect(state.analyzerRunning).toBe(true)
  })
})
