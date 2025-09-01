/* eslint-disable @typescript-eslint/no-explicit-any */
import { app, BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'

const store = new Store()
let wired = false

export async function setupAutoUpdates(win: BrowserWindow): Promise<void> {
  if (!app.isPackaged) return
  if (wired) return
  wired = true

  const pkg = await import('electron-updater')
  const { autoUpdater } = pkg.default ?? pkg

  // 預設：不要自動下載，交給使用者點
  autoUpdater.autoDownload = false

  // ---- IPC（Renderer 主動控制）----
  ipcMain.handle('update:setAutoDownload', (_e, v: boolean) => {
    autoUpdater.autoDownload = !!v
  })

  ipcMain.handle('update:check', async () => {
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, info: r?.updateInfo }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  })

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  })

  ipcMain.handle('update:install', async () => {
    try {
      setImmediate(() => autoUpdater.quitAndInstall(false, true))
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  })

  // ---- 事件 → Renderer ----
  const send = (ch: string, payload?: any): void => {
    if (!win.isDestroyed()) win.webContents.send(ch, payload)
  }

  autoUpdater.on('checking-for-update', () => send('update:checking'))
  autoUpdater.on('update-available', (info) => send('update:available', info))
  autoUpdater.on('update-not-available', (info) => send('update:none', info))
  autoUpdater.on('error', (err) => send('update:error', String(err)))
  autoUpdater.on('download-progress', (p) =>
    send('update:progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  )
  autoUpdater.on('update-downloaded', (info) => send('update:downloaded', info))

  // 開 app 幾秒後自動檢查一次（不阻塞首屏）
  if (store.get('settings.autoCheckUpdates') === true)
    setTimeout(() => {
      try {
        autoUpdater.checkForUpdates()
      } catch (e) {
        console.log('updates.ts: ', e)
      }
    }, 3000)
}
