import { app, BrowserWindow, MessageChannelMain, Notification, utilityProcess } from 'electron'
import forkPath from './forkedImageAnalyzer?modulePath'
import path from 'path'

export function startAnalyzer(mainWindow: BrowserWindow): void {
  console.log('[Main] analyze-image triggered')

  const imagePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tools', 'svwb.png')
    : path.join(__dirname, '../../tools', 'svwb.png')

  const { port1, port2 } = new MessageChannelMain()
  const child = utilityProcess.fork(forkPath)

  child.postMessage(
    { type: 'init', imagePath, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath },
    [port1]
  )

  port2.on('message', (e) => {
    console.log('[Child] message from forked process')
    const { type, data, notification } = e.data
    switch (type) {
      case 'inBattle':
        // 戰鬥中，不需要通知，只更新狀態
        mainWindow.webContents.send('battle:status', data)
        break

      case 'matchResult': {
        // 更新戰鬥回歸空狀態
        mainWindow.webContents.send('battle:status', data)
        mainWindow.webContents.send('matches:needRefetch')

        // 顯示一次性通知
        if (notification) {
          const { title, body } = notification
          new Notification({ title, body }).show()
        }
        break
      }

      case 'modifyMode': {
        // 重新獲取資料
        mainWindow.webContents.send('matches:needRefetch')

        // 顯示一次性通知
        if (notification) {
          const { title, body } = notification
          new Notification({ title, body }).show()
        }
        break
      }

      default:
        console.warn('[Main] unknown message type:', e)
    }
  })

  port2.start()
}
