import { type MessagePortMain } from 'electron'
import fs from 'fs'
import path from 'path'
import cv, { Mat } from '@u4/opencv4nodejs'
import Tesseract from 'tesseract.js'
import {
  addMatch,
  fetchLastMatch,
  modifyMatchBP,
  modifyMatchMode,
  modifyMatchResult
} from './database'
import { ClassName, GameMode, PlayOrder } from '@prisma/client'

const BASE_WIDTH = 1280
const BASE_HEIGHT = 720

let original: {
  classes: Array<{ name: string; image: Mat }>
  emblems: Array<{ name: string; image: Mat }>
  playOrder: Array<{ name: string; image: Mat }>
  result: Array<{ name: string; image: Mat }>
  indicators: Array<{ name: string; image: Mat }>
  modesCPU: Array<{ name: string; image: Mat }>
  modesRanked: Array<{ name: string; image: Mat }>
  cursor: Array<{ name: string; image: Mat }>
  custom: Array<{ name: string; image: Mat }>
<<<<<<< HEAD
  customWin: Array<{ name: string; image: Mat }>
=======
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
}

async function recognizeBPGain(imgPath: string): Promise<string | undefined> {
  // 1. 先檢查檔案
  if (!fs.existsSync(imgPath)) {
    console.warn('[OCR] 圖檔不存在:', imgPath)
    return
  }
  const { size } = fs.statSync(imgPath)
  if (size === 0) {
    console.warn('[OCR] 圖檔大小為 0，跳過')
    return
  }

  // 2. 讀圖並轉灰階
  const mat = cv.imread(imgPath).bgrToGray()
  if (mat.empty) {
    console.warn('[OCR] 讀不到任何像素，跳過')
    return
  }
  try {
    console.log(mat.rows)
    console.log(mat.cols)

    const rows = mat.rows
    const cols = mat.cols

    // 3. 決定 ROI
    let x: number, y: number, w: number, h: number
    let cursor_roi_x: number, cursor_roi_y: number, cursor_roi_w: number, cursor_roi_h: number

    if (cols === 1280 && rows === 720) {
      // 在固定 1280×720 下，用你給的座標
      x = 1115
      y = 200
      w = 65
      h = 25
      cursor_roi_x = 1010
      cursor_roi_y = 140
      cursor_roi_w = 210
      cursor_roi_h = 135
    } else {
      // any other resolution，自動按比例算一個「約同位置大小」
      x = Math.floor(cols * (1115 / 1280))
      y = Math.floor(rows * (200 / 720))
      w = Math.floor(cols * (65 / 1280))
      h = Math.floor(rows * (25 / 720))
      cursor_roi_x = Math.floor(cols * (1010 / 1280))
      cursor_roi_y = Math.floor(rows * (140 / 720))
      cursor_roi_w = Math.floor(cols * (210 / 1280))
      cursor_roi_h = Math.floor(rows * (135 / 720))
    }

    // 4. Clamp 保證不會超出邊界
    x = Math.max(0, Math.min(x, cols - 1))
    y = Math.max(0, Math.min(y, rows - 1))
    w = Math.max(1, Math.min(w, cols - x))
    h = Math.max(1, Math.min(h, rows - y))
    cursor_roi_x = Math.max(0, Math.min(cursor_roi_x, cols - 1))
    cursor_roi_y = Math.max(0, Math.min(cursor_roi_y, rows - 1))
    cursor_roi_w = Math.max(1, Math.min(cursor_roi_w, cols - cursor_roi_x))
    cursor_roi_h = Math.max(1, Math.min(cursor_roi_h, rows - cursor_roi_y))

    const roi = mat.getRegion(new cv.Rect(x, y, w, h))

    // 5. OCR 擷取「+22」之類的數字
    const buf = cv.imencode('.png', roi)

    const cursor_roi = mat.getRegion(
      new cv.Rect(cursor_roi_x, cursor_roi_y, cursor_roi_w, cursor_roi_h)
    )

    // console.log('width:', cols)
    // console.log('height:', rows)

    const tmpls = prepareScaledTemplates(mat)
    const cursor = matchTemplate(cursor_roi, tmpls.cursor)

    if (cursor.score < 0.7) {
      const {
        data: { text }
      } = await Tesseract.recognize(buf, 'eng')
      console.log('[OCR] BP Gain:', text.trim())
      return text.trim()
    } else {
      console.log('[OCR] cursor in this ROI, will retry OCR recognize')
      return ''
    }
  } catch (e) {
    console.error('[OCR] recognizeBPGain failed：', e)
  }
  return ''
}

