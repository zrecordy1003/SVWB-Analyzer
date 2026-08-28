/**
 * Supervises `svwb-engine` and applies what it reports.
 *
 * This replaces `forkedImageAnalyzer.ts`. The recognition, the timing and the
 * state machine all moved into the engine; what is left here is the part that
 * genuinely belongs to Electron - spawning a process, writing to the database,
 * and telling the renderer.
 *
 * That division is the whole point of the refactor. The old analyzer welded the
 * state machine to `process.parentPort` and to Prisma, which made it impossible
 * to load in a test, which is why a 953-line hand-copied mirror of it existed in
 * the test suite. Nothing below this file knows Electron exists.
 *
 * # Protocol
 *
 * JSON Lines both ways. Events arrive on the engine's stdout; commands and
 * replies to `readNumber` go back on its stdin. See `tools/engine/src/host.rs`.
 *
 * # Match identity
 *
 * The engine allocates its own `ref` and never learns the database id - if it
 * did, the state machine would need a database to be testable again. This file
 * owns the `ref -> Match.id` mapping, and that mapping is the only thing that
 * disappears when the engine takes over persistence.
 */
import { app, BrowserWindow, Notification } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { ClassName, GameMode, PlayOrder } from '../../shared/domain.js'
import type { BattleStatus } from '../../shared/types.js'
import { ENGINE_BINARY } from '../../shared/engineBinary.js'

import { getTesseractCacheDir } from '../paths.js'
import { store } from '../store.js'
import { broadcast } from '../utils/broadcast.js'
import { configureNumberReader, disposeNumberReader, readNumber } from './engineNumbers.js'
import {
  configureDiagnostics,
  flushDiagnostics,
  noteFromEngine,
  noteScore,
  noteSlowTick,
  type DiagnosticKind
} from './diagnosticsRecorder.js'
import { getDiagnosticsDir } from '../paths.js'

// Re-exported rather than redefined. The two copies of this interface had
// already drifted apart once in spirit - adding a field here and not there is
// silent, because the broadcast is untyped across the IPC boundary.
export type { BattleStatus }

const IDLE_STATUS: BattleStatus = {
  inBattle: false,
  ownClass: null,
  enemyClass: null,
  playOrder: null,
  mode: null
}

/** The slice of the engine's match patch the notification reads. */
type MatchPatch = {
  result?: boolean
  bp?: number
}

let engineProcess: ChildProcess | null = null
let starting = false
let battleStatus: BattleStatus = IDLE_STATUS

function getEnginePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', ENGINE_BINARY)
    : path.join(__dirname, '../../tools/target/release', ENGINE_BINARY)
}

function getDbPath(): string {
  const dir = path.join(app.getPath('userData'), 'db')
  return path.join(dir, 'app.db')
}

function getMigrationsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'migrations')
    : path.join(__dirname, '../../resources/migrations')
}

function getTemplatesPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'templates')
    : path.join(__dirname, '../../resources/templates')
}

export function getBattleStatus(): BattleStatus {
  return battleStatus
}

function setStatus(next: BattleStatus): void {
  battleStatus = next
  broadcast('battle:status', next)
}

export function startEngine(_mainWindow: BrowserWindow): void {
  if (starting || engineProcess) {
    console.log('[Engine] already running, skip')
    return
  }
  starting = true

  try {
    // Opt-out, so an unset value counts as enabled - this Store has no defaults,
    // and a never-written key reads as undefined.
    configureDiagnostics({
      dir: getDiagnosticsDir(),
      enabled: store.get('settings.diagnostics') !== false,
      appVersion: app.getVersion(),
      platform: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim()
    })

    configureNumberReader({
      // Tesseract decompresses the shipped .traineddata.gz on first use, so this
      // has to be somewhere writable - not inside the installed app directory.
      cachePath: getTesseractCacheDir(),
      langPath: app.isPackaged
        ? path.join(process.resourcesPath, 'tessdata')
        : path.join(__dirname, '../../')
    })

    const child = spawn(
      getEnginePath(),
      [
        'live',
        // Frames come from Windows Graphics Capture inside the engine; the
        // host only supplies the HWND via `attachCapture`. No PNG on disk.
        '--capture',
        '--templates',
        getTemplatesPath(),
        // The engine saves the frame behind an anomaly; this side writes the
        // sidecar and the event log beside it. See `diagnosticsRecorder`.
        '--diagnostics-dir',
        getDiagnosticsDir(),
        // The engine writes matches itself; these mirror what `initDatabase`
        // migrated at startup, and applying twice is a no-op.
        '--db',
        getDbPath(),
        '--migrations',
        getMigrationsDir()
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    engineProcess = child

    child.once('exit', (code) => {
      console.log('[Engine] exited:', code)
      engineProcess = null
      setStatus(IDLE_STATUS)
      // Counters that never reached their flush window would otherwise be lost.
      flushDiagnostics()
      void disposeNumberReader()
    })
    child.once('error', (err) => {
      console.error('[Engine] failed to start:', err)
      engineProcess = null
    })
    // The engine's stderr is for humans only; anything the host must act on
    // arrives as an event.
    child.stderr?.on('data', (chunk) => console.log('[Engine]', String(chunk).trimEnd()))

    const lines = readline.createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      if (!line.trim()) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch {
        console.warn('[Engine] unparseable line:', line.slice(0, 120))
        return
      }
      void handle(event, child)
    })
  } finally {
    starting = false
  }
}

