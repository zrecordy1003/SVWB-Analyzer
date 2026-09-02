/**
 * Which display setups the status badge calls supported.
 *
 * This has been wrong twice, and both times it was wrong in the direction that
 * costs a user: it named two exact resolutions and told everyone else to change
 * their settings. A 2560x1440 player was warned off a setup the engine handled
 * perfectly, and a 1920x1200 one would have been too.
 *
 * The badge answers one question - is the 16:9 region the engine extracts at
 * least 1280x720 - so these cases are the shapes real monitors come in, not a
 * list of blessed numbers. The letterbox limit tracks `MAX_CHROME_ROWS` in
 * `tools/vision-native`; see that constant for why 320.
 */
import { describe, expect, it } from 'vitest'

import { computeResolutionStatus } from '../../src/renderer/src/components/resolutionStatus'

describe('computeResolutionStatus', () => {
  it('accepts every 16:9 size at or above the canvas', () => {
    for (const [width, height] of [
      [1280, 720],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160]
    ]) {
      const status = computeResolutionStatus({ width, height })
      expect(status.ok, `${width}x${height}`).toBe(true)
      expect(status.hint).toBeUndefined()
      // Nothing is cropped, so the label does not need to explain itself.
      expect(status.label).toBe(`${width}×${height}`)
    }
  })

  /**
   * Windowed capture reports the whole window. The extra height is the title
   * bar, which the engine measures away - 30px at 100% display scaling, 64px at
   * 200%.
   */
  it('accepts a window whose bounds include its title bar', () => {
    for (const height of [1080 + 30, 1080 + 45, 1080 + 64]) {
      const status = computeResolutionStatus({ width: 1920, height })
      expect(status.ok, `1920x${height}`).toBe(true)
      expect(status.label).toBe(`1920×${height}（遊戲畫面 1920×1080）`)
    }
  })

  /**
   * A display taller than 16:9 gets black bars from the client, which the same
   * scan removes. 1920x1200 is the case a user actually reported.
   */
  it('accepts a display taller than 16:9', () => {
    expect(computeResolutionStatus({ width: 1920, height: 1200 })).toMatchObject({
      ok: true,
      label: '1920×1200（遊戲畫面 1920×1080）'
    })
    expect(computeResolutionStatus({ width: 1280, height: 800 }).ok).toBe(true)
    // 4:3, where the bars are tallest relative to the picture.
    expect(computeResolutionStatus({ width: 1600, height: 1200 }).ok).toBe(true)
  })

  /** Ultrawide pillarboxes instead: the height is the limit, not the width. */
  it('accepts a display wider than 16:9', () => {
    expect(computeResolutionStatus({ width: 3440, height: 1440 })).toMatchObject({
      ok: true,
      label: '3440×1440（遊戲畫面 2560×1440）'
    })
  })

  it('warns when the game picture itself is under 1280x720', () => {
    // 1024x768 is 4:3, so the picture is only 1024 wide however it is measured.
    const small = computeResolutionStatus({ width: 1024, height: 768 })
    expect(small.ok).toBe(false)
    expect(small.hint).toContain('1280×720')

    // Wider than 16:9 but too short: the pillarboxed picture is 1137x640.
    expect(computeResolutionStatus({ width: 1600, height: 640 }).ok).toBe(false)
  })

  /**
   * Past the point where the band above the picture can be measured, it stays
   * in frame and every calibrated window shifts down by its height - so this
   * warns rather than quietly failing.
   */
  it('warns when the bands are taller than the scan can reach', () => {
    const status = computeResolutionStatus({ width: 2560, height: 2560 })
    expect(status.ok).toBe(false)
    expect(status.hint).toContain('空白過高')
  })

  it('says so when there are no bounds to judge', () => {
    expect(computeResolutionStatus(undefined)).toMatchObject({ ok: false, label: '未知' })
    expect(computeResolutionStatus({ width: 0, height: 0 }).ok).toBe(false)
  })
})
