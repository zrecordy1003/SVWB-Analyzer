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

/**
 * Where the analyzer records recognition anomalies it notices about itself.
 *
 * Local only - nothing here is ever uploaded. The user exports it deliberately
 * from the settings page when they want to report a problem.
 */
export function getDiagnosticsDir(): string {
  return ensureDir(path.join(app.getPath('userData'), 'diagnostics'))
}
