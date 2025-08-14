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
// 放寬：有些狀態標題不是 exe 名，或最小化後變空
const TITLE_REGEX = /shadowverse|worlds\s*beyond|shadowversewb/i

/** ---------- Title predicate ---------- */
const isLikelyShadowverseTitle = (title: string): boolean => TITLE_REGEX.test(title ?? '')

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

/** ---------- PowerShell helpers ---------- */
/** Get full executable path of a PID via PowerShell. */
async function getExecutablePathByPid(pid: number): Promise<string | null> {
  const ps = `
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($proc -and $proc.Path) { $proc.Path }
`.trim()

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 2000 }
    )
    const path = stdout?.toString().trim()
    return path || null
  } catch {
    return null
  }
}

/** Check if a process with target EXE is running (fast path when window title fails). */
async function isGameProcessRunning(): Promise<{ running: boolean; pids: number[] }> {
  const ps = `
$ps = Get-Process -Name ${GAME_EXE_BASENAME.replace?.('.', '\\.') ?? 'shadowversewb'} -ErrorAction SilentlyContinue
if ($ps) { $ps | Select-Object -ExpandProperty Id }
`.trim()

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 2000 }
    )
    const lines = stdout?.toString().trim().split(/\r?\n/).filter(Boolean) ?? []
    const pids = lines.map((s) => Number(s)).filter((n) => Number.isFinite(n))
    return { running: pids.length > 0, pids }
  } catch {
    return { running: false, pids: [] }
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
  const lower = normalized.toLowerCase()
  return lower.endsWith(`\\${GAME_EXE_BASENAME}`) || lower.endsWith(`/${GAME_EXE_BASENAME}`)
}

/** Try to find a window by relaxed title first (fast), or by PID/executable (robust). */
async function findShadowverseWindow(): Promise<WindowHandle | undefined> {
  const windows = windowManager.getWindows()

  // Pass 1: best-effort by title (works when not minimized / title present)
  const byTitle = windows.find((w) => isLikelyShadowverseTitle(w.getTitle() ?? ''))
  if (byTitle) return byTitle

  // Pass 2: robust path — map PID -> exe path and match
  for (const w of windows) {
    const pid = getPidFromWindow(w)
    if (!pid) continue
    const exePath = await getExecutablePathByPid(pid)
    if (isGameExecutable(exePath)) return w
  }

  return undefined
}

/** ---------- Public API ---------- */
/** Check if ShadowverseWB is running. Process-first; window is best-effort. */
export async function isShadowverseRunning(): Promise<ShadowverseStatus> {
  // 先確認「行程」是否存在（避免最小化/無標題時誤判）
  const proc = await isGameProcessRunning()

  // 再盡量找視窗（即使最小化也會存在，只是 bounds 可能是 -32000,*）
  const candidate = await findShadowverseWindow()

  if (!proc.running && !candidate) {
    return { running: false, hwnd: null }
  }

  if (candidate) {
    const b = candidate.getBounds()
    return {
      running: true,
      hwnd: candidate.id,
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
    }
  }

  // 沒找到視窗但行程存在：仍回傳 running=true，bounds 先省略
  return { running: true, hwnd: null, bounds: undefined }
}
