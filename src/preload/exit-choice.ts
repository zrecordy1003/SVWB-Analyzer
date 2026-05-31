import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ExitChoice', {
  ready: () => ipcRenderer.send('exit-choice:ready'),
  onContent: (cb: (p: any) => void) => {
    ipcRenderer.on('exit-choice:content', (_e, p) => cb(p))
  },
  choose: (data: { action: 'minimize' | 'exit' | 'cancel'; remember: boolean }) =>
    ipcRenderer.send('exit-choice:choose', data)
})
