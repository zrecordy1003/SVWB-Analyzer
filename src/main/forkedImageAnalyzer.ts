import { type MessagePortMain } from 'electron'

import fs from 'fs'
import path from 'path'
import cv, { Mat } from '@u4/opencv4nodejs'
import { addMatch, modifyMatchResult } from './database'

// 協助模板 / 縮放比例
// const BASE_WIDTH = 1280
// const BASE_HEIGHT = 720

let imagePath = ''
let isPackaged = false
let resourcesPath = ''
let resultData = {}

process.parentPort.on('message', (e) => {
  const [port] = e.ports
  port.on('message', (e) => {
    console.log(`Message from parent: ${e.data}`)
  })
  if (e.data) {
    imagePath = e.data.imagePath
    isPackaged = e.data.isPackaged
    resourcesPath = e.data.resourcesPath

    try {
      classesTemplates = loadTemplates(resolveTemplatePath('classes'))
      playOrderTemplates = loadTemplates(resolveTemplatePath('play_order'))
      resultTemplates = loadTemplates(resolveTemplatePath('result'))

      console.log('resultData:', resultData)
    } catch (err) {
      console.error('[Analyzer] Failed to load templates:', err)
      port.postMessage({ type: 'error', message: 'Failed to load templates.' })
      return
    }

    startAnalyzeLoop(port)
  }
})

function resolveTemplatePath(...segments: string[]): string {
  return isPackaged
    ? path.join(resourcesPath, 'templates', ...segments)
    : path.join(__dirname, '../../resources/templates', ...segments)
}

function loadTemplates(dir: string): { name: string; image: Mat }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((file) => ({
      name: path.basename(file, '.png').split('-')[0],
      image: cv.imread(path.join(dir, file)).bgrToGray(),
      addition: path.basename(file, '.png').split('-')[1] || 'none'
    }))
}

let classesTemplates: { name: string; image: Mat }[] = []
let playOrderTemplates: { name: string; image: Mat }[] = []
let resultTemplates: { name: string; image: Mat }[] = []

// 你要自己量出在截圖裡面，職業圖示大概的位置（x, y, w, h）
// const ROLE_ROI = new cv.Rect(50, 100, 200, 200)
// const TURN_ROI = new cv.Rect(500, 200, 100, 100)

function matchTemplate(
  base: Mat,
  templates: { name: string; image: Mat }[]
): {
  name: string
  score: number
} {
  let best = { name: '', score: -1 }
  for (const { name, image } of templates) {
    const result = base.matchTemplate(image, cv.TM_CCOEFF_NORMED)
    const { maxVal } = result.minMaxLoc()
    // console.log(`→ ${name}: ${maxVal.toFixed(3)}`) // 列出所有模板分數
    if (maxVal > best.score) best = { name, score: maxVal }
  }
  return best
}

function startAnalyzeLoop(port: MessagePortMain): void {
  const INTERVAL = 1000
  let inBattle = false
  let isMatchRecord = false
  setInterval(() => {
    if (!fs.existsSync(imagePath)) return

    try {
      // 1. 讀圖並灰階
      const img = cv.imread(imagePath)
      if (img.empty) return
      const gray = img.bgrToGray()

      // 2. 取得當前灰階圖尺寸
      const W = gray.cols,
        H = gray.rows
      const halfW = Math.floor(W / 2)

      // 3. 根據 base ROI 及比例，定義「左職業區」與「右職業區」
      //    如果想更精準，可再細調 y, h 為圖示的垂直範圍
      // const roleY = 100 * (H / BASE_HEIGHT) // example: baseY=100
      // const roleH = 200 * (H / BASE_HEIGHT) // example: baseH=200
      // 4. 裁切出左半邊 & 右半邊
      const leftArea = gray.getRegion(new cv.Rect(0, 0, halfW, H))
      const rightArea = gray.getRegion(new cv.Rect(halfW, 0, W - halfW, H))

      // console.log(W)
      // console.log(H)

      // const leftArea = gray.getRegion(leftROI)
      // const rightArea = gray.getRegion(rightROI)

      // 5. 分別做模板匹配
      const ownClass = matchTemplate(leftArea, classesTemplates)
      const enemyClass = matchTemplate(rightArea, classesTemplates)

      const playOrder = matchTemplate(leftArea, playOrderTemplates)

      const result = matchTemplate(gray, resultTemplates)

      // if (!inBattle) {
      //   console.log('ownClass', ownClass)
      //   console.log('enemyClass', enemyClass)
      //   console.log('playOrder', playOrder)
      //   console.log('result', result)
      // }

      const classValid = ownClass.score > 0.6 || enemyClass.score > 0.6
      const turnValid = playOrder.score > 0.6
      inBattle = classValid && turnValid

      if (inBattle) {
        console.log('ownClass', ownClass)
        console.log('enemyClass', enemyClass)
        console.log('playOrder', playOrder)
        console.log('result', result)
      }
      // console.log('inBattle', inBattle)

      if (inBattle && !isMatchRecord) {
        console.log('recording match...')
        addMatch(ownClass.name, enemyClass.name, playOrder.name).catch((err) => {
          console.error('[Analyzer] Failed to add match to DB:', err)
        })
        isMatchRecord = true
      }

      if (isMatchRecord && result.score > 0.6) {
        isMatchRecord = false
        inBattle = false
        console.log(result.score)

        modifyMatchResult(result.name === 'win' ? true : false)
          .then(() => {
            resultData = {
              ownClass: null,
              enemyClass: null,
              playOrder: null,
              inBattle: false,
              refetchTable: true
            }

            port.postMessage(resultData)
          })
          .catch((err) => {
            console.error('[Analyzer] Failed to modify match result to DB:', err)
          })
      }

      // 組合結果回傳
      if (inBattle) {
        resultData = {
          ownClass: ownClass.score > 0.6 ? ownClass.name : null,
          enemyClass: enemyClass.score > 0.6 ? enemyClass.name : null,
          playOrder: playOrder.score > 0.6 ? playOrder.name : null,
          inBattle,
          refetchTable: false
        }
        port.postMessage(resultData)
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error('An error occurred in startAnalyzeLoop:', err.message)
      } else {
        console.error('Unknown error:', err)
      }
    }
  }, INTERVAL)
}
