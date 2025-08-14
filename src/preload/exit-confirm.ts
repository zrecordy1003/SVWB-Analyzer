/* eslint-disable @typescript-eslint/no-explicit-any */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ExitConfirm', {
  ready: () => ipcRenderer.send('exit-confirm:ready'),
  onContent: (cb: (p: any) => void) => {
    ipcRenderer.on('exit-confirm:content', (_e, p) => cb(p))
  },
  choose: (data: { confirmed: boolean; remember: boolean }) =>
    ipcRenderer.send('exit-confirm:choose', data)
})
