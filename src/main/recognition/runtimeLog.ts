/**
 * A plain-text record of the things that go wrong before recognition begins.
 *
 * The engine already explains its own failures: it exits with a code and writes
 * a reason to stderr. `engine.ts` sent both to `console`, which in a packaged
 * build has no terminal attached and no file behind it - so the one explanation
 * that existed was discarded exactly when it was needed. A user whose engine
 * never started saw a normal-looking window, a green game-detected badge (that
 * badge reports the window scan, which does not involve the engine at all), an
 * empty diagnostics export, and nothing else. This file is that missing output.
 *
 * Deliberately separate from `diagnosticsRecorder`, on two counts:
 *
 *  - It is NOT gated on the diagnostics setting. That toggle guards saving
 *    pictures of the user's screen; a spawn failure is a few words of text, and
 *    turning pictures off must not also turn off the only record of why nothing
 *    works.
 *  - It records whether the app is running at all, not what the analyzer is
 *    unsure about. An empty `events.jsonl` means recognition ran and was
 *    confident; an empty `engine.log` means it never got as far as trying.
 *
 * Local only, like everything else here. It travels in the zip the user exports
 * by hand from the settings page.
 *
 * Free of Electron imports so it can be exercised outside the app, and so the
 * directory is handed in rather than read from `app.getPath` - the same reason
 * `diagnosticsRecorder` takes one.
 */
import fs from 'fs'
import path from 'path'

export const RUNTIME_LOG_FILE = 'engine.log'
export const RUNTIME_LOG_PREVIOUS_FILE = 'engine.previous.log'

/**
 * Rotated rather than truncated, matching `events.jsonl`, so a chatty session
 * cannot erase the startup record that explains it. Small on purpose: this file
 * holds lines of text, and anything approaching this size is a symptom in
 * itself.
 */
const MAX_BYTES = 256 * 1024

/** Lines held until the directory is known, so the earliest ones survive. */
const MAX_PENDING = 200

let dir: string | null = null
const pending: string[] = []

function stamp(tag: string, message: string): string {
  return `${new Date().toISOString()} [${tag}] ${message}`
}

function write(line: string): void {
  if (dir === null) {
    // Dropping the newest keeps the startup record, which is the valuable end.
    if (pending.length < MAX_PENDING) pending.push(line)
    return
  }
  const file = path.join(dir, RUNTIME_LOG_FILE)
  try {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size > MAX_BYTES) fs.renameSync(file, path.join(dir, RUNTIME_LOG_PREVIOUS_FILE))
    fs.appendFileSync(file, `${line}\n`)
  } catch {
    // A log that cannot be written must never take the app down with it, and
    // there is nowhere left to report the failure to.
  }
}

/** Point the log at the diagnostics directory and flush anything held. */
export function configureRuntimeLog(directory: string): void {
  try {
    fs.mkdirSync(directory, { recursive: true })
    dir = directory
  } catch {
    return
  }
  const held = pending.splice(0, pending.length)
  for (const line of held) write(line)
}

/**
 * Append one line, and mirror it to the console for a development run.
 *
 * Callers pass a single line of `key=value` pairs rather than prose: the file is
 * read by whoever receives a bug report, usually by grepping for the tag.
 */
export function logRuntime(tag: string, message: string): void {
  const line = stamp(tag, message)
  console.log(line)
  write(line)
}

/** Append several lines under one tag, for multi-line output such as stderr. */
export function logRuntimeLines(tag: string, chunk: string): void {
  for (const raw of chunk.split('\n')) {
    const line = raw.trimEnd()
    if (line) logRuntime(tag, line)
  }
}
