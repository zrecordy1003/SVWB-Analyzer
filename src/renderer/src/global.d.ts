import { IpcRenderer } from '@electron-toolkit/preload'
import type { ClassName, GameMode } from '@shared/domain'
import type { RangeKey, RankedWinrateByOpponent } from '@shared/types'
import type { SupportPromptPayload } from '@shared/support'

export {}

declare global {
  interface SettingsAPI {
    get: <T = any>(key: string) => Promise<T>
    set: (key: string, value: any) => Promise<void>
    /** Batch write; one IPC round trip for a group of related keys. */
    setMany: (entries: Record<string, any>) => Promise<void>
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
    support: {
      /**
       * The milestone to show, or null. Marks it shown server-side, so a second
       * call in the same install returns null for that milestone.
       */
      check(): Promise<SupportPromptPayload | null>
      /** 「不再顯示」: never prompt again. */
      optOut(): Promise<void>
    }
    diagnostics: {
      summary(): Promise<{
        eventCount: number
        frameCount: number
        bytes: number
        latestAt: string | null
      }>
      /** Resolves to the written path, or null if the user cancelled. */
      exportBundle(): Promise<string | null>
      openFolder(): Promise<string>
      clear(): Promise<{
        eventCount: number
        frameCount: number
        bytes: number
        latestAt: string | null
      }>
      onRecorded(cb: (payload: unknown) => void): () => void
    }
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
    hud: {
      show(): Promise<void>
      hide(): Promise<void>
      getState(): Promise<{ opacity: number; compact: boolean }>
      setOpacity(v: number): Promise<number>
      setCompact(b: boolean): Promise<boolean>
      /** Report measured content height; resolves to the height actually applied. */
      setContentHeight(h: number): Promise<number | null>
      /**
       * Let the pointer through to the game underneath (`true`) or take it back
       * for the HUD's own controls (`false`); resolves to the state applied.
       */
      setIgnoreMouse(ignore: boolean): Promise<boolean>
      /** Manual dragging: press reported by the title row, cursor followed by main. */
      dragStart(): Promise<void>
      dragMove(x: number, y: number): void
      dragEnd(): Promise<void>
      /** Raise the main window and take it to the match list. */
      openMatchHistory(): Promise<boolean>
      onState(
        cb: (state: { opacity: number; compact: boolean }) => void
      ): () => void
    }
    matches: {
      fetchRecent(n: number, mode?: GameMode | 'all'): Promise<any[]>
      /** Mode of the newest completed match, unfiltered. See matches:latestMode. */
      latestMode(): Promise<GameMode | null>
      getRankedWinrate(params: {
        myClass: ClassName
        /** `'all'` drops the mode filter; omitted still means ranked. */
        gameMode?: GameMode | 'all'
        rangeKey?: RangeKey
        start?: Date | number | string
        end?: Date | number | string
        myDeckIds?: number[]
        tagIds?: number[]
        crMin?: number
        crMax?: number
      }): Promise<RankedWinrateByOpponent>
    }
  }
}
