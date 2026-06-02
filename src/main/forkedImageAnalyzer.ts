import { type MessagePortMain } from 'electron'
import fs from 'fs'
import path from 'path'
import cv from '@u4/opencv4nodejs'
import { createWorker, OEM, PSM } from 'tesseract.js'
import {
  clampRectToMat,
  getGameRect,
  getRegionSafe,
  getScaleFactors,
  scaleRect,
  type RectLike
} from './recognition/geometry.js'
import {
  configureTemplateMatchingDebug,
  loadTemplates,
  matchTemplate,
  type ScoreAndName
} from './recognition/templateMatching.js'
import { prepareScaledTemplates, type TemplateGroups } from './recognition/templates.js'
import { anchorAwareRect, detectAnchor } from './recognition/anchor.js'
import type { AnchorResult } from './recognition/anchor.js'
import {
  addMatch,
  clearMyDeck,
  modifyMatchBP,
  modifyMatchCurrentCR,
  modifyMatchDeltaCR,
  modifyMatchMode,
  modifyMatchResult
} from './database.js'
import { ClassName, GameMode, PlayOrder } from '@prisma/client'

type scoreAndName = ScoreAndName

const RANKED_MODE_BASE_RECT = { x: 780 - 20, y: 205 - 20, w: 150, h: 60 }
const TWO_PICK_MODE_BASE_RECT = { x: 780 - 20, y: 295 - 20, w: 180, h: 50 }
const CURRENT_CR_BASE_RECT = { x: 1160, y: 365, w: 75, h: 35 }
const DELTA_CR_BASE_RECT = { x: 1170, y: 335, w: 50, h: 25 }
const RANKED_BP_BASE_RECT = { x: 1115, y: 200, w: 65, h: 30 }
const TWO_PICK_BP_BASE_RECT = { x: 1115, y: 295, w: 65, h: 30 }
const RANKED_CURSOR_BASE_RECT = { x: 1010, y: 150, w: 210, h: 135 }
const TWO_PICK_CURSOR_BASE_RECT = { x: 1010, y: 245, w: 210, h: 135 }
const CR_CURSOR_A_BASE_RECT = { x: 1055, y: 315, w: 210, h: 135 }
const CR_CURSOR_B_BASE_RECT = { x: 1060, y: 280, w: 210, h: 135 }

function topRightAreaRect(gameRect: { x: number; y: number; w: number; h: number }): {
  x: number
  y: number
  w: number
  h: number
} {
  const halfW = Math.floor(gameRect.w / 2)
  const halfH = Math.floor(gameRect.h / 2)
  return { x: gameRect.x + halfW, y: gameRect.y, w: gameRect.w - halfW, h: halfH }
}

function rectFromModeAnchor(params: {
  baseRect: RectLike
  anchor?: AnchorResult
  anchorBaseRect: RectLike
  scale: ReturnType<typeof getScaleFactors>
}): RectLike {
  if (!params.anchor) return scaleRect(params.baseRect, params.scale)
  return anchorAwareRect({
    baseRect: params.baseRect,
    anchor: params.anchor,
    expectedAnchorBase: params.anchorBaseRect,
    scale: params.scale
  })
}

function getOcrRegionOrFallback(params: {
  mat: cv.Mat
  rect: RectLike
  fallbackRect: RectLike
  label: string
  minWidth?: number
  minHeight?: number
}): cv.Mat | null {
  const minWidth = params.minWidth ?? 3
  const minHeight = params.minHeight ?? 8
  const rect = clampRectToMat(params.rect, params.mat)

  if (rect.width >= minWidth && rect.height >= minHeight) {
    return params.mat.getRegion(rect)
  }

  const fallback = clampRectToMat(params.fallbackRect, params.mat)
  if (fallback.width >= minWidth && fallback.height >= minHeight) {
    debugLog('[OCR] anchor ROI too small, fallback to fixed ROI:', {
      label: params.label,
      rect: params.rect,
      clipped: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      fallback: {
        x: fallback.x,
        y: fallback.y,
        w: fallback.width,
        h: fallback.height
      },
      frame: { w: params.mat.cols, h: params.mat.rows }
    })
    return params.mat.getRegion(fallback)
  }

  console.warn('[OCR] skip tiny ROI:', {
    label: params.label,
    rect: params.rect,
    clipped: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    fallback: { x: fallback.x, y: fallback.y, w: fallback.width, h: fallback.height },
    frame: { w: params.mat.cols, h: params.mat.rows }
  })
  return null
}

let original: TemplateGroups

let imagePath = ''
let isPackaged = false
let resourcesPath = ''
let cacheDir = ''
let debugSamplesDir = ''
let ocrWorkerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null

const DEBUG_ANALYZER = process.env.DEBUG_ANALYZER === '1'
const DEBUG_SAMPLES = process.env.DEBUG_ANALYZER_SAMPLES === '1'
const debugLog = (...args: unknown[]): void => {
  if (DEBUG_ANALYZER) console.log(...args)
}

