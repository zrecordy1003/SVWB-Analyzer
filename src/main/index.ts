import './ipc/matches'
import { app, shell, BrowserWindow, ipcMain, Notification } from 'electron'
import path, { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import fs from 'fs'
import { getDecks, addDeck } from './database'

import { isSvwbRunning } from './svwbDetector'
import { spawnCapture, stopCapture } from './manageCaptureTool'
import { startAnalyzer } from './analyzer'

// import Store from 'electron-store'

// set env for opencv
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

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  let mainWindow: BrowserWindow

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

  function createWindow(): void {
    // Create the browser window.
    mainWindow = new BrowserWindow({
      width: 900,
      height: 670,
      show: false,
      autoHideMenuBar: true,
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    mainWindow.removeMenu()

    // const store = new Store()
    // store.set(theme:'se','ss')

    mainWindow.on('ready-to-show', () => {
      mainWindow.show()
      clearCaptureImage()
      startAnalyzer(mainWindow)
    })

    mainWindow.on('close', () => {
      stopCapture()
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    mainWindow.webContents.openDevTools()
  }

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('app.electron.svwb-analyzer')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    ipcMain.handle('decks:getAll', () => getDecks())
    ipcMain.handle('decks:add', (_e, name, svClass) => addDeck(name, svClass))

    // ipcMain.handle('store:set', (_e, name, svClass) => addDeck(name, svClass))
    // IPC test
    // ipcMain.on('ping', () => console.log('pong'))

    let isCapturing = false
    let isFirstStart = true
    let isSentMinimizedInfo = false

    setInterval(() => {
      const svwbStatus = isSvwbRunning()
      const win = BrowserWindow.getAllWindows()[0]

      const isGameRunning = svwbStatus.running

      if (win?.webContents && svwbStatus) {
        win.webContents.postMessage('svwb:status', svwbStatus)
        if (
          isSentMinimizedInfo &&
          (svwbStatus.bound?.x !== -32000 || svwbStatus.bound?.y !== -32000)
        ) {
          isSentMinimizedInfo = false
        }
        if (
          !isSentMinimizedInfo &&
          svwbStatus.bound?.x === -32000 &&
          svwbStatus.bound?.y === -32000
        ) {
          isSentMinimizedInfo = true
          new Notification({
            title: '［提醒］遊戲最小化執行中！',
            body: '對戰資訊紀錄已停止...'
          }).show()
        }
      }

      try {
        if (isGameRunning) {
          if (!isCapturing) {
            spawnCapture(isFirstStart)
            isCapturing = true
            win.webContents.send('capture:status', true)
            if (isFirstStart) isFirstStart = false
          }
        } else {
          if (isCapturing) {
            stopCapture()
            isCapturing = false
            win.webContents.send('capture:status', false)
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`Error while ${isGameRunning ? 'running' : 'not running'}:`, msg)
      }
    }, 1000)

    ipcMain.on('stop-capture', () => {
      stopCapture()
    })

    createWindow()

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    app.on('will-quit', () => {
      // clearCaptureImage()
    })

    app.on('before-quit', () => {
      stopCapture()
    })
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    stopCapture()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
