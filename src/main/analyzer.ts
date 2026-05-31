import { app, BrowserWindow, MessageChannelMain, Notification, utilityProcess } from 'electron'
import forkPath from './forkedImageAnalyzer?modulePath'
import { broadcast } from './utils/broadcast.js'
import Store from 'electron-store'
import { getCaptureImagePath, getTesseractCacheDir } from './paths.js'
import type { BattleStatus } from '../shared/types.js'

export type { BattleStatus } from '../shared/types.js'

let battleStatus: BattleStatus = {
  inBattle: false,
  ownClass: null,
  enemyClass: null,
  playOrder: null
}

let childProcess: ReturnType<typeof utilityProcess.fork> | null = null
let isStarting = false

const store = new Store()

export function startAnalyzer(_mainWindow: BrowserWindow): void {
  console.log('[Main] analyze-image triggered')

  // Prevent duplicate forks (single-instance guarantee)
  if (isStarting) {
    console.log('[Main] startAnalyzer: already starting, skip.')
    return
  }
  if (childProcess) {
    console.log('[Main] startAnalyzer: child already exists, skip.')
    return
  }
  isStarting = true

  const imagePath = getCaptureImagePath()
  const cacheDir = getTesseractCacheDir()

  const { port1, port2 } = new MessageChannelMain()

  try {
    const child = utilityProcess.fork(forkPath)
    childProcess = child

    // Clean reference on exit/error to avoid stale handles
    child.once('exit', (code) => {
      console.log('[Main] child exit:', code)
      childProcess = null
    })
    child.once('error', (err) => {
      console.error('[Main] child error:', err)
      childProcess = null
    })

    child.postMessage(
      {
        type: 'init',
        imagePath,
        cacheDir,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath
      },
      [port1]
    )

    port2.on('message', (e) => {
      console.log('[Child] message from forked process')
      const { type, data, notification } = e.data
      switch (type) {
        case 'inBattle':
          // 戰鬥中，不需要通知，只更新狀態
          broadcast('battle:status', data)

          setBattleStatus(data)
          break

        case 'matchResult': {
          // 更新戰鬥回歸空狀態
          broadcast('battle:status', data)
          setBattleStatus(data)
          broadcast('matches:needRefetch')

          // 顯示一次性通知
          if (notification && store.get('settings.enableNotifications') === true) {
            const { title, body } = notification
            new Notification({ title, body }).show()
          }
          break
        }

        case 'modifyMode': {
          // 重新獲取資料
          broadcast('matches:needRefetch')

          // 顯示一次性通知
          if (notification && store.get('settings.enableNotifications') === true) {
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
  } finally {
    isStarting = false // NEW: always release the lock
  }
}

export function stopAnalyzer(): void {
  if (!childProcess) {
    return
  }

  console.log('stop analyzer.')

  try {
    childProcess.postMessage({ type: 'stop' })
  } catch (e) {
    console.warn('[Main] postMessage stop failed, try kill()', e)
    try {
      childProcess.kill()
    } catch (e) {
      console.log('stopAnalyzer: ', e)
    }
  }
}

function setBattleStatus(status: BattleStatus): void {
  battleStatus = status
}

export function getBattleStatus(): BattleStatus {
  return battleStatus
}
