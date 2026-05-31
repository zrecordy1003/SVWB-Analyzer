import { Mat } from '@u4/opencv4nodejs'
import type { RectLike } from './geometry.js'
import { getRegionSafe, scaleRect, type ScaleFactors } from './geometry.js'
import { matchTemplate, type ScoreAndName, type Template } from './templateMatching.js'

export type AnchorResult = ScoreAndName & {
  found: boolean
}

export function detectAnchor(
  base: Mat,
  templates: Template[],
  options: {
    searchArea?: RectLike
    threshold: number
    label?: string
    multiScale?: boolean
  }
): AnchorResult {
  const searchArea = options.searchArea
  const roi = searchArea ? getRegionSafe(base, searchArea) : base
  const match = matchTemplate(roi, templates, {
    multiScale: options.multiScale ?? true,
    label: options.label,
    lowConfidenceThreshold: options.threshold
  })
  return {
    ...match,
    x: (match.x ?? 0) + (searchArea?.x ?? 0),
    y: (match.y ?? 0) + (searchArea?.y ?? 0),
    found: match.score >= options.threshold
  }
}

export function anchoredRect(anchor: AnchorResult, offset: RectLike): RectLike {
  const scale = anchor.scale ?? 1
  return {
    x: Math.round((anchor.x ?? 0) + offset.x * scale),
    y: Math.round((anchor.y ?? 0) + offset.y * scale),
    w: Math.max(1, Math.round(offset.w * scale)),
    h: Math.max(1, Math.round(offset.h * scale))
  }
}

export function anchorAwareRect(params: {
  baseRect: RectLike
  anchor: AnchorResult
  expectedAnchorBase: RectLike
  scale: ScaleFactors
}): RectLike {
  const fixedAnchor = scaleRect(params.expectedAnchorBase, params.scale)
  const fixedRect = scaleRect(params.baseRect, params.scale)
  if (!params.anchor.found || params.anchor.x == null || params.anchor.y == null) return fixedRect

  return {
    ...fixedRect,
    x: Math.round(fixedRect.x + params.anchor.x - fixedAnchor.x),
    y: Math.round(fixedRect.y + params.anchor.y - fixedAnchor.y)
  }
}
