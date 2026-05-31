import { app } from 'electron'
import path from 'path'
import { existsSync, mkdirSync } from 'fs'

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getCaptureDir(): string {
  return ensureDir(path.join(app.getPath('userData'), 'capture'))
}

export function getRuntimeToolsDir(): string {
  return ensureDir(path.join(app.getPath('userData'), 'tools'))
}

export function getCaptureImagePath(): string {
  return path.join(getCaptureDir(), 'svwb.png')
}

export function getCaptureTmpImagePath(): string {
  return path.join(getCaptureDir(), 'svwb.png.tmp.png')
}

export function getTesseractCacheDir(): string {
  return ensureDir(path.join(app.getPath('userData'), 'cache', 'tesseract'))
}
