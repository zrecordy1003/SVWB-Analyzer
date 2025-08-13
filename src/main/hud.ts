import { BrowserWindow, app, screen, ipcMain } from 'electron'
import path from 'path'
import Store from 'electron-store'
import { is } from '@electron-toolkit/utils'

const store = new Store<{
  hudOpacity: number
  hudPinned: boolean
  hudBounds: Electron.Rectangle | null
}>({
  defaults: { hudOpacity: 0.85, hudPinned: true, hudBounds: null }
})

let hudWin: BrowserWindow | null = null
let ipcRegistered = false

export function createHudWindow(): BrowserWindow {
  if (hudWin && !hudWin.isDestroyed()) return hudWin

  const wa = screen.getPrimaryDisplay().workArea
  const saved = store.get('hudBounds') ?? {
    x: wa.x + wa.width - 420,
    y: wa.y + 100,
    width: 285,
    height: 550
  }

  hudWin = new BrowserWindow({
    ...saved,
    frame: false,
    resizable: true,
    movable: true,
    maximizable: false,
    fullscreenable: false,
    // skipTaskbar: true,
    thickFrame: false,
    backgroundColor: '#00000000',
    alwaysOnTop: store.get('hudPinned'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (is.dev) hudWin.webContents.openDevTools({ mode: 'detach' })

  const url = app.isPackaged
    ? `file://${path.join(__dirname, '../renderer/hud.html')}`
    : process.env.ELECTRON_RENDERER_URL! + '/hud.html'

  hudWin.hide()
  hudWin.loadURL(url)

  hudWin.setVisibleOnAllWorkspaces(true)
  hudWin.setOpacity(store.get('hudOpacity') ?? 0.85)
  hudWin.setAlwaysOnTop(store.get('hudPinned'), 'screen-saver')

  // 移動/縮放時保存位置
  hudWin.on('moved', () => store.set('hudBounds', hudWin!.getBounds()))
  hudWin.on('resized', () => store.set('hudBounds', hudWin!.getBounds()))

  hudWin.on('closed', () => (hudWin = null))

  const forceRepaint = (): void => {
    if (!hudWin || hudWin.isDestroyed()) return
    const b = hudWin.getBounds()
    hudWin.setBounds(b)
  }
  hudWin.webContents.once('did-finish-load', () => {
    forceRepaint()
    hudWin?.showInactive()
  })
  hudWin.setHasShadow(true)
  hudWin.on('show', forceRepaint)
  hudWin.on('restore', forceRepaint)
  hudWin.on('focus', forceRepaint)

  // ---- IPC（避免重複註冊）----
  if (!ipcRegistered) {
    // 若曾經註冊過，先移除（保險）
    ipcMain.removeHandler('hud:setOpacity')
    ipcMain.removeHandler('hud:setPinned')
    ipcMain.removeHandler('hud:show')
    ipcMain.removeHandler('hud:hide')
    ipcMain.removeHandler('hud:close')

    ipcMain.handle('hud:setOpacity', (_e, v: number) => {
      if (!hudWin) return
      const val = Math.min(1, Math.max(0.2, v))
      hudWin.setOpacity(val)
      store.set('hudOpacity', val)
      return val
    })
    ipcMain.handle('hud:setPinned', (_e, pinned: boolean) => {
      if (!hudWin) return
      hudWin.setAlwaysOnTop(pinned, 'screen-saver')
      store.set('hudPinned', pinned)
      return pinned
    })
    ipcMain.handle('hud:show', () => hudWin?.showInactive())
    ipcMain.handle('hud:hide', () => hudWin?.hide())
    ipcMain.handle('hud:close', () => hudWin?.close())

    ipcRegistered = true
  }

  return hudWin
}
