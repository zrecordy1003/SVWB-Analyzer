import { describe, expect, it } from 'vitest'
import { anchoredRect, anchorAwareRect, type AnchorResult } from '../../src/main/recognition/anchor'
import { getScaleFactors } from '../../src/main/recognition/geometry'

const scale = getScaleFactors({ x: 160, y: 0, w: 1280, h: 720 })
const baseRect = { x: 1115, y: 200, w: 65, h: 30 }
const expectedAnchorBase = { x: 760, y: 185, w: 150, h: 60 }

describe('anchorAwareRect', () => {
  it('falls back to scaled fixed ROI when anchor is not found', () => {
    const anchor: AnchorResult = { found: false, name: '', score: 0 }

    expect(anchorAwareRect({ baseRect, anchor, expectedAnchorBase, scale })).toEqual({
      x: 1275,
      y: 200,
      w: 65,
      h: 30
    })
  })

  it('moves the ROI by the detected anchor offset', () => {
    const anchor: AnchorResult = {
      found: true,
      name: 'ranked',
      score: 0.91,
      x: 930,
      y: 192,
      scale: 1
    }

    expect(anchorAwareRect({ baseRect, anchor, expectedAnchorBase, scale })).toEqual({
      x: 1285,
      y: 207,
      w: 65,
      h: 30
    })
  })

  it('derives a rect from the detected anchor and template scale', () => {
    const anchor: AnchorResult = {
      found: true,
      name: 'result',
      score: 0.96,
      x: 500,
      y: 120,
      scale: 1.5
    }

    expect(anchoredRect(anchor, { x: 10, y: 8, w: 20, h: 12 })).toEqual({
      x: 515,
      y: 132,
      w: 30,
      h: 18
    })
  })
})
