/* eslint-disable prefer-const */
import { type MessagePortMain } from 'electron'
import fs from 'fs'
import path from 'path'
import cv, { Mat } from '@u4/opencv4nodejs'
import { createWorker, OEM, PSM } from 'tesseract.js'
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

type scoreAndName = {
  score: number
  name: string
}

const BASE_WIDTH = 1280
const BASE_HEIGHT = 720

/**
 * The capture tool can produce different resolutions depending on the player's
 * display and game settings. All template ROIs are authored for 1280×720, so
 * normalize every frame before matching or OCR.
 */
function normalizeGray(mat: Mat): Mat {
  return mat.cols === BASE_WIDTH && mat.rows === BASE_HEIGHT
    ? mat
    : mat.resize(BASE_HEIGHT, BASE_WIDTH, 0, 0, cv.INTER_LINEAR)
}

function loadNormalizedGray(imgPath: string): Mat | undefined {
  const mat = cv.imread(imgPath).bgrToGray()
  if (mat.empty) return undefined
  return normalizeGray(mat)
}

let original: {
  classes: Array<{ name: string; image: Mat }>
  emblems: Array<{ name: string; image: Mat }>
  playOrder: Array<{ name: string; image: Mat }>
  result: Array<{ name: string; image: Mat }>
  resultMid: Array<{ name: string; image: Mat }>
  indicators: Array<{ name: string; image: Mat }>
  modesCPU: Array<{ name: string; image: Mat }>
  modesRanked: Array<{ name: string; image: Mat }>
  modes2Pick: Array<{ name: string; image: Mat }>
  modesPlaza: Array<{ name: string; image: Mat }>
  cursor: Array<{ name: string; image: Mat }>
  custom: Array<{ name: string; image: Mat }>
  history: Array<{ name: string; image: Mat }>
}

let imagePath = ''
let isPackaged = false
let resourcesPath = ''
let cacheDir = ''

// 處理父程序訊息
process.parentPort.on('message', (e) => {
  const [port] = e.ports
  // 第一個訊息：帶入初始化參數
  if (e.data && e.data.type === 'init') {
    imagePath = e.data.imagePath
    isPackaged = e.data.isPackaged
    resourcesPath = e.data.resourcesPath
    cacheDir = path.join(resourcesPath, 'cacheDir')

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
    process.exit(0)
  }
})

async function recognizeCurrentCR(imgPath: string): Promise<string | undefined> {
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
  const mat = loadNormalizedGray(imgPath)
  if (!mat) {
    console.warn('[OCR] Can not read pixel')
    return
  }

  // 固定解析度 ROI
  const current = { x: 1160, y: 365, w: 75, h: 35 }
  const cursorA = { x: 1055, y: 315, w: 210, h: 135 }
  const cursorB = { x: 1060, y: 280, w: 210, h: 135 } // 額外再檢一次，避免邊界案例
  const CURSOR_BLOCK_THRESHOLD = 0.6

  // 游標遮擋檢測（修正成兩塊 ROI 取最大值）
  const tmpls = prepareScaledTemplates(mat).cursor
  const roiA = mat.getRegion(new cv.Rect(cursorA.x, cursorA.y, cursorA.w, cursorA.h))
  const roiB = mat.getRegion(new cv.Rect(cursorB.x, cursorB.y, cursorB.w, cursorB.h))
  const m1 = matchTemplate(roiA, tmpls)
  const m2 = matchTemplate(roiB, tmpls)
  if (Math.max(m1.score, m2.score) > CURSOR_BLOCK_THRESHOLD) {
    console.log('[OCR] cursor block (currentCR), skip this turn')
    return '' // 讓上層略過、等待下次
  }

  // 擷取 + 二值化
  const currentCrRoi = mat.getRegion(new cv.Rect(current.x, current.y, current.w, current.h))
  const bin = currentCrRoi.threshold(128, 255, cv.THRESH_BINARY)
  const buf = cv.imencode('.png', bin)

  try {
    const worker = await createWorker(['eng'], OEM.DEFAULT, {
      cachePath: cacheDir,
      langPath: isPackaged ? path.join(resourcesPath, 'tessdata') : path.join(__dirname, '../../')
    })
    await worker.setParameters({
      tessedit_char_whitelist: '+-0123456789',
      tessedit_pageseg_mode: PSM.SINGLE_LINE
    })

    const {
      data: { text }
    } = await worker.recognize(buf)
    await worker.terminate()

    const normalized = (text ?? '')
      .trim()
      .replace(/[＋﹢]/g, '+')
      .replace(/[－﹣]/g, '-')
      .replace(/[Oo]/g, '0')
      .replace(/\s+/g, '')

    if (!/^[-+]?\d+$/.test(normalized)) {
      console.warn('[OCR] currentCR invalid after normalize:', JSON.stringify(normalized))
      return '' // 視為本次無效
    }
    console.log('[OCR] CR(current):', JSON.stringify(normalized))
    return normalized
  } catch (e) {
    console.error('[OCR] recognizeCurrentCR failed:', e)
    return ''
  }
}

