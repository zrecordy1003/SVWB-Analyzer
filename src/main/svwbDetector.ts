// svwb-detect.ts
import { windowManager } from 'node-window-manager'
import type { Window as WindowHandle } from 'node-window-manager'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
const TITLE_REGEX = /shadowversewb/i

/** ---------- Title predicate ---------- */
const isLikelyShadowverseTitle = (title: string): boolean => TITLE_REGEX.test(title)

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

/** ---------- Window selection (no minimize/visibility filtering per your request) ---------- */
function findShadowverseWindowCandidate(): WindowHandle | undefined {
  const windows = windowManager.getWindows()
  return windows.find((w) => isLikelyShadowverseTitle(w.getTitle() ?? ''))
}

/** ---------- PowerShell process info ---------- */
/**
 * Get full executable path of a PID via PowerShell.
 * Returns null if not found / error / permission.
 */
async function getExecutablePathByPid(pid: number): Promise<string | null> {
  // NOTE: pid is numeric from our guard; no string interpolation risk.
  const ps = `
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($proc -and $proc.Path) { $proc.Path }
`.trim()

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 2000 }
    ) // 2s timeout is usually enough
    const path = stdout?.toString().trim()
    return path || null
  } catch {
    return null
  }
}

/** Normalize path for comparison (case-insensitive on Windows) */
function normalizePath(p: string): string {
  return p.replace(/["\r\n]/g, '')
}

/** Check if the path ends with the expected game exe (case-insensitive) */
function isGameExecutable(path: string | null): boolean {
  if (!path) return false
  const normalized = normalizePath(path)
  return (
    normalized.toLowerCase().endsWith(`\\${GAME_EXE_BASENAME}`) ||
    normalized.toLowerCase().endsWith(`/${GAME_EXE_BASENAME}`)
  )
}

/** ---------- Public API ---------- */
/** Check if ShadowverseWB is running (verified by executable name). */
export async function isShadowverseRunning(): Promise<ShadowverseStatus> {
  const candidate = findShadowverseWindowCandidate()
  if (!candidate) return { running: false, hwnd: null }

  const pid = getPidFromWindow(candidate)
  if (!pid) return { running: false, hwnd: null }

  const exePath = await getExecutablePathByPid(pid)
  if (!isGameExecutable(exePath)) return { running: false, hwnd: null }

  const b = candidate.getBounds()
  return {
    running: true,
    hwnd: candidate.id,
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
  }
}
