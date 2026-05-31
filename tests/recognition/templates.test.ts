import { describe, expect, it, vi } from 'vitest'
import { prepareScaledTemplates, type TemplateGroups } from '../../src/main/recognition/templates'

function image(rows: number, cols: number) {
  return {
    rows,
    cols,
    resize: vi.fn((nextRows: number, nextCols: number) => image(nextRows, nextCols))
  } as any
}

function groups(): TemplateGroups {
  const entry = { name: 'sample', image: image(10, 20) }
  return {
    classes: [entry],
    emblems: [entry],
    playOrder: [entry],
    result: [entry],
    resultMid: [entry],
    indicators: [entry],
    modesCPU: [entry],
    modesRanked: [entry],
    modes2Pick: [entry],
    modesPlaza: [entry],
    cursor: [entry],
    custom: [entry],
    history: [entry]
  }
}

describe('prepareScaledTemplates', () => {
  it('scales templates according to the detected game rect scale', () => {
    const original = groups()
    const scaled = prepareScaledTemplates(original, { cols: 1920, rows: 1080 } as any, {
      x: 0,
      y: 0,
      w: 1920,
      h: 1080
    })

    expect(scaled.classes[0].image.rows).toBe(15)
    expect(scaled.classes[0].image.cols).toBe(30)
  })

  it('reuses scaled templates for the same scale key', () => {
    const original = groups()
    const first = prepareScaledTemplates(original, { cols: 1280, rows: 720 } as any, {
      x: 0,
      y: 0,
      w: 1280,
      h: 720
    })
    const second = prepareScaledTemplates(original, { cols: 1280, rows: 720 } as any, {
      x: 0,
      y: 0,
      w: 1280,
      h: 720
    })

    expect(second).toBe(first)
  })

  it('does not reuse cached templates for a different source group at the same scale', () => {
    const first = prepareScaledTemplates(groups(), { cols: 1280, rows: 720 } as any, {
      x: 0,
      y: 0,
      w: 1280,
      h: 720
    })
    const second = prepareScaledTemplates(groups(), { cols: 1280, rows: 720 } as any, {
      x: 0,
      y: 0,
      w: 1280,
      h: 720
    })

    expect(second).not.toBe(first)
  })
})
