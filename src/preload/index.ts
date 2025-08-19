/* eslint-disable @typescript-eslint/no-explicit-any */
import { contextBridge, ipcRenderer, shell } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ClassName } from '@prisma/client'
import type { RankedWinrateByOpponent } from '../main/ipc/helper.js'

// Custom APIs for renderer
const api = {}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.

contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('electronAPI', {
  openLink: (url: string) => shell.openExternal(url)
})

contextBridge.exposeInMainWorld('settings', {
  get: (key: string) => ipcRenderer.invoke('settings:get', key),
  set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
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

contextBridge.exposeInMainWorld('appInfo', {
  getVersion: () => ipcRenderer.invoke('app:getVersion')
})

contextBridge.exposeInMainWorld('hud', {
  show: () => ipcRenderer.invoke('hud:show'),
  hide: () => ipcRenderer.invoke('hud:hide'),
  setOpacity: (v: number) => ipcRenderer.invoke('hud:setOpacity', v),
  setPinned: (p: boolean) => ipcRenderer.invoke('hud:setPinned', p),
  setClickThrough: (b: boolean) => ipcRenderer.invoke('hud:setClickThrough', b)
})

contextBridge.exposeInMainWorld('matches', {
  fetchRecent: (n: number) => ipcRenderer.invoke('matches:fetchRecent', n),
  getRankedWinrate: (params: {
    myClass: ClassName
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
