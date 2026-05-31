import fs from 'fs'
import path from 'path'
import cv, { Mat } from '@u4/opencv4nodejs'

export type Template = {
  name: string
  image: Mat
}

export type ScoreAndName = {
  score: number
  name: string
  scale?: number
  x?: number
  y?: number
  w?: number
  h?: number
}

const MULTI_SCALE_FACTORS = [0.94, 0.97, 1.03, 1.06]
const MULTI_SCALE_TRIGGER_SCORE = 0.78

let debugSamplesDir = ''
let debugSamplesEnabled = false

export function configureTemplateMatchingDebug(options: {
  samplesDir: string
  enabled: boolean
}): void {
  debugSamplesDir = options.samplesDir
  debugSamplesEnabled = options.enabled
}

export function loadTemplates(dir: string): Template[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((file) => ({
      name: path.basename(file, '.png'),
      image: cv.imread(path.join(dir, file)).bgrToGray()
    }))
}

export function matchTemplate(
  base: Mat,
  templates: Template[],
  options: { multiScale?: boolean; label?: string; lowConfidenceThreshold?: number } = {}
): ScoreAndName {
  let best: ScoreAndName = { name: '', score: -1, scale: 1 }
  for (const { name, image: tpl } of templates) {
    if (base.cols < tpl.cols || base.rows < tpl.rows) continue
    best = matchOne(base, tpl, name, 1, best)
  }

  if (options.multiScale && best.score < MULTI_SCALE_TRIGGER_SCORE) {
    for (const factor of MULTI_SCALE_FACTORS) {
      for (const { name, image } of templates) {
        const nextRows = Math.max(1, Math.round(image.rows * factor))
        const nextCols = Math.max(1, Math.round(image.cols * factor))
        if (base.cols < nextCols || base.rows < nextRows) continue
        const tpl = image.resize(nextRows, nextCols)
        best = matchOne(base, tpl, name, factor, best)
      }
    }
  }

  if (
    options.label &&
    options.lowConfidenceThreshold &&
    best.score < options.lowConfidenceThreshold
  ) {
    saveDebugSample(options.label, base, best).catch((err) =>
      console.warn('[Analyzer] failed to save debug sample:', err)
    )
  }
  return best
}

function matchOne(
  base: Mat,
  tpl: Mat,
  name: string,
  scale: number,
  best: ScoreAndName
): ScoreAndName {
  const result = base.matchTemplate(tpl, cv.TM_CCOEFF_NORMED)
  const { maxVal, maxLoc } = result.minMaxLoc()
  if (maxVal <= best.score) return best
  return {
    name,
    score: maxVal,
    scale,
    x: maxLoc.x,
    y: maxLoc.y,
    w: tpl.cols,
    h: tpl.rows
  }
}

async function saveDebugSample(label: string, base: Mat, best: ScoreAndName): Promise<void> {
  if (!debugSamplesEnabled || !debugSamplesDir) return
  await fs.promises.mkdir(debugSamplesDir, { recursive: true })
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '_')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const score = Math.round(best.score * 1000)
  const file = path.join(
    debugSamplesDir,
    `${stamp}_${safeLabel}_${best.name || 'none'}_${score}.png`
  )
  cv.imwrite(file, base)
}
