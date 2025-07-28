import './ipc/matches'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import path, { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import fs from 'fs'
import { getDecks, addDeck } from './database'

import { isSvwbRunning } from './svwbDetector'
import { spawnCapture, stopCapture } from './manageCaptureTool'
import { startAnalyzer } from './analyzer'

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
      ? path.join(process.resourcesPath, 'tools', 'svwb-1.png')
      : path.join(__dirname, '../../tools', 'svwb-1.png')
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath)
      console.log('deleted svwb.png')
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

    mainWindow.on('ready-to-show', () => {
      mainWindow.show()
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
    startAnalyzer(mainWindow)
  }

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    clearCaptureImage()
    // Set app user model id for windows
    electronApp.setAppUserModelId('app.electron.svwb-tool')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    ipcMain.handle('decks:getAll', () => getDecks())
    ipcMain.handle('decks:add', (_e, name, svClass) => addDeck(name, svClass))

    // IPC test
    // ipcMain.on('ping', () => console.log('pong'))

    let isCapturing = false
    let isFirst = true

    setInterval(() => {
      const svwbStatus = isSvwbRunning()
      const win = BrowserWindow.getAllWindows()[0]

      const isGameRunning = svwbStatus.running

      if (win?.webContents) {
        win.webContents.postMessage('svwb:status', svwbStatus)
      }

      try {
        if (isGameRunning) {
          if (!isCapturing) {
            spawnCapture(isFirst)
            isCapturing = true
            win.webContents.send('capture:status', true)
            if (isFirst) isFirst = false
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
      clearCaptureImage()
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
