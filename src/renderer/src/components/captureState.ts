/**
 * One answer to "is this app able to record right now, and if not, why".
 *
 * The header pill and the sidebar badge both answer it. They used to derive it
 * separately - the header from a single `capturing` boolean, the badge from the
 * full game status - so with the game closed the header said a red
 * 「偵測暫停中」 while the badge said a grey 「未偵測到遊戲」. Both read this now.
 *
 * Pure, so the precedence below is testable without React.
 */
import { computeResolutionStatus, type ResolutionStatus } from './resolutionStatus'

export type GameWindowStatus = {
  running: boolean
  bounds?: { x?: number; y?: number; width?: number; height?: number }
  engineReady?: boolean
  capturing?: boolean
}

export type CaptureKind =
  | 'loading'
  | 'noGame'
  | 'minimized'
  | 'engineDown'
  | 'waitingFrames'
  | 'badResolution'
  | 'watching'

export type CaptureTone = 'idle' | 'ok' | 'warn' | 'error'

export type CaptureState = {
  kind: CaptureKind
  tone: CaptureTone
  /** A few characters, for the header pill. */
  label: string
  /** What is going on and what to do about it, for the tooltip. */
  detail: string
  resolution: ResolutionStatus | null
}

const DIAGNOSTICS_HINT = '若持續顯示，請到「設定 → 辨識診斷」匯出診斷包回報。'

/** Windows parks a minimised window at (-32000, -32000). */
const isMinimized = (s: GameWindowStatus): boolean =>
  s.bounds?.x === -32000 && s.bounds?.y === -32000

/**
 * Precedence: the state that explains the most wins. An engine that never
 * started outranks everything after the game is found, because it is the one
 * case where a match is silently not recorded; a minimised window explains a
 * missing capture, so it comes before "waiting for frames"; a bad resolution
 * only matters once frames are actually arriving.
 */
export function captureStateOf(s: GameWindowStatus | undefined): CaptureState {
  if (s === undefined) {
    return {
      kind: 'loading',
      tone: 'idle',
      label: '讀取中',
      detail: '正在讀取遊戲狀態。',
      resolution: null
    }
  }
  if (!s.running) {
    return {
      kind: 'noGame',
      tone: 'idle',
      label: '等待遊戲',
      detail: '還沒找到 Shadowverse: Worlds Beyond 的視窗。開啟遊戲後會自動開始偵測。',
      resolution: null
    }
  }
  if (isMinimized(s)) {
    return {
      kind: 'minimized',
      tone: 'warn',
      label: '遊戲已最小化',
      detail: '遊戲最小化時無法辨識，已暫停偵測。還原視窗後會自動繼續。',
      resolution: null
    }
  }
  if (s.engineReady === false) {
    return {
      kind: 'engineDown',
      tone: 'error',
      label: '辨識未啟動',
      detail: `辨識沒有啟動，這段期間的對局不會記錄。請重新開啟 SVWB Analyzer。${DIAGNOSTICS_HINT}`,
      resolution: null
    }
  }
  const resolution = computeResolutionStatus(s.bounds)
  if (s.capturing === false) {
    return {
      kind: 'waitingFrames',
      tone: 'warn',
      label: '等待畫面',
      detail: `已找到遊戲，但還沒收到遊戲畫面。${DIAGNOSTICS_HINT}`,
      resolution
    }
  }
  if (!resolution.ok) {
    return {
      kind: 'badResolution',
      tone: 'warn',
      label: '解析度不支援',
      detail: `目前 ${resolution.label}：${resolution.hint || '建議使用 16:9 解析度，且不低於 1280×720'}。`,
      resolution
    }
  }
  return {
    kind: 'watching',
    tone: 'ok',
    label: '偵測中',
    detail: '正在讀取遊戲畫面。對戰開始後會顯示雙方職業，結束後自動記錄。',
    resolution
  }
}
