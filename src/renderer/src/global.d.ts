import { IpcRenderer } from '@electron-toolkit/preload'
import type { ClassName, GameMode } from '@shared/domain'
import type { ProvenanceStats, RangeKey, RankedWinrateByOpponent } from '@shared/types'
import type { SupportPromptPayload } from '@shared/support'

export {}

declare global {
  /**
   * Payload common to every `update:*` broadcast. `source` names the surface
   * that owns the flow - see `UpdateSource` in `@shared/updates`. Both update
   * surfaces are mounted at once, so each one filters on it.
   */
  type UpdateEvent<T = unknown> = { source: import('@shared/updates').UpdateSource } & T

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
    telemetry: {
      status(): Promise<import('@shared/telemetry').TelemetryStatus>
      /** Persists the setting and starts or stops the uploads. Resolves to the new status. */
      setEnabled(enabled: boolean): Promise<import('@shared/telemetry').TelemetryStatus>
      /** Exactly what an upload would send right now. Does not mint an install id. */
      preview(): Promise<import('@shared/telemetry').TelemetryPayload>
      uploadNow(): Promise<import('@shared/telemetry').TelemetryStatus>
      /**
       * Whether the one-time notice is due. Marks it shown - which is also what
       * unblocks uploading, so calling this is what lets the first upload go.
       */
      noticeDue(): Promise<boolean>
    }
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
      /** `from` names the calling surface; its events come back tagged with it. */
      check(
        from: import('@shared/updates').UpdateSource
      ): Promise<{ ok: boolean; info?: any; error?: string }>
      download(
        from: import('@shared/updates').UpdateSource
      ): Promise<{ ok: boolean; error?: string }>
      install(): Promise<{ ok: boolean; error?: string }>
      onChecking(cb: (p: UpdateEvent) => void): () => void
      onAvailable(
        cb: (
          p: UpdateEvent<{
            info: import('@shared/updates').UpdateSummary
            autoDownload: boolean
          }>
        ) => void
      ): () => void
      onNone(cb: (p: UpdateEvent<{ version: string }>) => void): () => void
      onError(cb: (p: UpdateEvent<{ error: string }>) => void): () => void
      onProgress(cb: (p: UpdateEvent<import('@shared/updates').UpdateProgress>) => void): () => void
      onDownloaded(
        cb: (p: UpdateEvent<{ info: import('@shared/updates').UpdateSummary }>) => void
      ): () => void
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
      onState(cb: (state: { opacity: number; compact: boolean }) => void): () => void
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
        /** `'family'` (default) expands each id to every version of that deck. */
        myDeckScope?: 'family' | 'deck'
        tagIds?: number[]
        crMin?: number
        crMax?: number
        /** Keep only the N most recent matches that pass every other filter. */
        limit?: number
      }): Promise<RankedWinrateByOpponent>
      /** Aggregate of the provenance columns. See main/data/provenanceStats.ts. */
      provenanceStats(): Promise<ProvenanceStats>
    }
  }
}
