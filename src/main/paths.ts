import { app } from 'electron'
import path from 'path'
import { existsSync, mkdirSync } from 'fs'

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// No `getCaptureDir` / `getCaptureImagePath` / `getCaptureTmpImagePath` here
// any more. They addressed `userData/capture/svwb.png`, the intermediate the
// old JS pipeline wrote each frame to; the engine has held frames in memory
// since the refactor and nothing has written that file in a long time. The
// only remaining effect was that `ensureDir` created an empty `capture/`
// directory in every user's profile on every launch, on the way to deleting
// two files that were not there.
export function getRuntimeToolsDir(): string {
  return ensureDir(path.join(app.getPath('userData'), 'tools'))
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
