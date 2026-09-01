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
 * Where card images downloaded from the portal are kept.
 *
 * A cache, and only ever a cache: nothing here ships with the app, and deleting
 * the whole directory costs a re-download and nothing else. Split by language
 * because the portal serves a different image per language from the same card.
 *
 * Note this deliberately sits under `cache/` next to the tesseract data rather
 * than beside the database - see docs/deck-import-plan.md on why these files
 * are the user's own copies and never ours to redistribute.
 */
export function getCardImageCacheRoot(): string {
  return ensureDir(path.join(app.getPath('userData'), 'cache', 'cards'))
}

/**
 * Where the class emblems downloaded from the portal are kept.
 *
 * Separate from the card cache rather than a subdirectory of it, and the reason
 * is eviction: the card cache bounds itself by deleting its least-recently-used
 * files, and eight emblems totalling under 20KB have no business competing for
 * that budget or being thrown out to make room for a card. Not split by
 * language - unlike card art, an emblem is the same picture in all five.
 */
export function getClassIconCacheRoot(): string {
  return ensureDir(path.join(app.getPath('userData'), 'cache', 'class-icons'))
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
