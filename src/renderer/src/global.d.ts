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
    appInfo: { getVersion(): Promise<string> }
    updates: {
      setAutoDownload(v: boolean): Promise<void>
      check(): Promise<{ ok: boolean; info?: any; error?: string }>
      download(): Promise<{ ok: boolean; error?: string }>
      install(): Promise<{ ok: boolean; error?: string }>
      onChecking(cb: () => void): () => void
      onAvailable(cb: (info: any) => void): () => void
      onNone(cb: (info: any) => void): () => void
      onError(cb: (err: string) => void): () => void
      onProgress(
        cb: (p: {
          percent: number
          transferred: number
          total: number
          bytesPerSecond: number
        }) => void
      ): () => void
      onDownloaded(cb: (info: any) => void): () => void
    }
    hud?: {
      show(): Promise<void>
      hide(): Promise<void>
      setOpacity(v: number): Promise<number>
      setPinned(p: boolean): Promise<boolean>
      setClickThrough?(b: boolean): Promise<boolean>
    }
    matches?: {
      fetchRecent(n: number): Promise<any[]>
      onNewMatch(cb: (m: any) => void): () => void
    }
  }
}
