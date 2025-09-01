/* eslint-disable @typescript-eslint/no-explicit-any */
import { app, shell, BrowserWindow, ipcMain, Notification, powerMonitor } from 'electron'
import path, { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import fs from 'fs'
import Store from 'electron-store'

// 輕依賴先載（重依賴延遲到用到才 import）
import { isShadowverseRunning } from './svwbDetector.js'
import { spawnCapture, stopCapture } from './manageCaptureTool.js'

// DB 與更新延後：只載入 helper，初始化放到事件之後
import { initDatabase } from './db/initDb.js'
import { setupAutoUpdates } from './updates.js'
import { getBattleStatus, type BattleStatus } from './analyzer.js'
import { disableAutoLaunch, enableAutoLaunch } from './startOnBoot/startOnBoot.js'
import { createHudWindow } from './hud.js'
// import { attachCloseGuard } from './closeGuard.js'
import { createAppTray } from './tray.js'
import { attachSmartClose } from './smartClose.js'
import { openExitConfirmDialog } from './exitConfirmDialog.js'

// OpenCV env
process.env.OPENCV4NODEJS_DISABLE_AUTOBUILD = '1'
process.env.OPENCV_INCLUDE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'opencv', 'include')
  : path.join(__dirname, '../../resources/opencv/include')
process.env.OPENCV_LIB_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'opencv', 'lib')
  : path.join(__dirname, '../../resources/opencv/lib')
process.env.OPENCV_BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'opencv', 'bin')
  : path.join(__dirname, '../../resources/opencv/bin')

const store = new Store({
  defaults: {
    settings: {
      hudShow: true,
      askBeforeExit: true,
      onCloseBehavior: 'minimize',
      enableNotifications: true,
      autoCheckUpdates: true
    }
  }
})

// --- 單例鎖 ---
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

const MIN_SPLASH_MS = 800
let splashShownAt = 0

let tray: Electron.Tray | null = null
let mainWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let splash: BrowserWindow | null = null

// let isDirty = false
// let rememberNoAsk = false

// --- Analyzer 動態載入 ---
type GetBattleStatusFn = () => BattleStatus | Promise<BattleStatus>
type StartAnalyzerFn = (win: BrowserWindow) => void | Promise<void>
type StopAnalyzerFn = (opts?: { timeoutMs?: number }) => Promise<void> | void

let _getBattleStatus: GetBattleStatusFn | null = null
let _startAnalyzer: StartAnalyzerFn | null = null
let _stopAnalyzer: StopAnalyzerFn | null = null

async function ensureAnalyzer(): Promise<void> {
  if (_getBattleStatus && _startAnalyzer && _stopAnalyzer) return
  const mod = (await import('./analyzer.js')) as {
    getBattleStatus: GetBattleStatusFn
    startAnalyzer: StartAnalyzerFn
    stopAnalyzer: StopAnalyzerFn
  }
  _getBattleStatus = mod.getBattleStatus
  _startAnalyzer = mod.startAnalyzer
  _stopAnalyzer = mod.stopAnalyzer
}

// --- DB on-demand（第一次用到才 init） ---
// let dbReady = false
// async function ensureDbReady(): Promise<void> {
//   if (!dbReady) {
//     await initDatabase()
//     dbReady = true
//   }
// }

// --- 清理擷取圖片 ---
function clearCaptureImage(): void {
  const imagePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb.png')
    : path.join(__dirname, '../../tools', 'svwb.png')

  const tmpImagePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb.png.tmp.png')
    : path.join(__dirname, '../../tools', 'svwb.png.tmp.png')

  if (fs.existsSync(imagePath)) {
    fs.unlinkSync(imagePath)
    console.log('deleted svwb.png')
  }
  if (fs.existsSync(tmpImagePath)) {
    fs.unlinkSync(tmpImagePath)
    console.log('deleted svwb.png.tmp.png')
  }
}

