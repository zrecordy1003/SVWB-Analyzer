import { describe, expect, it, vi } from 'vitest'
import { matchTemplate } from '../../src/main/recognition/templateMatching'

type MockMat = {
  rows: number
  cols: number
  score: number
  loc?: { x: number; y: number }
  resize: ReturnType<typeof vi.fn>
}

function templateImage(rows: number, cols: number, score: number): MockMat {
  const mat: MockMat = {
    rows,
    cols,
    score,
    loc: { x: 7, y: 9 },
    resize: vi.fn((nextRows: number, nextCols: number) => ({
      ...mat,
      rows: nextRows,
      cols: nextCols,
      score: 0.86,
      loc: { x: 3, y: 4 },
      resize: mat.resize
    }))
  }
  return mat
}

function baseMat(rows: number, cols: number) {
  return {
    rows,
    cols,
    matchTemplate: vi.fn((tpl: MockMat) => ({
      minMaxLoc: () => ({ maxVal: tpl.score, maxLoc: tpl.loc ?? { x: 0, y: 0 } })
    }))
  } as any
}

describe('matchTemplate', () => {
  it('returns the highest scoring template with match metadata', () => {
    const base = baseMat(100, 100)

    expect(
      matchTemplate(
        base,
        [
          { name: 'low', image: templateImage(10, 10, 0.4) as any },
          { name: 'high', image: templateImage(20, 15, 0.92) as any }
        ],
        { multiScale: false }
      )
    ).toEqual({
      name: 'high',
      score: 0.92,
      scale: 1,
      x: 7,
      y: 9,
      w: 15,
      h: 20
    })
  })

  it('skips templates that are larger than the target ROI', () => {
    const base = baseMat(10, 10)

    const match = matchTemplate(
      base,
      [{ name: 'oversized', image: templateImage(20, 20, 0.99) as any }],
      { multiScale: false }
    )

    expect(match).toEqual({ name: '', score: -1, scale: 1 })
    expect(base.matchTemplate).not.toHaveBeenCalled()
  })

  it('uses multi-scale fallback when the direct score is weak', () => {
    const image = templateImage(20, 20, 0.3)
    const base = baseMat(100, 100)

    const match = matchTemplate(base, [{ name: 'cursor', image: image as any }], {
      multiScale: true
    })

    expect(match).toMatchObject({
      name: 'cursor',
      score: 0.86,
      scale: 0.94,
      x: 3,
      y: 4
    })
    expect(image.resize).toHaveBeenCalled()
  })
})
