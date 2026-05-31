import cv, { Mat } from '@u4/opencv4nodejs'

export const BASE_WIDTH = 1280
export const BASE_HEIGHT = 720
export const BASE_ASPECT_RATIO = BASE_WIDTH / BASE_HEIGHT

export type RectLike = { x: number; y: number; w: number; h: number }
export type GameRect = RectLike
export type ScaleFactors = { scaleX: number; scaleY: number; offsetX: number; offsetY: number }

export const getGameRect = (mat: Mat): GameRect => {
  const cols = mat.cols
  const rows = mat.rows
  const ratio = cols / rows

  if (Math.abs(ratio - BASE_ASPECT_RATIO) < 0.02) {
    return { x: 0, y: 0, w: cols, h: rows }
  }

  if (ratio > BASE_ASPECT_RATIO) {
    const w = Math.round(rows * BASE_ASPECT_RATIO)
    return { x: Math.max(0, Math.floor((cols - w) / 2)), y: 0, w, h: rows }
  }

  const h = Math.round(cols / BASE_ASPECT_RATIO)
  return { x: 0, y: Math.max(0, Math.floor((rows - h) / 2)), w: cols, h }
}

export const getScaleFactors = (gameRect: GameRect): ScaleFactors => ({
  scaleX: gameRect.w / BASE_WIDTH,
  scaleY: gameRect.h / BASE_HEIGHT,
  offsetX: gameRect.x,
  offsetY: gameRect.y
})

export const scaleRect = (rect: RectLike, scale: ScaleFactors): RectLike => ({
  x: scale.offsetX + Math.round(rect.x * scale.scaleX),
  y: scale.offsetY + Math.round(rect.y * scale.scaleY),
  w: Math.max(1, Math.round(rect.w * scale.scaleX)),
  h: Math.max(1, Math.round(rect.h * scale.scaleY))
})

export function clampRectToMat(rect: RectLike, mat: Mat): cv.Rect {
  const x = Math.max(0, Math.min(rect.x, mat.cols - 1))
  const y = Math.max(0, Math.min(rect.y, mat.rows - 1))
  const maxW = Math.max(1, mat.cols - x)
  const maxH = Math.max(1, mat.rows - y)
  return new cv.Rect(x, y, Math.max(1, Math.min(rect.w, maxW)), Math.max(1, Math.min(rect.h, maxH)))
}

export function getRegionSafe(mat: Mat, rect: RectLike): Mat {
  return mat.getRegion(clampRectToMat(rect, mat))
}