async function recognizeDeltaCR(imgPath: string): Promise<string | undefined> {
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
  const mat = loadNormalizedGray(imgPath)
  if (!mat) {
    console.warn('[OCR] Can not read pixel')
    return
  }

  // 固定解析度 ROI
  const delta = { x: 1170, y: 335, w: 50, h: 25 }
  const cursorA = { x: 1055, y: 315, w: 210, h: 135 }
  const cursorB = { x: 1060, y: 280, w: 210, h: 135 }
  const CURSOR_BLOCK_THRESHOLD = 0.6

  // 游標遮擋檢測（兩塊 ROI 取最大值，比對 cursor 模板）
  const tmpls = prepareScaledTemplates(mat).cursor
  const roiA = mat.getRegion(new cv.Rect(cursorA.x, cursorA.y, cursorA.w, cursorA.h))
  const roiB = mat.getRegion(new cv.Rect(cursorB.x, cursorB.y, cursorB.w, cursorB.h))
  const m1 = matchTemplate(roiA, tmpls)
  const m2 = matchTemplate(roiB, tmpls)
  if (Math.max(m1.score, m2.score) > CURSOR_BLOCK_THRESHOLD) {
    console.log('[OCR] cursor block (deltaCR), skip this turn')
    return ''
  }

  // 擷取 + 二值化
  const deltaCrRoi = mat.getRegion(new cv.Rect(delta.x, delta.y, delta.w, delta.h))
  const bin = deltaCrRoi.threshold(128, 255, cv.THRESH_BINARY)
  const buf = cv.imencode('.png', bin)

  try {
    const worker = await createWorker(['eng'], OEM.DEFAULT, {
      cachePath: cacheDir,
      langPath: isPackaged ? path.join(resourcesPath, 'tessdata') : path.join(__dirname, '../../')
    })
    await worker.setParameters({
      tessedit_char_whitelist: '+-0123456789',
      tessedit_pageseg_mode: PSM.SINGLE_LINE
    })

    const {
      data: { text }
    } = await worker.recognize(buf)

    await worker.terminate()

    const trimmed = text.trim()
    console.log('[OCR] raw delta CR:', JSON.stringify(trimmed))

    // ---- 正規化：把回傳值整理成「純數字字串」or 判定無效 ----
    const normalized = trimmed
      .replace(/[＋﹢]/g, '+')
      .replace(/[－﹣]/g, '-')
      .replace(/O/g, '0')
      .replace(/o/g, '0')
      .trim()

    if (!/^[-+]?\d+$/.test(normalized)) {
      console.warn('[OCR] invalid format after normalize:', JSON.stringify(normalized))
      return '' // 視為本次無效，讓上層跳過
    }

    // 這裡不轉 number，維持回傳字串給呼叫端做 parse（相容現有介面）
    return normalized
  } catch (e) {
    console.error('[OCR] recognizeDeltaCR failed:', e)
    return ''
  }
}