async function getOcrWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker(['eng'], OEM.DEFAULT, {
      cachePath: cacheDir,
      langPath: isPackaged ? path.join(resourcesPath, 'tessdata') : path.join(__dirname, '../../')
    }).catch((err) => {
      ocrWorkerPromise = null
      throw err
    })
  }

  const worker = await ocrWorkerPromise
  await worker.setParameters({
    tessedit_char_whitelist: '+-0123456789',
    tessedit_pageseg_mode: PSM.SINGLE_LINE
  })
  return worker
}

async function shutdownOcrWorker(): Promise<void> {
  if (!ocrWorkerPromise) return
  try {
    const worker = await ocrWorkerPromise
    await worker.terminate()
  } finally {
    ocrWorkerPromise = null
  }
}

async function resetOcrWorker(): Promise<void> {
  try {
    await shutdownOcrWorker()
  } catch (err) {
    console.warn('[OCR] failed to reset worker:', err)
    ocrWorkerPromise = null
  }
}

// 處理父程序訊息
process.parentPort.on('message', (e) => {
  const [port] = e.ports
  // 第一個訊息：帶入初始化參數
  if (e.data && e.data.type === 'init') {
    imagePath = e.data.imagePath
    isPackaged = e.data.isPackaged
    resourcesPath = e.data.resourcesPath
    cacheDir = e.data.cacheDir
    debugSamplesDir = path.join(path.dirname(imagePath), 'debug-samples')
    configureTemplateMatchingDebug({
      samplesDir: debugSamplesDir,
      enabled: DEBUG_SAMPLES
    })

    // 載入 templates
    const base = isPackaged
      ? path.join(resourcesPath, 'templates')
      : path.join(__dirname, '../../resources/templates')

    // emblemsTemplates = loadTemplates(path.join(base, 'emblems'))
    // classesTemplates = loadTemplates(path.join(base, 'classes'))
    // playOrderTemplates = loadTemplates(path.join(base, 'play_order'))
    // resultTemplates = loadTemplates(path.join(base, 'result'))
    // indicatorsTemplates = loadTemplates(path.join(base, 'indicators'))

    original = {
      classes: loadTemplates(path.join(base, 'classes')),
      emblems: loadTemplates(path.join(base, 'emblems')),
      playOrder: loadTemplates(path.join(base, 'play_order')),
      result: loadTemplates(path.join(base, 'result')),
      resultMid: loadTemplates(path.join(base, 'result_mid')),
      indicators: loadTemplates(path.join(base, 'indicators')),
      modesCPU: loadTemplates(path.join(base, 'modes_cpu')),
      modesRanked: loadTemplates(path.join(base, 'modes_ranked')),
      modes2Pick: loadTemplates(path.join(base, 'modes_2pick')),
      modesPlaza: loadTemplates(path.join(base, 'modes_plaza')),
      cursor: loadTemplates(path.join(base, 'cursor')),
      custom: loadTemplates(path.join(base, 'custom')),
      history: loadTemplates(path.join(base, 'history'))
    }

    // 啟動分析迴圈
    analyzeOnce(port)
  }

  // 如果父程序要停止 worker
  if (e.data && e.data.type === 'stop') {
    if (timer) clearTimeout(timer)
    void shutdownOcrWorker().finally(() => process.exit(0))
  }
})

async function recognizeCurrentCR(
  imgPath: string,
  anchor?: AnchorResult
): Promise<string | undefined> {
  // 檔案檢查
  if (!fs.existsSync(imgPath)) {
    console.warn('[OCR] image is not exist:', imgPath)
    return
  }
  const { size } = fs.statSync(imgPath)
  if (size === 0) {
    console.warn('[OCR] File size is zero')
    return
  }

  // 讀圖
  const mat = cv.imread(imgPath).bgrToGray()
  if (mat.empty) {
    console.warn('[OCR] Can not read pixel')
    return
  }

  const gameRect = getGameRect(mat)
  const scale = getScaleFactors(gameRect)

  // 固定解析度 ROI（會依螢幕比例縮放）
  const currentFallback = scaleRect(CURRENT_CR_BASE_RECT, scale)
  const current = rectFromModeAnchor({
    baseRect: CURRENT_CR_BASE_RECT,
    anchor,
    anchorBaseRect: RANKED_MODE_BASE_RECT,
    scale
  })
  const cursorA = rectFromModeAnchor({
    baseRect: CR_CURSOR_A_BASE_RECT,
    anchor,
    anchorBaseRect: RANKED_MODE_BASE_RECT,
    scale
  })
  const cursorB = rectFromModeAnchor({
    baseRect: CR_CURSOR_B_BASE_RECT,
    anchor,
    anchorBaseRect: RANKED_MODE_BASE_RECT,
    scale
  }) // 額外再檢一次，避免邊界案例
  const CURSOR_BLOCK_THRESHOLD = 0.6

  // 游標遮擋檢測（修正成兩塊 ROI 取最大值）
  const tmpls = prepareScaledTemplates(original, mat, gameRect).cursor
  const roiA = getRegionSafe(mat, cursorA)
  const roiB = getRegionSafe(mat, cursorB)
  const m1 = matchTemplate(roiA, tmpls, { multiScale: true })
  const m2 = matchTemplate(roiB, tmpls, { multiScale: true })
  if (Math.max(m1.score, m2.score) > CURSOR_BLOCK_THRESHOLD) {
    debugLog('[OCR] cursor block (currentCR), skip this turn')
    return '' // 讓上層略過、等待下次
  }

  // 擷取 + 二值化
  const currentCrRoi = getOcrRegionOrFallback({
    mat,
    rect: current,
    fallbackRect: currentFallback,
    label: 'currentCR'
  })
  if (!currentCrRoi) return ''
  const bin = currentCrRoi.threshold(128, 255, cv.THRESH_BINARY)
  const buf = cv.imencode('.png', bin)

  try {
    const worker = await getOcrWorker()

    const {
      data: { text }
    } = await worker.recognize(buf)

    const normalized = (text ?? '')
      .trim()
      .replace(/[＋﹢]/g, '+')
      .replace(/[－﹣]/g, '-')
      .replace(/[Oo]/g, '0')
      .replace(/\s+/g, '')

    if (normalized === '') {
      debugLog('[OCR] currentCR empty after normalize')
      return ''
    }
    if (!/^[-+]?\d+$/.test(normalized)) {
      console.warn('[OCR] currentCR invalid after normalize:', JSON.stringify(normalized))
      return '' // 視為本次無效
    }
    debugLog('[OCR] CR(current):', JSON.stringify(normalized))
    return normalized
  } catch (e) {
    console.error('[OCR] recognizeCurrentCR failed:', e)
    await resetOcrWorker()
    return ''
  }
}

