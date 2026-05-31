import { describe, expect, it, vi } from 'vitest'
import {
  clampRectToMat,
  getRegionSafe,
  getGameRect,
  getScaleFactors,
  scaleRect,
  type RectLike
} from '../../src/main/recognition/geometry'

const mat = (cols: number, rows: number): any => ({ cols, rows })

describe('recognition geometry', () => {
  it('uses the full frame when the capture is already 16:9', () => {
    expect(getGameRect(mat(1280, 720))).toEqual({ x: 0, y: 0, w: 1280, h: 720 })
    expect(getGameRect(mat(1920, 1080))).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('centers the game rect horizontally when the capture is too wide', () => {
    expect(getGameRect(mat(1600, 720))).toEqual({ x: 160, y: 0, w: 1280, h: 720 })
  })

  it('centers the game rect vertically when the capture is too tall', () => {
    expect(getGameRect(mat(1280, 900))).toEqual({ x: 0, y: 90, w: 1280, h: 720 })
  })

  it('maps base 1280x720 coordinates into the detected game rect', () => {
    const gameRect = getGameRect(mat(1600, 720))
    const scale = getScaleFactors(gameRect)
    const baseRect: RectLike = { x: 100, y: 50, w: 200, h: 100 }

    expect(scaleRect(baseRect, scale)).toEqual({ x: 260, y: 50, w: 200, h: 100 })
  })

  it('scales ROI dimensions proportionally for larger captures', () => {
    const scale = getScaleFactors(getGameRect(mat(1920, 1080)))

    expect(scaleRect({ x: 100, y: 50, w: 200, h: 100 }, scale)).toEqual({
      x: 150,
      y: 75,
      w: 300,
      h: 150
    })
  })

  it('clamps ROI coordinates and dimensions to the available frame', () => {
    const rect = clampRectToMat({ x: -10, y: 8, w: 80, h: 80 }, mat(50, 40))

    expect(rect).toMatchObject({ x: 0, y: 8, width: 50, height: 32 })
  })

  it('uses the clamped ROI when extracting a region', () => {
    const getRegion = vi.fn()
    const source = { cols: 40, rows: 30, getRegion } as any

    getRegionSafe(source, { x: 30, y: 20, w: 50, h: 50 })

    expect(getRegion).toHaveBeenCalledWith(
      expect.objectContaining({ x: 30, y: 20, width: 10, height: 10 })
    )
  })
})
