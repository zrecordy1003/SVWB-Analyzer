/**
 * The `statusChanged` field mapping.
 *
 * One case per thing that has actually gone wrong here, which is the same rule
 * `tools/engine/src/machine/scenarios.rs` follows. There is exactly one such
 * thing, and it is the reason this mapping is a named function at all: the
 * engine's `statusChanged` speaks the HUD's vocabulary (`ownClass` /
 * `enemyClass`) while `matchStarted` speaks the database's (`myClass` /
 * `oppoClass`), and reading one set off the other once left the opponent blank
 * in the middle of a battle.
 *
 * The rest of the engine's event handling is deliberately not tested here, and
 * that is a judgement rather than an omission: every other case in `handle` is
 * a `broadcast(...)` or a `setStatus(IDLE_STATUS)` because the engine has
 * already done the work - it wrote the row, or deleted it - so a test would be
 * asserting that a one-line dispatcher dispatches. `startEngine` is spawn and
 * stream wiring, whose remaining logic is guards around I/O.
 */
import { describe, expect, it } from 'vitest'

import { IDLE_STATUS, statusFromEvent } from '../../src/main/recognition/battleStatusEvent'

describe('statusFromEvent', () => {
  it('reads the HUD field names, not the database ones', () => {
    // The incident. A payload carrying BOTH spellings, so a mapping that
    // reached for the wrong pair would come back with nulls and be caught here
    // rather than on someone's screen.
    const status = statusFromEvent({
      inBattle: true,
      ownClass: 'witch',
      enemyClass: 'dragon',
      playOrder: 'first',
      mode: 'ranked',
      myClass: 'elf',
      oppoClass: 'bishop'
    })
    expect(status).toEqual({
      inBattle: true,
      ownClass: 'witch',
      enemyClass: 'dragon',
      playOrder: 'first',
      mode: 'ranked'
    })
  })

  it('turns every missing field into null, not undefined', () => {
    // `null` is a real state and the HUD acts on it - a ranked match carries no
    // mode until its result screen, and the HUD falls back to the last
    // recorded match rather than showing "no mode". `undefined` would survive
    // the IPC boundary as a missing key instead.
    const status = statusFromEvent({ inBattle: true })
    expect(status).toEqual({
      inBattle: true,
      ownClass: null,
      enemyClass: null,
      playOrder: null,
      mode: null
    })
    for (const value of Object.values(status)) {
      expect(value).not.toBeUndefined()
    }
  })

  it('treats an absent inBattle as not in battle', () => {
    expect(statusFromEvent({}).inBattle).toBe(false)
    // And anything truthy as in battle: the engine sends a boolean, but the
    // wire is JSON and this is the field the HUD's whole layout hangs off.
    expect(statusFromEvent({ inBattle: 1 }).inBattle).toBe(true)
  })

  it('an empty event is the idle status', () => {
    // Which is what makes `setStatus(IDLE_STATUS)` and a status built from
    // nothing agree - two paths that both mean "no battle".
    expect(statusFromEvent({})).toEqual(IDLE_STATUS)
  })

  it('keeps a mode that resolves mid-battle', () => {
    // The engine re-emits `statusChanged` when 2Pick is recognised on the
    // versus screen, so the HUD can retarget before the match closes. A
    // mapping that dropped `mode` would make that silently do nothing.
    const before = statusFromEvent({ inBattle: true, ownClass: 'witch' })
    const after = statusFromEvent({ inBattle: true, ownClass: 'witch', mode: 'twoPick' })
    expect(before.mode).toBeNull()
    expect(after.mode).toBe('twoPick')
  })
})