async function recognizeDeltaCR(
  imgPath: string,
  anchor?: AnchorResult
): Promise<string | undefined> {
  // 檔案檢查
  if (!fs.existsSync(imgPath)) {
    console.warn('[OCR] image is not exist:', imgPath)
    return
  }
  const { size } = fs.statSync(imgPath)
  if (size === 0) {
    console.warn('[OCR] File size is zero')
    return
  }

  // 讀圖
  const mat = cv.imread(imgPath).bgrToGray()
  if (mat.empty) {
    console.warn('[OCR] Can not read pixel')
    return
  }

  // 固定解析度 ROI
  const gameRect = getGameRect(mat)
  const scale = getScaleFactors(gameRect)
  const deltaFallback = scaleRect(DELTA_CR_BASE_RECT, scale)
  const delta = rectFromModeAnchor({
    baseRect: DELTA_CR_BASE_RECT,
    anchor,
    anchorBaseRect: RANKED_MODE_BASE_RECT,
    scale
  })
  const cursorA = rectFromModeAnchor({
    baseRect: CR_CURSOR_A_BASE_RECT,
    anchor,
    anchorBaseRect: RANKED_MODE_BASE_RECT,
    scale
  })
  const cursorB = rectFromModeAnchor({
    baseRect: CR_CURSOR_B_BASE_RECT,
    anchor,
    anchorBaseRect: RANKED_MODE_BASE_RECT,
    scale
  })
  const CURSOR_BLOCK_THRESHOLD = 0.6

  // 游標遮擋檢測（兩塊 ROI 取最大值，比對 cursor 模板）
  const tmpls = prepareScaledTemplates(original, mat, gameRect).cursor
  const roiA = getRegionSafe(mat, cursorA)
  const roiB = getRegionSafe(mat, cursorB)
  const m1 = matchTemplate(roiA, tmpls, { multiScale: true })
  const m2 = matchTemplate(roiB, tmpls, { multiScale: true })
  if (Math.max(m1.score, m2.score) > CURSOR_BLOCK_THRESHOLD) {
    debugLog('[OCR] cursor block (deltaCR), skip this turn')
    return ''
  }

  // 擷取 + 二值化
  const deltaCrRoi = getOcrRegionOrFallback({
    mat,
    rect: delta,
    fallbackRect: deltaFallback,
    label: 'deltaCR'
  })
  if (!deltaCrRoi) return ''
  const bin = deltaCrRoi.threshold(128, 255, cv.THRESH_BINARY)
  const buf = cv.imencode('.png', bin)

  try {
    const worker = await getOcrWorker()

    const {
      data: { text }
    } = await worker.recognize(buf)

    const trimmed = text.trim()
    debugLog('[OCR] raw delta CR:', JSON.stringify(trimmed))

    // ---- 正規化：把回傳值整理成「純數字字串」or 判定無效 ----
    const normalized = trimmed
      .replace(/[＋﹢]/g, '+')
      .replace(/[－﹣]/g, '-')
      .replace(/O/g, '0')
      .replace(/o/g, '0')
      .trim()

    if (normalized === '') {
      debugLog('[OCR] deltaCR empty after normalize')
      return ''
    }
    if (!/^[-+]?\d+$/.test(normalized)) {
      console.warn('[OCR] invalid format after normalize:', JSON.stringify(normalized))
      return '' // 視為本次無效，讓上層跳過
    }

    // 這裡不轉 number，維持回傳字串給呼叫端做 parse（相容現有介面）
    return normalized
  } catch (e) {
    console.error('[OCR] recognizeDeltaCR failed:', e)
    await resetOcrWorker()
    return ''
  }
}

