import { windowManager, Window } from 'node-window-manager'
import type { Window as WindowHandle } from 'node-window-manager'

/** Window bounds info */
export interface Bounds {
  x?: number
  y?: number
  width?: number
  height?: number
}

/** Game running status */
export interface ShadowverseStatus {
  running: boolean
  hwnd: number | null
  bounds?: Bounds
}

/** ---------- Constants ---------- */
const GAME_EXE_BASENAME = 'shadowversewb.exe'
// 標題規則保留，但只在視窗路徑讀不到時才當備援（見 findGameWindow）
const TITLE_REGEX = /shadowverse|worlds\s*beyond|shadowversewb/i

/**
 * Minimum gap between full window enumerations while the game is absent.
 *
 * A scan walks every top-level window on the desktop - roughly 13ms - so doing
 * it on every one-second tick would cost 1.3% of a core forever, in the state a
 * tray app spends most of its life in. Once the game *is* found the handle is
 * re-verified instead, which costs about 17 microseconds.
 */
const RESCAN_INTERVAL_MS = 2000

/** ---------- PID helpers (type guards) ---------- */
type MaybePidProvider = Partial<{
  getProcessId: () => number
  processId: number
}>

/** Safely read PID from node-window-manager Window */
function getPidFromWindow(w: WindowHandle): number | undefined {
  const win = w as unknown as MaybePidProvider
  if (typeof win.getProcessId === 'function') return win.getProcessId()
  if (typeof win.processId === 'number') return win.processId
  return undefined
}

/** Check if the path ends with the expected game exe (case-insensitive) */
function isGameExecutable(path: string | null | undefined): boolean {
  if (!path) return false
  const lower = path.replace(/["\r\n]/g, '').toLowerCase()
  return lower.endsWith(`\\${GAME_EXE_BASENAME}`) || lower.endsWith(`/${GAME_EXE_BASENAME}`)
}

/**
 * Does this window have an area to capture?
 *
 * A minimised window still counts - it reports a real size at the off-screen
 * (-32000, -32000) position, and callers decide what to do about that. Only
 * genuinely sizeless windows are rejected here.
 */
function hasRenderableBounds(w: WindowHandle): boolean {
  try {
    const b = w.getBounds()
    return (b.width ?? 0) > 0 && (b.height ?? 0) > 0
  } catch {
    return false
  }
}

/** ---------- Detection state ---------- */
/**
 * The game window last identified, the PIDs it belonged to, and when the last
 * full scan ran. Kept so both the one-second status poll and the much faster
 * foreground check can answer without re-enumerating the desktop.
 */
let knownGameHwnd: number | null = null
let knownGamePids = new Set<number>()
let lastScanAt = 0

/**
 * Memo of the last foreground window and the answer given for it. The focus
 * check runs many times a second and the foreground window changes rarely, so
 * in the steady state this reduces the whole thing to one `GetForegroundWindow`
 * - the PID lookup only happens the first tick after a switch.
 */
let focusCacheId: number | null = null
let focusCacheResult = false

function resetFocusCache(): void {
  focusCacheId = null
  focusCacheResult = false
}

function forgetGameWindow(): void {
  knownGameHwnd = null
  knownGamePids = new Set()
  resetFocusCache()
}

/**
 * Re-check the handle already known to be the game.
 *
 * Windows recycles window handles, so a stale one can land on an unrelated
 * app - the executable path is verified again rather than trusted.
 */
function verifyKnownWindow(): WindowHandle | null {
  if (knownGameHwnd == null) return null
  try {
    const candidate = new Window(knownGameHwnd)
    if (!candidate.isWindow()) return null
    return isGameExecutable(candidate.path) ? candidate : null
  } catch {
    return null
  }
}

/**
 * Walk every top-level window looking for the game, and remember its PIDs.
 *
 * The executable path comes straight off the enumeration - node-window-manager
 * resolves it while listing - so identifying the game needs no process query at
 * all. This used to shell out to PowerShell twice (`Get-Process` for the PIDs,
 * then again for their paths) at roughly 390ms per spawn, and then enumerate
 * the windows anyway to find the handle.
 */
function scanForGameWindow(): WindowHandle | null {
  const windows = windowManager.getWindows()
  const pids = new Set<number>()
  let found: WindowHandle | null = null

  for (const w of windows) {
    if (!isGameExecutable(w.path)) continue
    const pid = getPidFromWindow(w)
    if (pid != null) pids.add(pid)
    // The game owns more than one window: the playfield plus hidden IME
    // helpers ("MSCTFIME UI", "Default IME") that share its executable and
    // report 0x0 bounds. Taking whichever came first in enumeration order
    // could hand a caller a window with nothing to capture, so a window with
    // real bounds always wins; the first match is only a fallback.
    if (!found || (!hasRenderableBounds(found) && hasRenderableBounds(w))) found = w
  }

  if (!found) {
    // Last resort: an elevated or protected process can refuse to report its
    // image path, leaving `path` empty. Only then is the title worth
    // consulting - and only for windows whose path is genuinely unreadable, so
    // a browser tab named "Shadowverse" can never match.
    found = windows.find((w) => !w.path && TITLE_REGEX.test(w.getTitle() ?? '')) ?? null
    if (found) {
      const pid = getPidFromWindow(found)
      if (pid != null) pids.add(pid)
    }
  }

  knownGamePids = pids
  return found
}

/** ---------- Public API ---------- */
/**
 * Is the game the window the user is actually looking at?
 *
 * Deliberately synchronous and allocation-light: this is `GetForegroundWindow`
 * plus an integer comparison, so it can be polled every frame. It answers
 * `false` until `isShadowverseRunning` has found the game at least once.
 */
export function isGameWindowFocused(): boolean {
  if (knownGamePids.size === 0 && knownGameHwnd == null) return false
  try {
    const active = windowManager.getActiveWindow()
    const id = active?.id ?? null
    if (id == null) return false
    if (id === focusCacheId) return focusCacheResult

    // The handle comparison answers the common case - the game is in front -
    // without touching the process table at all.
    let result = id === knownGameHwnd
    if (!result) {
      const pid = getPidFromWindow(active)
      result = pid != null && knownGamePids.has(pid)
    }

    focusCacheId = id
    focusCacheResult = result
    return result
  } catch {
    // A foreground window can vanish between the handle and the query; that is
    // not an error worth reporting, it just means "not the game right now".
    resetFocusCache()
    return false
  }
}

/**
 * Is ShadowverseWB running, and where is its window?
 *
 * Detection is window-based: a running game always has a window, minimised or
 * not. The previous process-first design could report `running: true` with no
 * handle for a process that had not opened its window yet, which no caller
 * could act on anyway - there is nothing to capture until the window exists.
 */
export function isShadowverseRunning(): ShadowverseStatus {
  let candidate = verifyKnownWindow()

  if (!candidate && Date.now() - lastScanAt >= RESCAN_INTERVAL_MS) {
    lastScanAt = Date.now()
    candidate = scanForGameWindow()
  }

  if (!candidate) {
    if (knownGameHwnd != null) forgetGameWindow()
    return { running: false, hwnd: null }
  }

  if (knownGameHwnd !== candidate.id) {
    knownGameHwnd = candidate.id
    resetFocusCache()
  }

  const b = candidate.getBounds()
  return {
    running: true,
    hwnd: candidate.id,
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
  }
}
