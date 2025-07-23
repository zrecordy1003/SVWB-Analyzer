import { app, shell, BrowserWindow, ipcMain, utilityProcess, MessageChannelMain } from 'electron'
import path, { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import { getDecks, addDeck } from './database'

import { isSvwbRunning } from './svwbDetector'
import { spawnCapture, stopCapture } from './capture'
import fs from 'fs'

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

// import { fork } from 'child_process'
import forkPath from './forkedImageAnalyzer?modulePath'

// import cv from '@u4/opencv4nodejs'

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

  ipcMain.on('analyze-image', () => {
    // console.log(path.join(process.resourcesPath, 'opencv', 'include'))
    console.log('[Main] analyze-image triggered')

    const imagePath = app.isPackaged
      ? path.join(process.resourcesPath, 'templates', 'test.png')
      : path.join(__dirname, '../../resources', 'test.png')
    // ? path.join(process.resourcesPath, 'tools', 'svwb-1.png')

    const { port1, port2 } = new MessageChannelMain()
    const child = utilityProcess.fork(forkPath)

    child.postMessage(
      { imagePath, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath },
      [port1]
    )

    child.on('message', (msg) => {
      console.log('[Main] Received from analyzer:', msg)
      mainWindow.webContents.send('battle:status', msg)
    })

    port2.on('message', (e) => {
      mainWindow.webContents.send('battle:status', e.data)
    })
    port2.start()
    port2.postMessage('hello from main')
  })

  // function readImageWhenReady(filePath: string, retry = 5): void {
  //   const delay = 100
  //   const tryRead = (count: number) => {
  //     if (count <= 0) return console.warn('Fail - retry count exceeded')
  //     if (!fs.existsSync(filePath)) {
  //       return setTimeout(() => tryRead(count - 1), delay)
  //     }
  //     const image = cv.imread(filePath)
  //     if (image.empty) {
  //       console.warn('retry...')
  //       return setTimeout(() => tryRead(count - 1), delay)
  //     }
  //     console.log('Success - image sizes:', image.sizes)
  //     // 處理 image...
  //   }
  //   tryRead(retry)
  // }

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
    ipcMain.on('ping', () => console.log('pong'))

    setInterval(() => {
      const status = isSvwbRunning()
      const win = BrowserWindow.getAllWindows()[0]

      win.webContents.postMessage('svwb:status', process.env.OPENCV_INCLUDE_DIR)
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

    ipcMain.on('start-capture', (_e, interval: number) => {
      spawnCapture(interval)

      // const filePath = app.isPackaged
      //   ? path.join(process.resourcesPath, 'tools', 'svwb-1.png')
      //   : path.join(__dirname, '../../tools', 'svwb-1.png')
      // readImageWhenReady(filePath)
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