async function recognizeBPGain(
  imgPath: string,
  mode?: '2pick' | 'ranked',
  anchor?: AnchorResult
): Promise<string | undefined> {
  // 檔案檢查
  if (!fs.existsSync(imgPath)) {
    console.warn('[OCR] image is not exist:', imgPath)
    return
  }
  const { size } = fs.statSync(imgPath)
  if (size === 0) {
    console.warn('[OCR] File size is zero')
    return
  }

  // 讀圖轉灰階
  const mat = cv.imread(imgPath).bgrToGray()
  if (mat.empty) {
    console.warn('[OCR] Can not read pixel')
    return
  }

  const gameRect = getGameRect(mat)
  const scale = getScaleFactors(gameRect)

  // 固定解析度 ROI（隨螢幕尺寸縮放）
  const anchorBaseRect = mode === '2pick' ? TWO_PICK_MODE_BASE_RECT : RANKED_MODE_BASE_RECT
  const bpBaseRect = mode === '2pick' ? TWO_PICK_BP_BASE_RECT : RANKED_BP_BASE_RECT
  const bpFallbackRect = scaleRect(bpBaseRect, scale)
  const bpRect = rectFromModeAnchor({
    baseRect: bpBaseRect,
    anchor,
    anchorBaseRect,
    scale
  })

  const cursorRect = rectFromModeAnchor({
    baseRect: mode === '2pick' ? TWO_PICK_CURSOR_BASE_RECT : RANKED_CURSOR_BASE_RECT,
    anchor,
    anchorBaseRect,
    scale
  })

  // 游標遮擋檢測
  const cursorRoi = getRegionSafe(mat, cursorRect)
  const cursorMatch = matchTemplate(
    cursorRoi,
    prepareScaledTemplates(original, mat, gameRect).cursor,
    {
      multiScale: true
    }
  )
  debugLog('[OCR] cursorMatch:', cursorMatch)
  if (cursorMatch.score > 0.6) {
    debugLog('[OCR] cursor block, skip OCR, will retry...')
    return '' // 保持你原有語意：讓上層略過寫入，等待下次
  }

  // 擷取 BP ROI 並二值化
  const bpRoi = getOcrRegionOrFallback({
    mat,
    rect: bpRect,
    fallbackRect: bpFallbackRect,
    label: mode === '2pick' ? '2pickBP' : 'rankedBP'
  })
  if (!bpRoi) return ''
  // 可視化面板背景，二值化門檻可微調（120~160）視你的畫面主題
  const bin = bpRoi.threshold(128, 255, cv.THRESH_BINARY)
  const buf = cv.imencode('.png', bin)

  try {
    const worker = await getOcrWorker()

    const {
      data: { text }
    } = await worker.recognize(buf)

    const trimmed = text.trim()
    debugLog('[OCR] raw BP Gain:', JSON.stringify(trimmed))

    // ---- 正規化：把回傳值整理成「純數字字串」or 判定無效 ----
    const normalized = trimmed
      .replace(/[＋﹢]/g, '+')
      .replace(/[－﹣]/g, '-')
      .replace(/O/g, '0')
      .replace(/o/g, '0')
      .trim()

    if (normalized === '') {
      debugLog('[OCR] BP empty after normalize')
      return ''
    }
    if (!/^[-+]?\d+$/.test(normalized)) {
      console.warn('[OCR] invalid format after normalize:', JSON.stringify(normalized))
      return '' // 視為本次無效，讓上層跳過
    }

    // 這裡不轉 number，維持回傳字串給呼叫端做 parse（相容現有介面）
    return normalized
  } catch (e) {
    console.error('[OCR] recognizeBPGain failed：', e)
    await resetOcrWorker()
    return ''
  }
}

// let emblemsTemplates: { name: string; image: Mat }[] = []
// let classesTemplates: { name: string; image: Mat }[] = []
// let playOrderTemplates: { name: string; image: Mat }[] = []
// let resultTemplates: { name: string; image: Mat }[] = []
// let indicatorsTemplates: { name: string; image: Mat }[] = []

let timer: NodeJS.Timeout | null = null

/**
 * 從任意多筆 {name, score} 裡，
 * 選出分數 > threshold 的最高者，回傳它的 name；否則回 null。
 */
function pickBestResult(
  results: Array<{ name: string; score: number }>,
  threshold: number
): string | null {
  // 1. 過濾掉沒過門檻的
  const candidates = results.filter((r) => r.score > threshold)
  if (candidates.length === 0) return null

  // 2. 找出分數最高的
  const best = candidates.reduce((prev, cur) => (cur.score > prev.score ? cur : prev))

  return best.name
}

type PlayResult = {
  name: string // 'first' 或 'second'
  score: number
  side: 'own' | 'enemy'
}

/**
 * 從 ownPlayOrder 與 enemyPlayOrder 裡，
 * 選出分數最高（>threshold）的那個，
 * 並且如果它來自右邊（enemy），就把 'first'/'second' 反過來。
 */
