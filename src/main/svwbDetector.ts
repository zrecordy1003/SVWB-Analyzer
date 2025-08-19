/* eslint-disable @typescript-eslint/no-explicit-any */
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
// 標題規則保留，但不再單獨作為判定依據（只能在最後當輔助，且仍需 PID→路徑驗證）
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

/** ---------- Small cache to reduce shelling ---------- */
interface CacheEntry<T> {
  at: number
  data: T
}
const CACHE_TTL_MS = 1500 // 建議 1~2 秒
let procCache: CacheEntry<{ running: boolean; pids: number[] }> | null = null
let pathCache: CacheEntry<Map<number, string | null>> | null = null

function isFresh(entry: CacheEntry<any> | null, ttl = CACHE_TTL_MS): boolean {
  return !!entry && Date.now() - entry.at < ttl
}

/** ---------- PowerShell helpers ---------- */
/**
 * Get executable paths for a set of PIDs in **one** PowerShell call.
 * Returns a Map<pid, path|null>. Unknown or access-denied => null.
 */
async function getExecutablePathsByPids(pids: number[]): Promise<Map<number, string | null>> {
  if (pids.length === 0) return new Map()
  const pidList = pids.join(',')
  const ps = `
$ids = @(${pidList})
$procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
$result = @{}
foreach ($p in $procs) {
  try {
    $result[$p.Id] = $p.Path
  } catch {
    $result[$p.Id] = $null
  }
}
$result.GetEnumerator() | ForEach-Object { "$($_.Key)|$($_.Value)" }
`.trim()

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 2000 }
    )
    const map = new Map<number, string | null>()
    const lines = stdout?.toString().trim().split(/\r?\n/).filter(Boolean) ?? []
    for (const line of lines) {
      const [pidStr, path] = line.split('|')
      const pid = Number(pidStr)
      if (Number.isFinite(pid)) {
        map.set(pid, (path ?? '').trim() || null)
      }
    }
    return map
  } catch {
    return new Map()
  }
}

/** Check if a process with target EXE is running (fast path). */
async function isGameProcessRunning(): Promise<{ running: boolean; pids: number[] }> {
  if (isFresh(procCache)) return procCache!.data

  // 以 process 名稱查（不含 .exe），快且足夠
  const ps = `
$ps = Get-Process -Name shadowversewb -ErrorAction SilentlyContinue
if ($ps) { $ps | Select-Object -ExpandProperty Id }
`.trim()

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 1500 }
    )
    const lines = stdout?.toString().trim().split(/\r?\n/).filter(Boolean) ?? []
    const pids = lines.map((s) => Number(s)).filter((n) => Number.isFinite(n))
    const data = { running: pids.length > 0, pids }
    procCache = { at: Date.now(), data }
    return data
  } catch {
    const data = { running: false, pids: [] }
    procCache = { at: Date.now(), data }
    return data
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

/**
 * Try to find a window for game PIDs.
 *
 * ⚠️ 修正重點：
 *   1) **不再**直接以標題命中就回傳，所有命中都要「PID → 路徑」驗證。
 *   2) 先把「哪些 PID 真的是遊戲」確立（PID→Path 篩選，路徑需 match shadowversewb.exe）。
 *   3) 只在「找不到任何 PID 命中視窗」時，才用標題當「最後備援」，
 *      但仍必須能取到該視窗 PID，並做路徑驗證。
 */
async function findShadowverseWindowForPids(gamePids: number[]): Promise<WindowHandle | undefined> {
  if (gamePids.length === 0) return undefined

  const windows = windowManager.getWindows()

  // 建立有效的「遊戲 PID 集合」：以可執行檔路徑為準
  if (!isFresh(pathCache)) {
    const map = await getExecutablePathsByPids(gamePids)
    pathCache = { at: Date.now(), data: map }
  }
  const pathMap = pathCache!.data

  const validGamePids = new Set<number>()
  for (const pid of gamePids) {
    if (isGameExecutable(pathMap.get(pid) ?? null)) {
      validGamePids.add(pid)
    }
  }

  // Pass A: 直接找 PID 命中（最精準、0 誤判）
  for (const w of windows) {
    const pid = getPidFromWindow(w)
    if (pid && validGamePids.has(pid)) return w
  }

  // Pass B: 才用標題當輔助，但仍要「PID→路徑」二次驗證
  // （避免 Chrome/Edge/Firefox 等含相同關鍵字的分頁/視窗誤判）
  const titleCandidates = windows.filter((w) => isLikelyShadowverseTitle(w.getTitle() ?? ''))
  for (const w of titleCandidates) {
    const pid = getPidFromWindow(w)
    if (!pid) continue

    // 如果這個 PID 不在原本的 gamePids，就再查一次它的路徑做確認（少見情況）
    let pathOk = validGamePids.has(pid)
    if (!pathOk) {
      const extra = await getExecutablePathsByPids([pid])
      pathOk = isGameExecutable(extra.get(pid) ?? null)
    }

    if (pathOk) return w
  }

  // 仍找不到
  return undefined
}

/** ---------- Public API ---------- */
/** Check if ShadowverseWB is running. Process-first; window lookup only if needed. */
export async function isShadowverseRunning(): Promise<ShadowverseStatus> {
  // 先確認「行程」是否存在（避免最小化/無標題時誤判，也避免不必要的 window 掃描）
  const proc = await isGameProcessRunning()
  if (!proc.running) {
    return { running: false, hwnd: null }
  }

  // 僅在行程存在時，才嘗試找視窗
  const candidate = await findShadowverseWindowForPids(proc.pids)

  if (candidate) {
    const b = candidate.getBounds()
    return {
      running: true,
      hwnd: candidate.id,
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
    }
  }

  // 沒找到視窗但行程存在：仍回傳 running=true，bounds 省略
  return { running: true, hwnd: null, bounds: undefined }
}