/**
 * Write one command line, or silently do nothing when the pipe is gone.
 *
 * Electron fires BOTH `window-all-closed` and `before-quit` on the way out, and
 * each teardown path detaches then stops - so the second pass runs against a
 * stream the first pass already ended. Writing to an ended stream throws an
 * UNCAUGHT `ERR_STREAM_WRITE_AFTER_END` that surfaces as an error dialog over
 * the closing app, so writability is checked here, once, for every sender.
 */
function send(command: Record<string, unknown>): void {
  const stdin = engineProcess?.stdin
  if (!stdin || !stdin.writable) return
  stdin.write(JSON.stringify(command) + '\n')
}

/**
 * Point the engine's capture at a verified game window.
 *
 * Safe to call on every poll: the engine treats attaching to the current
 * target as a no-op, and re-sending is what re-establishes capture after an
 * engine restart without the host having to track that it happened.
 */
export function attachCapture(hwnd: number): void {
  send({ command: 'attach', hwnd })
}

/** Stop capturing (the game minimised or closed); the engine keeps running. */
export function detachCapture(): void {
  send({ command: 'detach' })
}

export function isEngineRunning(): boolean {
  return engineProcess !== null
}

export function stopEngine(): void {
  const child = engineProcess
  if (!child) return
  // Cleared up front, so the second teardown pass finds nothing to write to.
  engineProcess = null

  try {
    // Asking first lets the engine finish the tick it is in. Closing stdin is
    // the fallback: the engine treats a closed channel as the host being gone.
    if (child.stdin?.writable) {
      child.stdin.write(JSON.stringify({ command: 'stop' }) + '\n')
      child.stdin.end()
    }
  } catch (e) {
    console.warn('[Engine] stop failed, killing', e)
    try {
      child.kill()
    } catch (killError) {
      console.log('[Engine] kill failed:', killError)
    }
  }
}

/**
 * Plan P6-c: digit templates as a harvested asset.
 *
 * Every crop Tesseract reads cleanly is kept with its answer as the label, so
 * the sample set a template-based reader needs - two font sizes, every digit
 * including the `0` that no fixture happens to contain - accumulates as a side
 * effect of normal play. A future `TemplateReader` is accepted only if it beats
 * Tesseract on held-out harvested data; until then this folder just fills up.
 *
 * Capped per session and piggybacking on the diagnostics opt-out: this is
 * diagnostic data, and a user who turned diagnostics off has said no to it.
 */
const HARVEST_CAP = 300
let harvestedThisSession = 0

