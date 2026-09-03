/**
 * Reads the local diagnostics store and packs it into a single zip.
 *
 * Deliberately free of Electron imports so it can be exercised outside the app
 * (see `tools/vision-node-addon/check-bundle.cjs`) - a broken export would
 * otherwise only be discovered by a user who is already having trouble.
 */
import fs from 'fs'
import path from 'path'
import JSZip from 'jszip'

const EVENTS_FILES = ['events.jsonl', 'events.previous.jsonl']
const FRAMES_DIR = 'frames'

export type DiagnosticsSummary = {
  eventCount: number
  frameCount: number
  bytes: number
  latestAt: string | null
}

export type EventRecord = { at?: string; kind?: string; label?: string } & Record<string, unknown>

export type BundleEnvironment = {
  appVersion: string
  platform: string
  osRelease: string
  logicalCores: number
}

export function readEvents(dir: string): EventRecord[] {
  const out: EventRecord[] = []
  for (const name of EVENTS_FILES) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed))
      } catch {
        // A truncated final line is expected if the app was killed mid-write.
      }
    }
  }
  return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
}

export function listFrames(dir: string): string[] {
  const framesDir = path.join(dir, FRAMES_DIR)
  if (!fs.existsSync(framesDir)) return []
  return fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.png') || f.endsWith('.json'))
    .sort()
}

function directoryBytes(dir: string): number {
  let total = 0
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += fs.statSync(full).size
    }
  }
  walk(dir)
  return total
}

export function summarise(dir: string): DiagnosticsSummary {
  const events = readEvents(dir)
  return {
    eventCount: events.length,
    frameCount: listFrames(dir).filter((f) => f.endsWith('.png')).length,
    bytes: directoryBytes(dir),
    latestAt: events.length > 0 ? (events[events.length - 1].at ?? null) : null
  }
}

export function clearStore(dir: string): void {
  for (const name of EVENTS_FILES) fs.rmSync(path.join(dir, name), { force: true })
  fs.rmSync(path.join(dir, FRAMES_DIR), { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, FRAMES_DIR), { recursive: true })
}

const KIND_EXPLANATIONS: Record<string, string> = {
  'near-miss': '分數落在門檻正下方，模板可能已過期',
  'ocr-reject': 'OCR 讀出的內容不是整數',
  'mode-unattributable': '結算畫面無法歸因到任何模式（最需要關注）',
  'class-unrecognised': '職業或先後攻辨識失敗，該場未被記錄',
  'mode-guessed': '模式未偵測到，以「自由對戰」填入',
  'ranked-no-numbers': '階級對戰結束但完全沒讀到 BP/MP/CR',
  'tick-over-budget': '單次分析超過 500ms 預算',
  'weak-mode-accepted': '以未校準的廣場賽/自訂房探測判定模式（附畫面待覆核）',
  'mode-corrected': '結算畫面的積分制度標籤推翻了先前的模式判定',
  'final-screen-never-seen':
    '等了十分鐘都沒等到結算畫面，也沒有下一場或回放（多半是關掉遊戲或擷取中斷）',
  'closed-by-next-match': '結算畫面還沒讀完就開了下一場，該場只留下勝負',
  'closed-by-capture-stop': '結算畫面還沒讀完就停止擷取，該場只留下勝負'
}

/**
 * A summary that can be pasted straight into a bug report, so whoever receives
 * it can see the shape of the problem before opening a single image.
 */
export function buildReportMarkdown(
  events: EventRecord[],
  frames: string[],
  env: BundleEnvironment
): string {
  const byKind = new Map<string, number>()
  for (const e of events) {
    const kind = String(e.kind ?? 'unknown')
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
  }
  const frameCount = frames.filter((f) => f.endsWith('.png')).length

  const lines: string[] = [
    '# 辨識診斷回報',
    '',
    '此檔由 SVWB Analyzer 的「辨識異常自我診斷」產生，內容全部來自本機記錄。',
    '',
    '## 環境',
    '',
    '| 項目 | 值 |',
    '| --- | --- |',
    `| App 版本 | ${env.appVersion} |`,
    `| 作業系統 | ${env.platform} ${env.osRelease} |`,
    `| 邏輯核心數 | ${env.logicalCores} |`,
    `| 事件筆數 | ${events.length} |`,
    `| 畫面張數 | ${frameCount} |`,
    '',
    '> 核心數會影響比對速度。核心較少時單次分析較慢，可能整場錯過只顯示約一秒的畫面'.concat(
      '（例如先後攻提示）。'
    ),
    '',
    '## 異常種類統計',
    '',
    '| 種類 | 次數 | 說明 |',
    '| --- | --- | --- |'
  ]

  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${kind}\` | ${count} | ${KIND_EXPLANATIONS[kind] ?? ''} |`)
  }
  if (byKind.size === 0) lines.push('| （無） | 0 | |')

  const recent = events.slice(-30)
  if (recent.length > 0) {
    lines.push(
      '',
      `## 最近事件（共 ${events.length} 筆，列出最後 ${recent.length} 筆）`,
      '',
      '```json'
    )
    for (const e of recent) lines.push(JSON.stringify(e))
    lines.push('```')
  }

  if (frameCount > 0) {
    lines.push(
      '',
      '## 畫面',
      '',
      '`frames/` 是異常發生時的畫面，已轉為灰階、裁除視窗標題列、統一縮放為 1280×720',
      '——也就是比對器實際看到的內容。每張圖旁的 `.json` 記錄當時各區域的分數，',
      '欄位刻意對齊專案的離線驗證工具，可直接放入 `tests/fixtures/captures/` 當回歸案例。'
    )
  }

  return `${lines.join('\n')}\n`
}

/** Build the zip in memory. Returns null when there is nothing to report. */
export async function buildBundle(dir: string, env: BundleEnvironment): Promise<Buffer | null> {
  const events = readEvents(dir)
  const frames = listFrames(dir)
  if (events.length === 0 && frames.length === 0) return null

  const zip = new JSZip()
  zip.file('report.md', buildReportMarkdown(events, frames, env))
  zip.file(
    'report.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...env, events }, null, 2)}\n`
  )
  const framesFolder = zip.folder(FRAMES_DIR)
  for (const name of frames) {
    framesFolder?.file(name, fs.readFileSync(path.join(dir, FRAMES_DIR, name)))
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
