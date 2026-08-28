import { contextBridge, ipcRenderer, shell } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ClassName, GameMode } from '../shared/domain.js'
import type { RangeKey, RankedWinrateByOpponent } from '../shared/types.js'

// Custom APIs for renderer
const api = {}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.

contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * The renderer only ever passes constants of ours, but this is the one bridge
   * that can hand an arbitrary string straight to the OS shell. Restrict it to
   * real web links so no future call site - or injected markup - can reach
   * `file:`, `javascript:` or a registered protocol handler.
   */
  openLink: (url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    void shell.openExternal(parsed.toString())
  }
})

contextBridge.exposeInMainWorld('settings', {
  get: (key: string) => ipcRenderer.invoke('settings:get', key),
  set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
  setMany: (entries: Record<string, any>) => ipcRenderer.invoke('settings:setMany', entries),
  delete: (key: string) => ipcRenderer.invoke('settings:delete', key),
  clear: () => ipcRenderer.invoke('settings:clear'),
  has: (key: string) => ipcRenderer.invoke('settings:has', key),
  getAll: () => ipcRenderer.invoke('settings:getAll')
})

function wrapOn<T = any>(channel: string, map?: (a: any[]) => T) {
  return (cb: (payload: T) => void) => {
    const listener = (_e: unknown, ...args: any[]): void => cb(map ? map(args) : (args[0] as T))
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('diagnostics', {
  summary: () => ipcRenderer.invoke('diagnostics:summary'),
  exportBundle: () => ipcRenderer.invoke('diagnostics:export'),
  openFolder: () => ipcRenderer.invoke('diagnostics:openFolder'),
  clear: () => ipcRenderer.invoke('diagnostics:clear'),
  onRecorded: wrapOn('diagnostics:new')
})

contextBridge.exposeInMainWorld('updates', {
  setAutoDownload: (v: boolean) => ipcRenderer.invoke('update:setAutoDownload', v),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onChecking: wrapOn('update:checking'),
  onAvailable: wrapOn('update:available'),
  onNone: wrapOn('update:none'),
  onError: wrapOn<string>('update:error'),
  onProgress: wrapOn<{
    percent: number
    transferred: number
    total: number
    bytesPerSecond: number
  }>('update:progress'),
  onDownloaded: wrapOn('update:downloaded')
})

contextBridge.exposeInMainWorld('support', {
  check: () => ipcRenderer.invoke('support:check'),
  optOut: () => ipcRenderer.invoke('support:optOut')
})

contextBridge.exposeInMainWorld('appInfo', {
  getVersion: () => ipcRenderer.invoke('app:getVersion')
})

contextBridge.exposeInMainWorld('hud', {
  show: () => ipcRenderer.invoke('hud:show'),
  hide: () => ipcRenderer.invoke('hud:hide'),
  getState: () => ipcRenderer.invoke('hud:getState'),
  setOpacity: (v: number) => ipcRenderer.invoke('hud:setOpacity', v),
  setCompact: (b: boolean) => ipcRenderer.invoke('hud:setCompact', b),
  setContentHeight: (h: number) => ipcRenderer.invoke('hud:setContentHeight', h),
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.invoke('hud:setIgnoreMouse', ignore),
  // Manual dragging: the OS drag region is inert on this click-through overlay,
  // so the title row reports the press and main follows the cursor.
  dragStart: () => ipcRenderer.invoke('hud:dragStart'),
  dragMove: (x: number, y: number) => ipcRenderer.send('hud:dragMove', x, y),
  dragEnd: () => ipcRenderer.invoke('hud:dragEnd'),
  openMatchHistory: () => ipcRenderer.invoke('hud:openMatchHistory'),
  onState: wrapOn('hud:state')
})

contextBridge.exposeInMainWorld('matches', {
  fetchRecent: (n: number, mode?: GameMode | 'all') =>
    ipcRenderer.invoke('matches:fetchRecent', n, mode),
  latestMode: (): Promise<GameMode | null> => ipcRenderer.invoke('matches:latestMode'),
  getRankedWinrate: (params: {
    myClass: ClassName
    gameMode?: GameMode | 'all'
    rangeKey?: RangeKey
    start?: Date | number | string
    end?: Date | number | string
  }): Promise<RankedWinrateByOpponent> =>
    ipcRenderer.invoke('stats:getRankedWinrateByOpponent', params),
  onNewMatch: (cb: (m: any) => void) => {
    const handler = (_e, m): void => cb(m)
    ipcRenderer.on('matches:new', handler)
    return () => ipcRenderer.removeListener('matches:new', handler)
  }
})
