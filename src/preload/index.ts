import { contextBridge, shell } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
// import Store from 'electron-store'

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

// const a = new Store({
//   name: 'aaa'
// })
// const store = new Store({
//   name: 'aaa'
// })
// contextBridge.exposeInMainWorld('settings', {
//   get: (key) => store.get(key),
//   set: (key, value) => store.set(key, value)
// })