function harvestDigits(pngBase64: string, text: string | null): void {
  if (harvestedThisSession >= HARVEST_CAP) return
  if (store.get('settings.diagnostics') === false) return
  const clean = (text ?? '').replace(/\s+/g, '')
  if (!/^[-+]?\d+$/.test(clean)) return

  try {
    const dir = path.join(getDiagnosticsDir(), 'digits')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${Date.now()}_${clean}.png`), Buffer.from(pngBase64, 'base64'))
    harvestedThisSession++
  } catch {
    // Harvesting must never cost a number read its reply.
  }
}

async function handle(event: Record<string, unknown>, child: ChildProcess): Promise<void> {
  switch (event.event) {
    case 'ready':
      console.log(`[Engine] ready, ${event.templatesLoaded} templates`)
      break

    case 'readNumber': {
      // The engine BLOCKS until this is answered, so every path here must reply
      // - including the failure path, where `text: null` means "unreadable now"
      // and the engine simply retries on the next frame.
      const text = await readNumber(String(event.png))
      harvestDigits(String(event.png), text)
      child.stdin?.write(JSON.stringify({ numberRead: true, id: event.id, text }) + '\n')
      break
    }

    case 'matchStarted': {
      // The row already exists - the engine wrote it before emitting this. The
      // HUD's battle status comes from `statusChanged` below, which carries the
      // HUD's own vocabulary (ownClass/enemyClass); this event speaks the
      // database's (myClass/oppoClass), and reading HUD names off it is exactly
      // the field-name bug that once left the opponent blank mid-battle.
      broadcast('matches:needRefetch')
      break
    }

    case 'statusChanged':
      // Emitted by the engine on every battle-state change, already in the
      // shape the HUD consumes - see BattleStatus in the engine's protocol.
      setStatus({
        inBattle: Boolean(event.inBattle),
        ownClass: (event.ownClass ?? null) as ClassName | null,
        enemyClass: (event.enemyClass ?? null) as ClassName | null,
        playOrder: (event.playOrder ?? null) as PlayOrder | null,
        // The engine re-emits this event when a mode resolves mid-battle, so
        // the HUD can retarget the moment 2Pick is recognised on the versus
        // screen instead of waiting for the match to close.
        mode: (event.mode ?? null) as GameMode | null
      })
      break

    case 'matchUpdated':
      broadcast('matches:needRefetch')
      break

    case 'matchFinished': {
      setStatus(IDLE_STATUS)
      broadcast('matches:needRefetch')
      notifyOnce(event.patch as MatchPatch)
      break
    }

    // NOT a finish with empty fields. A replay shows the same versus screen as a
    // real match, so the row opened just before one started is not a match with
    // missing data - it is not a match, and leaving it behind would put a phantom
    // entry in the history.
    case 'matchAbandoned': {
      // The engine already deleted the row; the UI just has to stop showing it.
      setStatus(IDLE_STATUS)
      broadcast('matches:needRefetch')
      break
    }

    case 'captureChanged':
      // `framesSeen` is the proof pixels flowed. "Attached but zero frames" is
      // the shape of a capture problem the user reports as "nothing recorded".
      console.log(
        `[Engine] capture ${event.attached ? 'attached' : `detached after ${event.framesSeen} frames`}`
      )
      broadcast('capture:status', Boolean(event.attached))
      break

    case 'replaySuppressionChanged':
      console.log('[Engine] replay suppression:', event.suppressed)
      break

    case 'diagnostic': {
      const detail = (event.detail ?? {}) as Record<string, unknown>
      noteFromEngine(event.kind as DiagnosticKind, String(event.label), detail)
      // Lets the settings page counter update live without polling.
      broadcast('diagnostics:new', { kind: event.kind, label: event.label })
      break
    }

    case 'nearMiss':
      // Aggregated, not written per occurrence: this can fire every tick, and
      // what matters is how often and how bad.
      noteScore(String(event.label), Number(event.score), Number(event.threshold))
      break

    case 'slowTick':
      // Aggregated rather than written per occurrence: a slow tick can repeat
      // every 500ms, and what matters is how often and how bad, not each one.
      noteSlowTick(Number(event.elapsedMs), Number(event.budgetMs))
      console.warn(`[Engine] tick took ${event.elapsedMs}ms over ${event.budgetMs}ms`)
      break

    case 'failed':
      console.error('[Engine] failure:', event.message)
      if (event.fatal) stopEngine()
      break

    default:
      console.warn('[Engine] unknown event:', event.event)
  }
}

function notifyOnce(patch: MatchPatch | undefined): void {
  if (store.get('settings.enableNotifications') !== true) return
  if (!patch || patch.result === undefined) return
  new Notification({
    title: patch.result ? '勝利已記錄' : '敗北已記錄',
    body: patch.bp !== undefined ? `BP ${patch.bp > 0 ? '+' : ''}${patch.bp}` : ''
  }).show()
}
