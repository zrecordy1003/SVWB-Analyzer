import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import { getDecks, addDeck } from './database'

import { isSvwbRunning } from './svwbDetector'
import { spawnCapture, stopCapture } from './capture'

// import cv from '@u4/opencv4nodejs'

let mainWindow: BrowserWindow

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
      sandbox: false
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
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('decks:getAll', () => getDecks())
  ipcMain.handle('decks:add', (_e, name, svClass) => addDeck(name, svClass))

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.on('start-capture', (_e, interval: number) => {
    spawnCapture(interval)
  })

  ipcMain.on('stop-capture', () => {
    stopCapture()
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  setInterval(() => {
    const status = isSvwbRunning()
    const win = BrowserWindow.getAllWindows()[0]
    let isShow = true
    if (win && win.webContents) {
      win.webContents.postMessage('svwb:status', status)
    }
    if (status.running) {
      try {
        isShow ?? console.log('svwb is running')
        isShow = !isShow
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error('An error occurred while svwb is running:', err.message)
        } else {
          console.error('Unknown error:', err)
        }
      }
    } else {
      try {
        isShow ?? console.log('should start svwb')
        isShow = !isShow
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error('An error occurred while svwb is not running:', err.message)
        } else {
          console.error('Unknown error:', err)
        }
      }
    }
  }, 1000)

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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
