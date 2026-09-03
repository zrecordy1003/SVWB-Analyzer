import { contextBridge, ipcRenderer } from 'electron'
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
   * The one bridge that can hand an arbitrary string to the OS shell.
   *
   * The http/https restriction now lives in main (`app:openLink`), not here.
   * That is not a relocation for tidiness: `shell` is the one privileged
   * module this preload reached for, and it is not available in a sandboxed
   * preload at all - so removing it is a prerequisite for ever turning the
   * main window's sandbox on. It is also the stronger place for the rule: the
   * process that owns `shell` is the one that can enforce it.
   *
   * See the `sandbox` note in `main/index.ts`'s `createWindow` for what still
   * stands in the way.
   */
  openLink: (url: string) => {
    void ipcRenderer.invoke('app:openLink', url)
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

// A check or download is started by naming the surface it belongs to, and every
// event it produces comes back carrying that name. Both update surfaces are
// mounted at once on the same broadcast, so this is what stops each one from
// reacting to the other's traffic.
contextBridge.exposeInMainWorld('updates', {
  check: (from: string) => ipcRenderer.invoke('update:check', from),
  download: (from: string) => ipcRenderer.invoke('update:download', from),
  install: () => ipcRenderer.invoke('update:install'),
  onChecking: wrapOn<{ source: string }>('update:checking'),
  onAvailable: wrapOn<{ source: string; info: any; autoDownload: boolean }>('update:available'),
  onNone: wrapOn<{ source: string; version: string }>('update:none'),
  onError: wrapOn<{ source: string; error: string }>('update:error'),
  onProgress: wrapOn<{
    source: string
    percent: number
    transferred: number
    total: number
    bytesPerSecond: number
  }>('update:progress'),
  onDownloaded: wrapOn<{ source: string; info: any }>('update:downloaded')
})

contextBridge.exposeInMainWorld('support', {
  check: () => ipcRenderer.invoke('support:check'),
  optOut: () => ipcRenderer.invoke('support:optOut')
})

contextBridge.exposeInMainWorld('appInfo', {
  getVersion: () => ipcRenderer.invoke('app:getVersion')
})

// Anonymous usage statistics. The switch goes through `setEnabled` rather than
// the generic settings bridge because main owns the timers that follow it.
contextBridge.exposeInMainWorld('telemetry', {
  status: () => ipcRenderer.invoke('telemetry:status'),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke('telemetry:setEnabled', enabled),
  preview: () => ipcRenderer.invoke('telemetry:preview'),
  uploadNow: () => ipcRenderer.invoke('telemetry:uploadNow'),
  noticeDue: () => ipcRenderer.invoke('telemetry:noticeDue')
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
  /**
   * No coordinates: main re-reads the cursor itself each tick, on purpose, so
   * the window follows the real pointer rather than a position that has
   * already moved. This used to forward `x, y` and the receiver dropped them.
   */
  dragMove: () => ipcRenderer.send('hud:dragMove'),
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
  provenanceStats: () => ipcRenderer.invoke('matches:provenanceStats')
})