let imagePath = ''
let isPackaged = false
let resourcesPath = ''

// 處理父程序訊息
process.parentPort.on('message', (e) => {
  const [port] = e.ports
  // 第一個訊息：帶入初始化參數
  if (e.data && e.data.type === 'init') {
    imagePath = e.data.imagePath
    isPackaged = e.data.isPackaged
    resourcesPath = e.data.resourcesPath

    // 載入 templates
    const base = isPackaged ? resourcesPath : path.join(__dirname, '../../resources/templates')

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
      indicators: loadTemplates(path.join(base, 'indicators')),
      modesCPU: loadTemplates(path.join(base, 'modes_cpu')),
      modesRanked: loadTemplates(path.join(base, 'modes_ranked')),
      cursor: loadTemplates(path.join(base, 'cursor')),
<<<<<<< HEAD
      custom: loadTemplates(path.join(base, 'custom')),
      customWin: loadTemplates(path.join(base, 'custom-win'))
=======
      custom: loadTemplates(path.join(base, 'custom'))
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
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

let scaled: typeof original | null = null
let lastResolution = { w: BASE_WIDTH, h: BASE_HEIGHT }

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
  indicators: Template[]
  modesCPU: Template[]
  modesRanked: Template[]
  cursor: Template[]
  custom: Template[]
<<<<<<< HEAD
  customWin: Template[]
=======
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
}

// 這個函式負責：
//   - 如果當前截屏解析度和上次一樣，就直接回傳舊的 scaled
//   - 否則先把截屏拉回基準大小，再依比例 resize 所有 original 裡面的模板
function prepareScaledTemplates(fullGray: Mat): ScaledTemplates {
  const cols = fullGray.cols,
    rows = fullGray.rows
  if (scaled && cols === lastResolution.w && rows === lastResolution.h) {
    return scaled
  }
  lastResolution = { w: cols, h: rows }

  // 如果截屏不是基準，就先拉回 1280×720
  const gray =
    cols === BASE_WIDTH && rows === BASE_HEIGHT
      ? fullGray
      : fullGray.resize(BASE_HEIGHT, BASE_WIDTH, 0, 0, cv.INTER_LINEAR)

  const scaleX = gray.cols / BASE_WIDTH
  const scaleY = gray.rows / BASE_HEIGHT

  // 做一次性縮放
  scaled = {
    classes: original.classes.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    emblems: original.emblems.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    playOrder: original.playOrder.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    result: original.result.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    indicators: original.indicators.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    modesCPU: original.modesCPU.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    modesRanked: original.modesRanked.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    cursor: original.cursor.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
    })),
    custom: original.custom.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
<<<<<<< HEAD
    })),
    customWin: original.customWin.map(({ name, image }) => ({
      name,
      image: image.resize(Math.round(image.rows * scaleY), Math.round(image.cols * scaleX))
=======
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
    }))
  }
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
function allMatch(
  base: Mat,
  templates: { name: string; image: Mat }[],
  threshold: number
): boolean {
  return templates.every((tpl) => {
    const { score } = matchTemplate(base, [tpl])
    return score > threshold
  })
}

let inBattle = false
let isMatchRecord = false

let isPlayingHistory = false
let mode: GameMode | null = null // current battle mode: 'cpu', 'ranked', or 'free'

let isModifyBP = false

let isModifyMode = false

let historyCooldownUntil = 0

const INTERVAL = 500
const THRESHOLD = {
  class: 0.7,
  emblem: 0.7,
  playOrder: 0.6,
<<<<<<< HEAD
  ranked: 0.8,
  result: 0.7
}

