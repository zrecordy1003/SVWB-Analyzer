/* eslint-disable @typescript-eslint/no-explicit-any */
import { IpcRenderer } from '@electron-toolkit/preload'

export {}

declare global {
  interface SettingsAPI {
    get: <T = any>(key: string) => Promise<T>
    set: (key: string, value: any) => Promise<void>
    delete: (key: string) => Promise<void>
    clear: () => Promise<void>
    has: (key: string) => Promise<boolean>
    getAll: () => Promise<Record<string, any>>
  }

  interface Window {
    electronAPI: {
      openLink: (url: string) => void
    }
    electron: {
      ipcRenderer: IpcRenderer
    }
    settings: SettingsAPI
  }
}