function determinePlayOrder(
  ownPlayOrder: { name: string; score: number },
  enemyPlayOrder: { name: string; score: number },
  threshold: number
): 'first' | 'second' | null {
  // 1) 包裝 side
  const results: PlayResult[] = [
    { ...ownPlayOrder, side: 'own' },
    { ...enemyPlayOrder, side: 'enemy' }
  ]

  // 2) 過濾掉不夠準的
  const candidates = results.filter((r) => r.score > threshold)
  if (candidates.length === 0) return null

  // 3) 挑出分最高的
  const best = candidates.reduce((prev, cur) => (cur.score > prev.score ? cur : prev))

  // 4) 如果它來自 enemy，一定要把 first/second 反向
  if (best.side === 'enemy') {
    return best.name === 'first' ? 'second' : 'first'
  }
  // own side 就直接回它本身
  return best.name as 'first' | 'second'
}

/**
 * 如果所有 templates 都 matchScore > threshold，才回 true
 */
// function allMatch(
//   base: Mat,
//   templates: { name: string; image: Mat }[],
//   threshold: number
// ): boolean {
//   return templates.every((tpl) => {
//     const { score } = matchTemplate(base, [tpl])
//     return score > threshold
//   })
// }

let inBattle = false
let isMatchRecord = false

let isPlayingHistory = false
let mode: GameMode | null = null // current battle mode: 'cpu', 'ranked', or 'free'

let isModifyCurrentCR = false
let isModifyDeltaCR = false
let isModifyBP = false
let isResultMidDetect = false

let shouldModifyMode = false

let historyCooldownUntil = 0

const ACTIVE_INTERVAL = 500
const IDLE_INTERVAL = 1000
const COOLDOWN_INTERVAL = 1500
const THRESHOLD = {
  class: 0.7,
  emblem: 0.7,
  playOrder: 0.6,
  ranked: 0.6,
  result: 0.7
}

// let shouldRecordNewMatch = false

// let customBattleActive = false // whether a custom-room battle is ongoing
// let normalBattleActive = false // whether a normal battle is ongoing

// Analyzer owns this id after addMatch; follow-up OCR/mode/result writes must target it explicitly.
let activeMatchId: number | null = null

let rankDetect: scoreAndName
let twoPickDetect: scoreAndName
let cpuDetect: scoreAndName
let plazaDetect: scoreAndName
let ownCustomDetect: scoreAndName
let enemyCustomDetect: scoreAndName