// --- 視窗建立 ---
function createSplash(): void {
  splash = new BrowserWindow({
    width: 360,
    height: 420,
    frame: false,
    transparent: true,
    resizable: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/splash-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  splashShownAt = Date.now()
  const splashPath = app.isPackaged
    ? path.join(process.resourcesPath, 'splash.html')
    : path.join(__dirname, '../../resources/splash.html')

  splash.loadFile(splashPath)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    ...(process.platform === 'linux' ? { icon } : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.removeMenu()

  ipcMain.once('renderer:ready', () => {
    const elapsed = Date.now() - splashShownAt
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed)
    setTimeout(async () => {
      if (splash && !splash.isDestroyed()) {
        splash.close()
        splash = null
      }
      mainWindow!.show()
      // 首繪後才做初始化
      clearCaptureImage()
      // 背景準備
      // await ensureDbReady()
      // Analyzer 載入
      await ensureAnalyzer()
      // _startAnalyzer?.(mainWindow!)
      // 自動更新檢查
      setupAutoUpdates(mainWindow!)
      // 啟動遊戲輪詢
      startPollingForGame()
    }, wait)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 開發時自動開 DevTools；正式版不要開
  if (is.dev) mainWindow.webContents.openDevTools()

  hudWindow = createHudWindow()

  if (!tray) tray = createAppTray(mainWindow, hudWindow, app.exit)

  mainWindow.on('closed', () => {
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.close()
    }
    hudWindow = null
  })

  const shouldAskExit = (): boolean =>
    getBattleStatus().inBattle || store.get('settings.askBeforeExit') === true

  const confirmExit = async (): Promise<boolean> => {
    if (store.get('settings.askBeforeExit') === true) return true

    const { confirmed, remember } = await openExitConfirmDialog({
      parent: mainWindow!,
      appName: 'SVWB Analyzer',
      title: '確認關閉應用？',
      message: '你確定要關閉 SVWB Analyzer 嗎？',
      detail: '對戰進行中，關閉後將停止紀錄，本場記錄將被捨棄。',
      rememberLabel: '以後不要再詢問'
    })

    if (remember) store.set('settings.askBeforeExit', false)
    return confirmed
  }

  attachSmartClose(mainWindow, {
    shouldAskExit,
    confirmExit,
    onBeforeMinimize: () => {
      // 最小化時順便做的事（例如暫停 HUD 或停止擷取）
      // stopCapture()
    },
    onBeforeExitApproved: () => {
      // 真的要關時做收尾
      // stopCapture()
    }
  })
}

// 閒置秒數門檻（可改成從 settings 讀取）
const IDLE_THRESHOLD_SECONDS = 1800
// const IDLE_THRESHOLD_SECONDS = 10

async function isSystemIdle(thresholdSec: number): Promise<boolean> {
  const pm: any = powerMonitor as any
  try {
    // 新版 Electron：同步
    if (typeof pm.getSystemIdleState === 'function') {
      const state = pm.getSystemIdleState(thresholdSec) // 'active' | 'idle' | 'locked' | 'unknown'
      return state === 'idle' || state === 'locked'
    }
    // 舊版：回呼或 promise
    if (typeof pm.querySystemIdleState === 'function') {
      const state = await pm.querySystemIdleState(thresholdSec)
      return state === 'idle' || state === 'locked'
    }
    // 最後備援：用 idle time
    if (typeof pm.getSystemIdleTime === 'function') {
      const t = pm.getSystemIdleTime()
      return t >= thresholdSec
    }
  } catch (e) {
    console.log(e)
  }
  return false
}

// --- 遊戲狀態輪詢 ---
function startPollingForGame(): void {
  let isCapturing = false
  let isAnalyzerRunning = false
  let isFirstStart = true
  let isSentMinimizedInfo = false
  let isSentIdleInfo = false

  // 上次「遊戲有在跑」的時間（不論最小化）
  let lastGameRunningAt: number | null = null
  // 上次「遊戲在跑且可擷取（未最小化、具有 bounds）」的時間
  let lastUnpausedAt: number | null = null

  const timer = setInterval(async () => {
    try {
      const svwbStatus = await isShadowverseRunning()
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed() || win.webContents?.isDestroyed()) return

      // 推送遊戲狀態給 UI
      if (svwbStatus) win.webContents.postMessage('svwb:status', svwbStatus)

      const now = Date.now()
      const isGameRunning = !!svwbStatus?.running
      const bx = svwbStatus?.bounds?.x
      const by = svwbStatus?.bounds?.y
      const hasBounds = typeof bx === 'number' && typeof by === 'number'
      const isMinimized = hasBounds && bx === -32000 && by === -32000

      // 「擷取」的暫停條件（和之前相同）：最小化 / 無 Bounds 視為不可擷取
      const treatAsPaused = isGameRunning && (!hasBounds || isMinimized)

      // 更新時間戳
      if (isGameRunning) lastGameRunningAt = now
      if (isGameRunning && !treatAsPaused) lastUnpausedAt = now

      // 閒置是否已超過 30 分鐘
      const idleTooLong = await isSystemIdle(IDLE_THRESHOLD_SECONDS) // 1800

      const THRESHOLD_MS = IDLE_THRESHOLD_SECONDS * 1000
      const gameClosedTooLong =
        !isGameRunning && lastGameRunningAt !== null && now - lastGameRunningAt >= THRESHOLD_MS
      const minimizedTooLong =
        isGameRunning && lastUnpausedAt !== null && now - lastUnpausedAt >= THRESHOLD_MS

      // ─────────────────────────────────────────────────
      // 擷取（Capture）：維持原本行為（最小化/隱藏就停，恢復就啟）
      // ─────────────────────────────────────────────────
      const shouldCapture = isGameRunning && !treatAsPaused

      if (shouldCapture) {
        win.webContents.send('battle:recog', true)
        if (!isCapturing) {
          spawnCapture(isFirstStart)
          isCapturing = true
          win.webContents.send('capture:status', true)
          if (isFirstStart) isFirstStart = false
        }
      } else {
        win.webContents.send('battle:recog', false)
        if (isCapturing) {
          stopCapture()
          isCapturing = false
          win.webContents.send('capture:status', false)
        }
      }

      // 通知（只在第一次偵測到事件時提醒一次）
      if (isGameRunning) {
        if (isSentMinimizedInfo && !isMinimized && hasBounds) isSentMinimizedInfo = false
        if (!isSentMinimizedInfo && (isMinimized || !hasBounds)) {
          isSentMinimizedInfo = true
          store.get('settings.enableNotifications') === true &&
            new Notification({
              title: '［提醒］遊戲最小化 / 視窗不在前景',
              body: '已暫停擷取畫面，分析仍在待命；超過 30 分鐘會自動關閉。'
            }).show()
        }
      } else {
        isSentMinimizedInfo = false
      }

      if (isGameRunning) {
        if (isSentIdleInfo && !idleTooLong) isSentIdleInfo = false
        if (!isSentIdleInfo && idleTooLong) {
          isSentIdleInfo = true
          // new Notification({
          //   title: '［提醒］系統閒置已達 30 分鐘',
          //   body: '將自動關閉分析以節省資源。恢復操作或開啟遊戲時會再啟動。'
          // }).show()
        }
      } else {
        isSentIdleInfo = false
      }

      // ─────────────────────────────────────────────────
      // 分析（Analyzer）：只有「閒置≥30 分鐘」或「遊戲關閉≥30 分鐘」才關閉
      // 啟動時機仍保持「看到遊戲在跑」才啟動
      // ─────────────────────────────────────────────────
      const shouldStopAnalyzer = idleTooLong || gameClosedTooLong || minimizedTooLong

      if (shouldStopAnalyzer) {
        if (isAnalyzerRunning) {
          try {
            await _stopAnalyzer?.()
          } catch (e) {
            console.log(e)
          }
          isAnalyzerRunning = false
        }
      } else {
        // 未達關閉條件時：
        // 只有在「遊戲正在執行」且尚未啟動時，才啟動分析
        if (isGameRunning && !isAnalyzerRunning) {
          await ensureAnalyzer()
          _startAnalyzer?.(win)
          isAnalyzerRunning = true
        }
        // 遊戲關閉但尚未滿 30 分鐘 → 保持「暖機待命」
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Polling error:', msg)
    }
  }, 1000)

  // 系統事件：睡眠/鎖定 → 只停擷取，不立即停分析（交給 30 分鐘門檻）
  powerMonitor.on('suspend', async () => {
    try {
      stopCapture()
    } catch (e) {
      console.log(e)
    }
  })
  powerMonitor.on('lock-screen', async () => {
    try {
      stopCapture()
    } catch (e) {
      console.log(e)
    }
  })

  app.on('quit', () => clearInterval(timer))
}

// --- App lifecycle ---
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('app.electron.svwb-analyzer')

  await initDatabase()

  const { registerMatchesIpc } = await import('./ipc/matches.js')
  registerMatchesIpc()

  const { registerDecksIpc } = await import('./ipc/decks.js')
  registerDecksIpc()

  const { registerTagsIpc } = await import('./ipc/tags.js')
  registerTagsIpc()

  app.on('browser-window-created', (_e, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.on('settings:startOnBoot', (_event, enable) => {
    if (enable) {
      enableAutoLaunch()
    } else {
      disableAutoLaunch()
    }
  })

  // IPC
  ipcMain.handle('battle:getStatus', async () => {
    await ensureAnalyzer()
    return _getBattleStatus?.()
  })

  // Decks：先確保 DB 準備好再操作
  ipcMain.handle('decks:getAll', async () => {
    const { getDecks } = await import('./database.js')
    return getDecks()
  })
  ipcMain.handle('decks:add', async (_e, name: string, svClass: string) => {
    const { addDeck } = await import('./database.js')
    return addDeck(name, svClass)
  })

  // settings（不需要 DB）
  ipcMain.handle('settings:get', (_event, key: string) => store.get(key))
  ipcMain.handle('settings:set', (_event, key: string, value: any) => store.set(key, value))
  ipcMain.handle('settings:delete', (_event, key: string) => store.delete(key))
  ipcMain.handle('settings:clear', () => store.clear())
  ipcMain.handle('settings:has', (_event, key: string) => store.has(key))
  ipcMain.handle('settings:getAll', () => store.store)

  // 停止 capture
  ipcMain.on('stop-capture', () => stopCapture())

  // 建立視窗
  createSplash()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplash()
      createWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  stopCapture()
  try {
    await _stopAnalyzer?.()
  } catch (e) {
    console.log(e)
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  stopCapture()
  try {
    await _stopAnalyzer?.()
  } catch (e) {
    console.log(e)
  }
})
