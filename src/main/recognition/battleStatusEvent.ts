/**
 * The engine's `statusChanged` event, mapped to the HUD's `BattleStatus`.
 *
 * Its own module, and that is the point rather than tidiness: `engine.ts`
 * imports `electron-store`, which needs a real Electron `app` to construct, so
 * anything living in there can only be tested behind a mock of the whole
 * runtime. A six-line field mapping is not worth that, and a pure function
 * that is expensive to test is not much of a pure function.
 *
 * Why it is a named function at all: this event speaks the HUD's vocabulary
 * (`ownClass` / `enemyClass`) while `matchStarted` speaks the database's
 * (`myClass` / `oppoClass`), and reading one set off the other is what once
 * left the opponent blank in the middle of a battle. Nothing about that is
 * visible at a glance, which is exactly the kind of thing that wants a test
 * naming the incident.
 */
import type { ClassName, GameMode, PlayOrder } from '../../shared/domain.js'
import type { BattleStatus } from '../../shared/types.js'

/** No battle in progress. Also what an empty event maps to. */
export const IDLE_STATUS: BattleStatus = {
  inBattle: false,
  ownClass: null,
  enemyClass: null,
  playOrder: null,
  mode: null
}

/**
 * A missing field becomes `null`, never `undefined`.
 *
 * `null` is a real state the HUD acts on - a ranked match carries no mode
 * until its result screen, and the HUD falls back to the last recorded match
 * rather than showing "no mode". `undefined` would cross the IPC boundary as
 * an absent key instead, which is a different thing to the receiver.
 */
export function statusFromEvent(event: Record<string, unknown>): BattleStatus {
  return {
    inBattle: Boolean(event.inBattle),
    ownClass: (event.ownClass ?? null) as ClassName | null,
    enemyClass: (event.enemyClass ?? null) as ClassName | null,
    playOrder: (event.playOrder ?? null) as PlayOrder | null,
    // The engine re-emits this event when a mode resolves mid-battle, so the
    // HUD can retarget the moment 2Pick is recognised on the versus screen
    // instead of waiting for the match to close.
    mode: (event.mode ?? null) as GameMode | null
  }
}