// 主分析函式：一次分析完成後會自動 scheduleNext()
async function analyzeOnce(port: MessagePortMain): Promise<void> {
  const now = Date.now()

  // 如果還在歷史紀錄播放的冷卻時間內，就不做任何事情，直接排程下一次
  if (now < historyCooldownUntil) {
    // console.log(now - historyCooldownUntil)
    return scheduleNext(port)
  }

  // 檢查檔案是否存在
  if (!fs.existsSync(imagePath)) {
    console.warn('[Analyzer] imagePath not found, skipping')
    return scheduleNext(port)
  }
  const { size } = fs.statSync(imagePath)
  if (size === 0) {
    console.warn('[Analyzer] image file is zero bytes, skipping')
    return scheduleNext(port)
  }

  try {
    const img = cv.imread(imagePath)
    if (img.empty) return scheduleNext(port)
    const gray = img.bgrToGray()

    const gameRect = getGameRect(gray)
    const tmpls = prepareScaledTemplates(original, gray, gameRect)
    const scale = getScaleFactors(gameRect)

    const halfW = Math.floor(gameRect.w / 2)
    const gameArea = getRegionSafe(gray, gameRect)
    const leftArea = getRegionSafe(gray, { x: gameRect.x, y: gameRect.y, w: halfW, h: gameRect.h })
    const rightArea = getRegionSafe(gray, {
      x: gameRect.x + halfW,
      y: gameRect.y,
      w: gameRect.w - halfW,
      h: gameRect.h
    })
    const topRightArea = getRegionSafe(gray, topRightAreaRect(gameRect))

    // 歷史紀錄
    const historyDetect = matchTemplate(gameArea, tmpls.history, {
      multiScale: true,
      label: 'history',
      lowConfidenceThreshold: 0.6
    })
    if (historyDetect.score > 0.6) {
      isPlayingHistory = true
    }

    // 偵測到正在播放歷史紀錄，就設定冷卻到 15 秒後
    if (isPlayingHistory) {
      historyCooldownUntil = now + 15_000

      inBattle = false
      isMatchRecord = false
      isPlayingHistory = false
      isModifyCurrentCR = false
      isModifyDeltaCR = false
      isModifyBP = false
      shouldModifyMode = false
      mode = null
      // customBattleActive = false
      // normalBattleActive = false
      activeMatchId = null
      // shouldRecordNewMatch = false

      console.log('[Analyzer] History detected: cooling down for 15s')
      return scheduleNext(port)
    }

    // 考慮到 BP 可能被遮擋，要多次檢測，所以不能放置於底下的 shouldModifyMode 判斷式

    const rankedAnchor = detectAnchor(gray, tmpls.modesRanked, {
      searchArea: topRightAreaRect(gameRect),
      threshold: THRESHOLD.ranked,
      label: 'anchor_mode_ranked',
      multiScale: true
    })
    const twoPickAnchor = detectAnchor(gray, tmpls.modes2Pick, {
      searchArea: topRightAreaRect(gameRect),
      threshold: THRESHOLD.ranked,
      label: 'anchor_mode_2pick',
      multiScale: true
    })
    const rankRect = anchorAwareRect({
      baseRect: RANKED_MODE_BASE_RECT,
      anchor: rankedAnchor,
      expectedAnchorBase: RANKED_MODE_BASE_RECT,
      scale
    })
    const twoPickRect = anchorAwareRect({
      baseRect: TWO_PICK_MODE_BASE_RECT,
      anchor: twoPickAnchor,
      expectedAnchorBase: TWO_PICK_MODE_BASE_RECT,
      scale
    })

    rankDetect = matchTemplate(getRegionSafe(gray, rankRect), tmpls.modesRanked, {
      multiScale: true,
      label: 'mode_ranked',
      lowConfidenceThreshold: THRESHOLD.ranked
    })
    twoPickDetect = matchTemplate(getRegionSafe(gray, twoPickRect), tmpls.modes2Pick, {
      multiScale: true,
      label: 'mode_2pick',
      lowConfidenceThreshold: THRESHOLD.ranked
    })

    debugLog('gameRect: ', gameRect)
    debugLog('sx: ', scale.scaleX)
    debugLog('sy: ', scale.scaleY)
    debugLog('rank: ', rankDetect)
    debugLog('twoPick: ', twoPickDetect)

    if (twoPickDetect.score > THRESHOLD.ranked) {
      // 2Pick模式判斷：BP修改
      // 因為 2Pick 應該帶入對應的 2Pick 牌組
      if (activeMatchId !== null) await clearMyDeck(activeMatchId)
      if (!isModifyBP && activeMatchId !== null) {
        debugLog(twoPickDetect)

        const raw = await recognizeBPGain(imagePath, '2pick', twoPickAnchor) // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') debugLog('[analyzeOnce] OCR got empty string')
        if (raw === undefined) debugLog('[analyzeOnce] OCR undefined')

        const bp = parseBPGain(raw)
        debugLog('[2Pick] parsed bp =', bp)

        if (bp !== null) {
          await modifyMatchBP(bp, activeMatchId) // 0 會被寫入
          port.postMessage({ type: 'modifyMode' })
          isModifyBP = true
        }
      }

      // 2Pick模式判斷：模式修改
      if (shouldModifyMode && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'twoPick'
        modifyMatchMode(mode, activeMatchId).then(() => {
          port.postMessage({ type: 'modifyMode' })
        })
        debugLog(twoPickDetect)
      }
    } else if (rankDetect.score > THRESHOLD.ranked) {
      if (!isModifyDeltaCR && activeMatchId !== null) {
        const raw = await recognizeDeltaCR(imagePath, rankedAnchor) // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') debugLog('[analyzeOnce] OCR got empty string')
        if (raw === undefined) debugLog('[analyzeOnce] OCR undefined')

        const deltaCR = parseBPGain(raw)
        debugLog('[ranked] parsed deltaCR =', deltaCR)

        if (deltaCR !== null) {
          await modifyMatchDeltaCR(deltaCR, activeMatchId).then(() => {
            port.postMessage({ type: 'modifyMode' })
          })
          isModifyDeltaCR = true
        }
      }

      if (!isModifyCurrentCR && activeMatchId !== null) {
        const raw = await recognizeCurrentCR(imagePath, rankedAnchor) // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') debugLog('[analyzeOnce] OCR got empty string')
        if (raw === undefined) debugLog('[analyzeOnce] OCR undefined')

        const currentCR = parseBPGain(raw)
        debugLog('[ranked] parsed currentCR =', currentCR)

        if (currentCR !== null) {
          await modifyMatchCurrentCR(currentCR, activeMatchId).then(() => {
            port.postMessage({ type: 'modifyMode' })
          })
          isModifyCurrentCR = true
        }
      }

      // 階級模式判斷：BP修改
      if (!isModifyBP && activeMatchId !== null) {
        debugLog(rankDetect)

        const raw = await recognizeBPGain(imagePath, 'ranked', rankedAnchor) // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') debugLog('[analyzeOnce] OCR got empty string')
        if (raw === undefined) debugLog('[analyzeOnce] OCR undefined')

        const bp = parseBPGain(raw)
        debugLog('[ranked] parsed bp =', bp)

        if (bp !== null) {
          await modifyMatchBP(bp, activeMatchId).then(() => {
            port.postMessage({ type: 'modifyMode' })
          })
          isModifyBP = true
        }
      }

      // 階級模式判斷：模式修改
      if (shouldModifyMode && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'ranked'
        await modifyMatchMode(mode, activeMatchId).then(() => {
          port.postMessage({ type: 'modifyMode' })
        })
        debugLog(mode)
      }
    }

    if (shouldModifyMode) {
      // 練習模式：模板配對
      cpuDetect = matchTemplate(topRightArea, tmpls.modesCPU, {
        multiScale: true,
        label: 'mode_cpu',
        lowConfidenceThreshold: 0.7
      })

      // 練習模式判斷：模式修改
      if (cpuDetect.score > 0.7 && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'cpu'
        await modifyMatchMode(mode, activeMatchId).then(() => {
          port.postMessage({ type: 'modifyMode' })
        })
        debugLog(cpuDetect)
      }

      // 廣場賽模式：模板配對
      plazaDetect = matchTemplate(topRightArea, tmpls.modesPlaza, {
        multiScale: true,
        label: 'mode_plaza',
        lowConfidenceThreshold: 0.7
      })

      // 廣場賽模式判斷：模式修改
      if (plazaDetect.score > 0.7 && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'weekendPlaza'
        await modifyMatchMode(mode, activeMatchId).then(() => {
          port.postMessage({ type: 'modifyMode' })
        })
      }

      // 自訂房檢測 (室長 / 訪客)
      // 檢測到房間這個事件(檢測到房間，但是沒有開始對戰，而是解散出來打別的模式)
      // 辨別的節點為，是否有偵測到win/lose
      // TODO:尚未完成！

      ownCustomDetect = matchTemplate(leftArea, tmpls.custom, {
        multiScale: true,
        label: 'custom_own',
        lowConfidenceThreshold: 0.7
      })
      enemyCustomDetect = matchTemplate(rightArea, tmpls.custom, {
        multiScale: true,
        label: 'custom_enemy',
        lowConfidenceThreshold: 0.7
      })

      const rs = pickBestResult([ownCustomDetect, enemyCustomDetect], 0.7)
      if (rs && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'custom'
        await modifyMatchMode(mode, activeMatchId).then(() => {
          port.postMessage({ type: 'modifyMode' })
        })
      }
    }
    // if (ownCustomWinDetect.score > 0.7) {
    //   console.log('ownCustomWin', ownCustomWinDetect)
    // }
    // if (enemyCustomWinDetect.score > 0.7) {
    //   console.log('enemyCustomWin', enemyCustomWinDetect)
    // }

    // const roomDetect = matchTemplate(gray, tmpls.custom)
    // if (
    //   roomDetect.score > THRESHOLD.ranked &&
    //   (roomDetect.name === 'host' || roomDetect.name === 'guest')
    // ) {
    //   // Detected custom-room indicator
    //   if (!customBattleActive) {
    //     // start custom battle
    //     customBattleActive = true
    //     normalBattleActive = false
    //     // port.postMessage({ type: 'inBattle', data: { custom: true } })
    //   } else {
    //     // end custom battle
    //     customBattleActive = false
    //     // port.postMessage({ type: 'matchResult', data: { custom: true } })
    //   }
    //   return scheduleNext(port)
    // }

    // 職業名稱、職業紋章、先/後攻檢測
    const ownClass = matchTemplate(leftArea, tmpls.classes, {
      multiScale: true,
      label: 'class_own',
      lowConfidenceThreshold: THRESHOLD.class
    })
    const enemyClass = matchTemplate(rightArea, tmpls.classes, {
      multiScale: true,
      label: 'class_enemy',
      lowConfidenceThreshold: THRESHOLD.class
    })
    const ownEmblem = matchTemplate(leftArea, tmpls.emblems, {
      multiScale: true,
      label: 'emblem_own',
      lowConfidenceThreshold: THRESHOLD.emblem
    })
    const enemyEmblem = matchTemplate(rightArea, tmpls.emblems, {
      multiScale: true,
      label: 'emblem_enemy',
      lowConfidenceThreshold: THRESHOLD.emblem
    })
    const ownPlayOrder = matchTemplate(leftArea, tmpls.playOrder, {
      multiScale: true,
      label: 'play_order_own',
      lowConfidenceThreshold: THRESHOLD.playOrder
    })
    const enemyPlayOrder = matchTemplate(rightArea, tmpls.playOrder, {
      multiScale: true,
      label: 'play_order_enemy',
      lowConfidenceThreshold: THRESHOLD.playOrder
    })

    // 戰鬥邏輯檢查
    const myValid = ownClass.score > THRESHOLD.class || ownEmblem.score > THRESHOLD.emblem
    const oppoValid = enemyClass.score > THRESHOLD.class || enemyEmblem.score > THRESHOLD.emblem
    const turnValid =
      ownPlayOrder.score > THRESHOLD.playOrder || enemyPlayOrder.score > THRESHOLD.playOrder

    if (!isMatchRecord) {
      inBattle = myValid && oppoValid && turnValid
    }

    // 處理對戰無結束的判斷節點，導致無法開始記錄下一把
    // if (isMatchRecord && !inBattle) {
    //   shouldRecordNewMatch = true
    // }

    // 戰鬥開始：首次紀錄 DB
    // if ((inBattle && !isMatchRecord) || (shouldRecordNewMatch && inBattle)) {
    if (inBattle && !isMatchRecord) {
      isMatchRecord = true

      // If the previous active match did not get a concrete mode, mark it as unranked before
      // taking ownership of the new battle.
      if (activeMatchId !== null) {
        if (mode !== null) {
          mode = null
        } else {
          if (shouldModifyMode) {
            mode = 'unranked'
            modifyMatchMode('unranked', activeMatchId).then(() => {
              port.postMessage({ type: 'modifyMode' })
            })
          }
        }
      }

      isModifyBP = false
      isModifyCurrentCR = false
      isModifyDeltaCR = false
      shouldModifyMode = true

      isResultMidDetect = false
      // shouldRecordNewMatch = false

      debugLog('----- In Battle! -----')
      debugLog('ownClass', ownClass)
      debugLog('ownEmblem', ownEmblem)
      debugLog('enemyClass', enemyClass)
      debugLog('enemyEmblem', enemyEmblem)
      debugLog('ownPlayOrder', ownPlayOrder)
      debugLog('enemyPlayOrder', enemyPlayOrder)
      const ownName = pickBestResult([ownClass, ownEmblem], THRESHOLD.class)
      const oppoName = pickBestResult([enemyClass, enemyEmblem], THRESHOLD.class)
      const order = determinePlayOrder(ownPlayOrder, enemyPlayOrder, THRESHOLD.playOrder)

      if (!ownName) {
        throw new Error('無法辨識我方職業')
      }
      if (!oppoName) {
        throw new Error('無法辨識對方職業')
      }
      if (!order) {
        throw new Error('無法辨識先後攻')
      }

      const created = await addMatch(
        ownName as ClassName,
        oppoName as ClassName,
        order as PlayOrder
      )
      activeMatchId = created.id
      debugLog('activeMatchId', activeMatchId)

      // 通知前端「進入戰鬥」
      port.postMessage({
        type: 'inBattle',
        data: { ownClass: ownName, enemyClass: oppoName, playOrder: order, inBattle: true }
      })
    }

    // 勝/敗結果檢測
    const resultMidDetect = detectAnchor(gameArea, tmpls.resultMid, {
      threshold: 0.3,
      label: 'result_mid',
      multiScale: true
    })

    // 戰鬥結束：識別勝敗並更新 DB
    if (isMatchRecord && resultMidDetect.score > 0.3) {
      debugLog('----- Battle Finished -----')
      debugLog('resultMidDetect', resultMidDetect)
      isMatchRecord = false
      inBattle = false
      isResultMidDetect = true

      const result = resultMidDetect.name === 'win'
      await modifyMatchResult(result, activeMatchId ?? undefined).then(() => {
        activeMatchId = null
        port.postMessage({
          type: 'matchResult',
          data: { ownClass: null, enemyClass: null, playOrder: null, inBattle: false }
          // notification: {
          //   title: `[${mode}]對戰結果已紀錄`,
          //   body: win ? '勝利！' : '戰敗...'
          // }
        })
      })
    }

    const resultDetect = detectAnchor(gameArea, tmpls.result, {
      threshold: THRESHOLD.result,
      label: 'result',
      multiScale: true
    })
    if (
      (isMatchRecord && resultDetect.score > THRESHOLD.result) ||
      (!isMatchRecord && isResultMidDetect && resultDetect.score > THRESHOLD.result)
    ) {
      debugLog('----- Battle Finished -----')
      debugLog('resultDetect', resultDetect)
      isMatchRecord = false
      isResultMidDetect = false
      inBattle = false

      const result = resultDetect.name === 'win'
      await modifyMatchResult(result, activeMatchId ?? undefined).then(() => {
        activeMatchId = null
        port.postMessage({
          type: 'matchResult',
          data: { ownClass: null, enemyClass: null, playOrder: null, inBattle: false }
          // notification: {
          //   title: `[${mode}]對戰結果已紀錄`,
          //   body: win ? '勝利！' : '戰敗...'
          // }
        })
      })
    }
  } catch (err: unknown) {
    console.error('[Analyzer] Error in analyzeOnce:', err)
  } finally {
    scheduleNext(port)
  }
}

// schedule 下一次分析
function scheduleNext(port: MessagePortMain): void {
  const delay =
    Date.now() < historyCooldownUntil
      ? COOLDOWN_INTERVAL
      : inBattle || isMatchRecord || shouldModifyMode
        ? ACTIVE_INTERVAL
        : IDLE_INTERVAL
  timer = setTimeout(() => analyzeOnce(port), delay)
}

function parseBPGain(raw: string | undefined | null): number | null {
  if (raw == null) return null

  const s = raw
    .trim()
    .replace(/[＋﹢]/g, '+') // 全形＋
    .replace(/[－﹣]/g, '-') // 全形－
    .replace(/O/g, '0') // 大寫 O → 0（依你資料可調整）
    .replace(/o/g, '0')

  // 僅接受 [+|-] 整數（避免雜訊）
  const ok = /^[-+]?\d+$/.test(s)
  if (!ok) return null

  const n = parseInt(s, 10)
  return Number.isNaN(n) ? null : n
}
