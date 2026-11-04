/**
 * The header pill and the sidebar badge both read `captureStateOf`, so its
 * precedence is the one place "why is nothing being recorded" gets decided.
 * The case that matters most is the closed game: it is the normal state, and
 * it used to read as a red error in the header.
 */
import { describe, expect, it } from 'vitest'

import { captureStateOf } from '../../src/renderer/src/components/captureState'

const FHD = { x: 0, y: 0, width: 1920, height: 1080 }

describe('captureStateOf', () => {
  it('is loading until the first status arrives', () => {
    expect(captureStateOf(undefined).kind).toBe('loading')
  })

  it('treats a closed game as idle, not as an error', () => {
    const state = captureStateOf({ running: false })
    expect(state.kind).toBe('noGame')
    expect(state.tone).toBe('idle')
  })

  it('explains a minimised window before the missing frames it causes', () => {
    const state = captureStateOf({
      running: true,
      bounds: { x: -32000, y: -32000, width: 160, height: 28 },
      engineReady: true,
      capturing: false
    })
    expect(state.kind).toBe('minimized')
  })

  it('puts a dead engine ahead of waiting for frames', () => {
    const state = captureStateOf({
      running: true,
      bounds: FHD,
      engineReady: false,
      capturing: false
    })
    expect(state.kind).toBe('engineDown')
    expect(state.tone).toBe('error')
  })

  it('waits for frames once the engine is up', () => {
    expect(
      captureStateOf({ running: true, bounds: FHD, engineReady: true, capturing: false }).kind
    ).toBe('waitingFrames')
  })

  it('flags an unusable resolution only once frames arrive', () => {
    const small = { x: 0, y: 0, width: 1024, height: 576 }
    expect(
      captureStateOf({ running: true, bounds: small, engineReady: true, capturing: true }).kind
    ).toBe('badResolution')
  })

  it('is watching when everything is in place', () => {
    const state = captureStateOf({ running: true, bounds: FHD, engineReady: true, capturing: true })
    expect(state.kind).toBe('watching')
    expect(state.tone).toBe('ok')
  })
})
