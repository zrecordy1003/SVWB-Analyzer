/* eslint-disable @typescript-eslint/no-explicit-any */
import './ipc/matches'
import { app, shell, BrowserWindow, ipcMain, Notification } from 'electron'
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
import type { BattleStatus } from './analyzer.js'
import { disableAutoLaunch, enableAutoLaunch } from './startOnBoot/startOnBoot.js'
import { createHudWindow } from './hud.js'
// 若你要把 DB 完全 on-demand，可改寫為 ensure 函式

// OpenCV env（保持：只是設定 env 不會很重）
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

// --- 單例鎖 ---
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

const MIN_SPLASH_MS = 800
let splashShownAt = 0

let mainWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let splash: BrowserWindow | null = null

// --- Analyzer 動態載入（避免冷啟動拉重模組） ---
type GetBattleStatusFn = () => BattleStatus | Promise<BattleStatus>
type StartAnalyzerFn = (win: BrowserWindow) => void | Promise<void>

let _getBattleStatus: GetBattleStatusFn | null = null
let _startAnalyzer: StartAnalyzerFn | null = null

async function ensureAnalyzer(): Promise<void> {
  if (_getBattleStatus && _startAnalyzer) return
  const mod = (await import('./analyzer.js')) as {
    getBattleStatus: GetBattleStatusFn
    startAnalyzer: StartAnalyzerFn
  }
  _getBattleStatus = mod.getBattleStatus
  _startAnalyzer = mod.startAnalyzer
}

// --- DB on-demand（第一次用到才 init） ---
// let dbReady = false
// async function ensureDbReady(): Promise<void> {
//   if (!dbReady) {
//     await initDatabase()
//     dbReady = true
//   }
// }

// --- 輕量清理函式 ---
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
      // 這裡再啟動較重的初始化
      // 首繪後才做重初始化
      clearCaptureImage()
      // 背景準備（非阻塞 UI）
      // 1) DB: 若你希望冷啟動就準備，這裡做；否則交給 IPC on-demand
      // await ensureDbReady()
      // 2) Analyzer 延遲載入＋啟動
      await ensureAnalyzer()
      _startAnalyzer?.(mainWindow!)
      // 3) 自動更新檢查（稍微再延遲，避免佔用 CPU）
      setupAutoUpdates(mainWindow!)
      // 4) 啟動輪詢（顯示後再開始，不阻塞 boot）
      startPollingForGame()
    }, wait)
  })

  mainWindow.on('close', () => {
    stopCapture()
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
  mainWindow.on('closed', () => {
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.close()
    }
    hudWindow = null
  })
}

// --- 遊戲狀態輪詢（延後到 UI 顯示後才開始） ---
function startPollingForGame(): void {
  let isCapturing = false
  let isFirstStart = true
  let isSentMinimizedInfo = false

  const timer = setInterval(async () => {
    try {
      const svwbStatus = await isShadowverseRunning()
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
      const isGameRunning = !!svwbStatus?.running

      if (win?.webContents && svwbStatus) {
        win.webContents.postMessage('svwb:status', svwbStatus)
        if (
          isSentMinimizedInfo &&
          (svwbStatus.bounds?.x !== -32000 || svwbStatus.bounds?.y !== -32000)
        ) {
          isSentMinimizedInfo = false
        }
        if (
          !isSentMinimizedInfo &&
          svwbStatus.bounds?.x === -32000 &&
          svwbStatus.bounds?.y === -32000
        ) {
          isSentMinimizedInfo = true
          new Notification({
            title: '［提醒］遊戲最小化執行中！',
            body: '對戰資訊紀錄已停止...'
          }).show()
        }
      }

      if (isGameRunning) {
        win?.webContents.send('battle:recog', true)
        if (!isCapturing) {
          spawnCapture(isFirstStart)
          isCapturing = true
          win?.webContents.send('capture:status', true)
          if (isFirstStart) isFirstStart = false
        }
      } else {
        win?.webContents.send('battle:recog', false)
        if (isCapturing) {
          stopCapture()
          isCapturing = false
          win?.webContents.send('capture:status', false)
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Polling error:', msg)
    }
  }, 1000)

  app.on('before-quit', () => clearInterval(timer))
}

// --- App lifecycle ---
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('app.electron.svwb-analyzer')

  await initDatabase()

  const { registerMatchesIpc } = await import('./ipc/matches.js')
  registerMatchesIpc()

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

  // IPC（與 DB 相關的用 ensureDbReady 包起來）
  const store = new Store()
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

  // 視窗
  createSplash()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplash()
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  stopCapture()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopCapture()
})
