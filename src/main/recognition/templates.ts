import type { Mat } from '@u4/opencv4nodejs'
import { BASE_HEIGHT, BASE_WIDTH, getGameRect, type GameRect } from './geometry.js'
import type { Template } from './templateMatching.js'

export interface TemplateGroups {
  classes: Template[]
  emblems: Template[]
  playOrder: Template[]
  result: Template[]
  resultMid: Template[]
  indicators: Template[]
  modesCPU: Template[]
  modesRanked: Template[]
  modes2Pick: Template[]
  modesPlaza: Template[]
  cursor: Template[]
  custom: Template[]
  history: Template[]
}

let scaled: TemplateGroups | null = null
let lastTemplateScaleKey = ''
let lastOriginalTemplates: TemplateGroups | null = null

export function prepareScaledTemplates(
  original: TemplateGroups,
  fullGray: Mat,
  gameRect: GameRect = getGameRect(fullGray)
): TemplateGroups {
  const scaleX = gameRect.w / BASE_WIDTH
  const scaleY = gameRect.h / BASE_HEIGHT
  const scale = Math.min(scaleX, scaleY)
  const scaleKey = `${gameRect.w}x${gameRect.h}:${scale.toFixed(4)}`
  if (scaled && scaleKey === lastTemplateScaleKey && original === lastOriginalTemplates) {
    return scaled
  }
  lastTemplateScaleKey = scaleKey
  lastOriginalTemplates = original

  scaled = {
    classes: scaleTemplates(original.classes, scale),
    emblems: scaleTemplates(original.emblems, scale),
    playOrder: scaleTemplates(original.playOrder, scale),
    result: scaleTemplates(original.result, scale),
    resultMid: scaleTemplates(original.resultMid, scale),
    indicators: scaleTemplates(original.indicators, scale),
    modesCPU: scaleTemplates(original.modesCPU, scale),
    modesRanked: scaleTemplates(original.modesRanked, scale),
    modes2Pick: scaleTemplates(original.modes2Pick, scale),
    modesPlaza: scaleTemplates(original.modesPlaza, scale),
    cursor: scaleTemplates(original.cursor, scale),
    custom: scaleTemplates(original.custom, scale),
    history: scaleTemplates(original.history, scale)
  }
  return scaled
}

function scaleTemplates(templates: Template[], scale: number): Template[] {
  return templates.map(({ name, image }) => ({
    name,
    image: image.resize(Math.round(image.rows * scale), Math.round(image.cols * scale))
  }))
}