let shouldRecordNewMatch = false
=======
  ranked: 0.7,
  result: 0.7
}

let justmeetanotherbattle = false
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561

let customBattleActive = false // whether a custom-room battle is ongoing
let normalBattleActive = false // whether a normal battle is ongoing

// 避免意外改到最後一筆資料的模式
let lastRowId = -1

// 主分析函式：一次分析完成後會自動 scheduleNext()
async function analyzeOnce(port: MessagePortMain): Promise<void> {
  const now = Date.now()

  // 如果還在歷史紀錄播放的冷卻時間內，就不做任何事情，直接排程下一次
  if (now < historyCooldownUntil) {
    console.log(now - historyCooldownUntil)
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

    const cols = gray.cols
    const rows = gray.rows

    const tmpls = prepareScaledTemplates(gray)

    const halfW = Math.floor(cols / 2)
    const halfH = Math.floor(rows / 2)
    const leftArea = gray.getRegion(new cv.Rect(0, 0, halfW, rows))
    const rightArea = gray.getRegion(new cv.Rect(halfW, 0, cols - halfW, rows))
    const topRightArea = gray.getRegion(new cv.Rect(halfW, 0, cols - halfW, halfH))

    // 歷史紀錄
    const indicators = matchTemplate(gray, tmpls.indicators)

    if (indicators.score > 0.7 && indicators.name === 'history') {
      isPlayingHistory = true
      console.log(indicators)
    }

    // 偵測到正在播放歷史紀錄，就設定冷卻到 15 秒後
    if (isPlayingHistory) {
      historyCooldownUntil = now + 15_000

      inBattle = false
      isMatchRecord = false
      isPlayingHistory = false
      isModifyBP = false
      isModifyMode = false
      mode = null
      customBattleActive = false
      normalBattleActive = false
      lastRowId = -1
<<<<<<< HEAD
      shouldRecordNewMatch = false
=======
      justmeetanotherbattle = false
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561

      console.log('[Analyzer] History detected → cooling down for 15s')
      return scheduleNext(port)
    }

    // 階級模式：模板配對
    const rankDetect = matchTemplate(topRightArea, tmpls.modesRanked)

    // 階級模式判斷：BP修改
<<<<<<< HEAD
    if (rankDetect.score > THRESHOLD.ranked && !isModifyBP && lastRowId > -1) {
=======
    if (rankDetect.score > 0.8 && !isModifyBP && lastRowId > -1) {
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
      let bp: number | null = null
      console.log(rankDetect)

      const raw = await recognizeBPGain(imagePath) // 回傳 "+22" 或 "-15" 或 undefined
      if (raw === '') console.log('[analyzeOnce] OCR got empty string')
      if (raw === undefined) console.log('[analyzeOnce] OCR undefined')
      if (raw !== '' && raw !== undefined) {
        const n = parseInt(raw, 10)
        if (!Number.isNaN(n)) bp = n
        console.log(bp)
        modifyMatchBP(bp).then(() => {
          port.postMessage({ type: 'modifyMode' })
        })
        isModifyBP = true
      }
    }

    // 階級模式判斷：模式修改
<<<<<<< HEAD
    if (rankDetect.score > THRESHOLD.ranked && !isModifyMode && lastRowId > -1) {
=======
    if (rankDetect.score > 0.7 && !isModifyMode && lastRowId > -1) {
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
      isModifyMode = true
      mode = 'ranked'
      modifyMatchMode(mode)
      console.log(mode)
    }

    // 練習模式：模板配對
    const cpuDetect = matchTemplate(topRightArea, tmpls.modesCPU)

    // 練習模式判斷：模式修改
    if (cpuDetect.score > 0.7 && !isModifyMode && lastRowId > -1) {
      isModifyMode = true
      mode = 'cpu'
      modifyMatchMode(mode).then(() => {
        port.postMessage({ type: 'modifyMode' })
      })
      console.log(cpuDetect)
    }

    // 自訂房檢測 (室長 / 訪客)
    // 檢測到房間這個事件(檢測到房間，但是沒有開始對戰，而是解散出來打別的模式)
    // 辨別的節點為，是否有偵測到win/lose
    // TODO:尚未完成！
<<<<<<< HEAD

    const ownCustomWinDetect = matchTemplate(leftArea, tmpls.customWin)
    const enemyCustomWinDetect = matchTemplate(rightArea, tmpls.customWin)
    if (ownCustomWinDetect.score > 0.7) {
      console.log('ownCustomWin', ownCustomWinDetect)
    }
    if (enemyCustomWinDetect.score > 0.7) {
      console.log('enemyCustomWin', enemyCustomWinDetect)
    }

=======
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
    const roomDetect = matchTemplate(gray, tmpls.custom) // 假設 indicators 裡含 "host" 與 "guest" 模板
    if (
      roomDetect.score > THRESHOLD.ranked &&
      (roomDetect.name === 'host' || roomDetect.name === 'guest')
    ) {
      // Detected custom-room indicator
      if (!customBattleActive) {
        // start custom battle
        customBattleActive = true
        normalBattleActive = false
<<<<<<< HEAD
        // port.postMessage({ type: 'inBattle', data: { custom: true } })
      } else {
        // end custom battle
        customBattleActive = false
        // port.postMessage({ type: 'matchResult', data: { custom: true } })
=======
        port.postMessage({ type: 'inBattle', data: { custom: true } })
      } else {
        // end custom battle
        customBattleActive = false
        port.postMessage({ type: 'matchResult', data: { custom: true } })
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
      }
      return scheduleNext(port)
    }

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
    inBattle = myValid && oppoValid && turnValid

<<<<<<< HEAD
    // 處理對戰無結束的判斷節點，導致無法開始記錄下一把
    if (isMatchRecord && !inBattle) {
      shouldRecordNewMatch = true
    }

    // 戰鬥開始：首次紀錄 DB
    if ((inBattle && !isMatchRecord) || (shouldRecordNewMatch && inBattle)) {
      isMatchRecord = true
      isModifyBP = false
      isModifyMode = false
      shouldRecordNewMatch = false

      if (lastRowId > -1) {
        if (mode !== null) {
          if (customBattleActive) modifyMatchMode('custom')
=======
    if (isMatchRecord && !inBattle) {
      justmeetanotherbattle = true
    }

    // 戰鬥開始：首次紀錄 DB
    if ((inBattle && !isMatchRecord) || (justmeetanotherbattle && inBattle)) {
      isMatchRecord = true
      isModifyBP = false
      isModifyMode = false
      justmeetanotherbattle = false

      if (lastRowId > -1) {
        if (mode !== null) {
>>>>>>> 726fd188b9b862aede68e4f8e8b874213e109561
          mode = null
        } else {
          modifyMatchMode('unranked')
        }
      }

      const record = await fetchLastMatch()
      if (record) {
        lastRowId = record.id
        console.log('lastRowId', lastRowId)
      } else {
        console.warn('Can not find last record')
      }

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

      addMatch(ownName as ClassName, oppoName as ClassName, order as PlayOrder).catch((err) => {
        console.error('[Analyzer] Failed to add match:', err)
      })

      // 通知前端「進入戰鬥」
      port.postMessage({
        type: 'inBattle',
        data: { ownClass: ownName, enemyClass: oppoName, playOrder: order, inBattle: true }
      })
    }

    // 勝/敗結果檢測
    const resultDetect = matchTemplate(gray, tmpls.result)

    // 戰鬥結束：識別勝敗並更新 DB
    if (isMatchRecord && resultDetect.score > THRESHOLD.result) {
      console.log('----- Battle Finished -----')
      console.log('resultDetect', resultDetect)
      isMatchRecord = false
      inBattle = false

      const result = resultDetect.name === 'win'
      modifyMatchResult(result)
      port.postMessage({
        type: 'matchResult',
        data: { ownClass: null, enemyClass: null, playOrder: null, inBattle: false }
        // notification: {
        //   title: `[${mode}]對戰結果已紀錄`,
        //   body: win ? '勝利！' : '戰敗...'
        // }
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
  timer = setTimeout(() => analyzeOnce(port), INTERVAL)
}