async function recognizeBPGain(
  imgPath: string,
  mode?: '2pick' | 'ranked'
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
  const mat = loadNormalizedGray(imgPath)
  if (!mat) {
    console.warn('[OCR] Can not read pixel')
    return
  }

  // 固定解析度 ROI（如需通用化，可恢復自動縮放版本）
  let x: number, y: number, w: number, h: number
  let cursor_roi_x: number, cursor_roi_y: number, cursor_roi_w: number, cursor_roi_h: number

  x = 1115
  y = mode === '2pick' ? 295 : 200
  w = 65
  h = 30

  cursor_roi_x = 1010
  cursor_roi_y = mode === '2pick' ? 245 : 150
  cursor_roi_w = 210
  cursor_roi_h = 135

  // 游標遮擋檢測
  const cursorRoi = mat.getRegion(
    new cv.Rect(cursor_roi_x, cursor_roi_y, cursor_roi_w, cursor_roi_h)
  )
  const cursorMatch = matchTemplate(cursorRoi, prepareScaledTemplates(mat).cursor)
  console.log('[OCR] cursorMatch:', cursorMatch)
  if (cursorMatch.score > 0.6) {
    console.log('[OCR] cursor block, skip OCR, will retry...')
    return '' // 保持你原有語意：讓上層略過寫入，等待下次
  }

  // 擷取 BP ROI 並二值化
  const bpRoi = mat.getRegion(new cv.Rect(x, y, w, h))
  // 可視化面板背景，二值化門檻可微調（120~160）視你的畫面主題
  const bin = bpRoi.threshold(128, 255, cv.THRESH_BINARY)
  const buf = cv.imencode('.png', bin)

  try {
    const worker = await createWorker(['eng'], OEM.DEFAULT, {
      cachePath: cacheDir,
      langPath: isPackaged ? path.join(resourcesPath, 'tessdata') : path.join(__dirname, '../../')
    })

    await worker.setParameters({
      tessedit_char_whitelist: '+-0123456789',
      tessedit_pageseg_mode: PSM.SINGLE_LINE
    })

    const {
      data: { text }
    } = await worker.recognize(buf)

    await worker.terminate()

    const trimmed = text.trim()
    console.log('[OCR] raw BP Gain:', JSON.stringify(trimmed))

    // ---- 正規化：把回傳值整理成「純數字字串」or 判定無效 ----
    const normalized = trimmed
      .replace(/[＋﹢]/g, '+')
      .replace(/[－﹣]/g, '-')
      .replace(/O/g, '0')
      .replace(/o/g, '0')
      .trim()

    if (!/^[-+]?\d+$/.test(normalized)) {
      console.warn('[OCR] invalid format after normalize:', JSON.stringify(normalized))
      return '' // 視為本次無效，讓上層跳過
    }

    // 這裡不轉 number，維持回傳字串給呼叫端做 parse（相容現有介面）
    return normalized
  } catch (e) {
    console.error('[OCR] recognizeBPGain failed：', e)
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

let scaled: ScaledTemplates | null = null

type Template = {
  name: string
  image: Mat
}

// 這是 scaled 物件裡面各組 template 的集合
interface ScaledTemplates {
  classes: Template[]
  emblems: Template[]
  playOrder: Template[]
  result: Template[]
  resultMid: Template[]
  indicators: Template[]
  modesCPU: Template[]
  modesRanked: Template[]
  modes2Pick: Template[]
  modesPlaza: Template[]
  cursor: Template[]
  custom: Template[]
  history: Template[]
}

// Every screenshot is normalized by normalizeGray(), so templates stay at their
// authored size and only need to be loaded once.
function prepareScaledTemplates(_fullGray: Mat): ScaledTemplates {
  if (scaled) return scaled
  scaled = original
  return scaled
}

// 工具：載入 templates 資料夾下所有 .png
function loadTemplates(dir: string): {
  name: string
  image: Mat
}[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((file) => ({
      // name: path.basename(file, '.png').split('-')[0], // 舊版：模板名稱含有 -
      name: path.basename(file, '.png'),
      image: cv.imread(path.join(dir, file)).bgrToGray()
    }))
}

// 工具：對 base 圖做 template matching
function matchTemplate(
  base: Mat,
  templates: { name: string; image: Mat }[]
): { name: string; score: number } {
  let best = { name: '', score: -1 }
  for (const { name, image: tpl } of templates) {
    const result = base.matchTemplate(tpl, cv.TM_CCOEFF_NORMED)
    const { maxVal } = result.minMaxLoc()
    if (maxVal > best.score) best = { name, score: maxVal }
  }
  return best
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

const INTERVAL = 500
const THRESHOLD = {
  class: 0.7,
  emblem: 0.7,
  playOrder: 0.6,
  ranked: 0.7,
  result: 0.7
}

// let shouldRecordNewMatch = false

// let customBattleActive = false // whether a custom-room battle is ongoing
// let normalBattleActive = false // whether a normal battle is ongoing

// The active match is the only record that the analyzer may update.
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
    const gray = normalizeGray(img.bgrToGray())

    const cols = gray.cols
    const rows = gray.rows

    const tmpls = prepareScaledTemplates(gray)

    const halfW = Math.floor(cols / 2)
    const halfH = Math.floor(rows / 2)
    const leftArea = gray.getRegion(new cv.Rect(0, 0, halfW, rows))
    const rightArea = gray.getRegion(new cv.Rect(halfW, 0, cols - halfW, rows))
    const topRightArea = gray.getRegion(new cv.Rect(halfW, 0, cols - halfW, halfH))

    const rankDetectArea = gray.getRegion(new cv.Rect(780, 205, 150, 60))
    const twoPickDetectArea = gray.getRegion(new cv.Rect(780, 295, 180, 50))

    // 歷史紀錄
    const historyDetect = matchTemplate(gray, tmpls.history)
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

    // 階級模式：模板配對
    rankDetect = matchTemplate(rankDetectArea, tmpls.modesRanked)

    // 2Pick模式判斷：模板配對
    twoPickDetect = matchTemplate(twoPickDetectArea, tmpls.modes2Pick)

    if (twoPickDetect.score > THRESHOLD.ranked) {
      // 2Pick模式判斷：BP修改
      // 因為 2Pick 應該帶入對應的 2Pick 牌組
      if (activeMatchId !== null) await clearMyDeck(activeMatchId)
      if (!isModifyBP && activeMatchId !== null) {
        console.log(twoPickDetect)

        const raw = await recognizeBPGain(imagePath, '2pick') // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') console.log('[analyzeOnce] OCR got empty string')
        if (raw === undefined) console.log('[analyzeOnce] OCR undefined')

        const bp = parseBPGain(raw)
        console.log('[2Pick] parsed bp =', bp)

        if (bp !== null) {
          await modifyMatchBP(activeMatchId, bp) // 0 會被寫入
          port.postMessage({ type: 'modifyMode' })
          isModifyBP = true
        }
      }

      // 2Pick模式判斷：模式修改
      if (shouldModifyMode && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'twoPick'
        await modifyMatchMode(activeMatchId, mode)
        port.postMessage({ type: 'modifyMode' })
        console.log(twoPickDetect)
      }
    } else if (rankDetect.score > THRESHOLD.ranked) {
      if (!isModifyDeltaCR && activeMatchId !== null) {
        const raw = await recognizeDeltaCR(imagePath) // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') console.log('[analyzeOnce] OCR got empty string')
        if (raw === undefined) console.log('[analyzeOnce] OCR undefined')

        const deltaCR = parseBPGain(raw)
        console.log('[ranked] parsed deltaCR =', deltaCR)

        if (deltaCR !== null) {
          await modifyMatchDeltaCR(activeMatchId, deltaCR)
          port.postMessage({ type: 'modifyMode' })
          isModifyDeltaCR = true
        }
      }

      if (!isModifyCurrentCR && activeMatchId !== null) {
        const raw = await recognizeCurrentCR(imagePath) // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') console.log('[analyzeOnce] OCR got empty string')
        if (raw === undefined) console.log('[analyzeOnce] OCR undefined')

        const currentCR = parseBPGain(raw)
        console.log('[ranked] parsed currentCR =', currentCR)

        if (currentCR !== null) {
          await modifyMatchCurrentCR(activeMatchId, currentCR)
          port.postMessage({ type: 'modifyMode' })
          isModifyCurrentCR = true
        }
      }

      // 階級模式判斷：BP修改
      if (!isModifyBP && activeMatchId !== null) {
        console.log(rankDetect)

        const raw = await recognizeBPGain(imagePath) // 可能回 "+22" / "-15" / "0" / "" / undefined
        if (raw === '') console.log('[analyzeOnce] OCR got empty string')
        if (raw === undefined) console.log('[analyzeOnce] OCR undefined')

        const bp = parseBPGain(raw)
        console.log('[ranked] parsed bp =', bp)

        if (bp !== null) {
          await modifyMatchBP(activeMatchId, bp)
          port.postMessage({ type: 'modifyMode' })
          isModifyBP = true
        }
      }

      // 階級模式判斷：模式修改
      if (shouldModifyMode && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'ranked'
        await modifyMatchMode(activeMatchId, mode)
        port.postMessage({ type: 'modifyMode' })
        console.log(mode)
      }
    }

    if (shouldModifyMode) {
      // 練習模式：模板配對
      cpuDetect = matchTemplate(topRightArea, tmpls.modesCPU)

      // 練習模式判斷：模式修改
      if (cpuDetect.score > 0.7 && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'cpu'
        await modifyMatchMode(activeMatchId, mode)
        port.postMessage({ type: 'modifyMode' })
        console.log(cpuDetect)
      }

      // 廣場賽模式：模板配對
      plazaDetect = matchTemplate(topRightArea, tmpls.modesPlaza)

      // 廣場賽模式判斷：模式修改
      if (plazaDetect.score > 0.7 && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'weekendPlaza'
        await modifyMatchMode(activeMatchId, mode)
        port.postMessage({ type: 'modifyMode' })
      }

      // 自訂房檢測 (室長 / 訪客)
      // 檢測到房間這個事件(檢測到房間，但是沒有開始對戰，而是解散出來打別的模式)
      // 辨別的節點為，是否有偵測到win/lose
      // TODO:尚未完成！

      ownCustomDetect = matchTemplate(leftArea, tmpls.custom)
      enemyCustomDetect = matchTemplate(rightArea, tmpls.custom)

      const rs = pickBestResult([ownCustomDetect, enemyCustomDetect], 0.7)
      if (rs && activeMatchId !== null) {
        shouldModifyMode = false
        mode = 'custom'
        await modifyMatchMode(activeMatchId, mode)
        port.postMessage({ type: 'modifyMode' })
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
    const ownClass = matchTemplate(leftArea, tmpls.classes)
    const enemyClass = matchTemplate(rightArea, tmpls.classes)
    const ownEmblem = matchTemplate(leftArea, tmpls.emblems)
    const enemyEmblem = matchTemplate(rightArea, tmpls.emblems)
    const ownPlayOrder = matchTemplate(leftArea, tmpls.playOrder)
    const enemyPlayOrder = matchTemplate(rightArea, tmpls.playOrder)

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
      console.log('----- In Battle! -----')
      console.log('ownClass', ownClass)
      console.log('ownEmblem', ownEmblem)
      console.log('enemyClass', enemyClass)
      console.log('enemyEmblem', enemyEmblem)
      console.log('ownPlayOrder', ownPlayOrder)
      console.log('enemyPlayOrder', enemyPlayOrder)
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

      const record = await addMatch(ownName as ClassName, oppoName as ClassName, order as PlayOrder)
      activeMatchId = record.id
      isMatchRecord = true
      isModifyBP = false
      isModifyCurrentCR = false
      isModifyDeltaCR = false
      shouldModifyMode = true
      isResultMidDetect = false
      mode = null
      console.log('activeMatchId', activeMatchId)

      // 通知前端「進入戰鬥」
      port.postMessage({
        type: 'inBattle',
        data: { ownClass: ownName, enemyClass: oppoName, playOrder: order, inBattle: true }
      })
    }

    // 勝/敗結果檢測
    const resultMidDetect = matchTemplate(gray, tmpls.resultMid)

    // 戰鬥結束：識別勝敗並更新 DB
    if (isMatchRecord && activeMatchId !== null && resultMidDetect.score > 0.3) {
      console.log('----- Battle Finished -----')
      console.log('resultMidDetect', resultMidDetect)
      isMatchRecord = false
      inBattle = false
      isResultMidDetect = true

      const result = resultMidDetect.name === 'win'
      await recordMatchResult(port, activeMatchId, result)
    }

    const resultDetect = matchTemplate(gray, tmpls.result)
    if (
      activeMatchId !== null &&
      ((isMatchRecord && resultDetect.score > THRESHOLD.result) ||
        (!isMatchRecord && isResultMidDetect && resultDetect.score > THRESHOLD.result))
    ) {
      console.log('----- Battle Finished -----')
      console.log('resultDetect', resultDetect)
      isMatchRecord = false
      isResultMidDetect = false
      inBattle = false

      const matchId = activeMatchId
      const result = resultDetect.name === 'win'
      await recordMatchResult(port, matchId, result)
      activeMatchId = null
    }
  } catch (err: unknown) {
    console.error('[Analyzer] Error in analyzeOnce:', err)
  } finally {
    scheduleNext(port)
  }
}

// schedule 下一次分析
function scheduleNext(port: MessagePortMain): void {
  timer = setTimeout(() => analyzeOnce(port), INTERVAL)
}

async function recordMatchResult(
  port: MessagePortMain,
  matchId: number,
  result: boolean
): Promise<void> {
  // A battle without a detected mode is a normal unranked match. Set this at
  // the end of the same match rather than waiting for the next battle to begin.
  if (mode === null) {
    mode = 'unranked'
    await modifyMatchMode(matchId, mode)
  }

  await modifyMatchResult(matchId, result)
  port.postMessage({
    type: 'matchResult',
    data: { ownClass: null, enemyClass: null, playOrder: null, inBattle: false }
  })
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
