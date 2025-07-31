import { IpcRenderer } from '@electron-toolkit/preload'

export {}

declare global {
  interface Window {
    electronAPI: {
      openLink: (url: string) => void
    }
    electron: {
      ipcRenderer: IpcRenderer
    }
  }
}
