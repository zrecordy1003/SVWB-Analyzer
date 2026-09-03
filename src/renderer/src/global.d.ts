import { IpcRenderer } from '@electron-toolkit/preload'
import type { GameMode } from '@shared/domain'
import type { RankedWinrateQuery } from '@shared/types'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'

export {}

/**
 * What a channel's bridge method resolves to, taken from `@shared/ipc`.
 *
 * This file used to restate every one of these by hand, and the drift is why
 * the contract exists: `matches.fetchRecent` was declared `Promise<any[]>`,
 * `hud.setOpacity` was `Promise<number>` where the handler returns
 * `number | undefined` when there is no HUD window, `updates.check` was
 * `{ ok: boolean; info?: any }` rather than the union it actually answers
 * with, and `getRankedWinrate`'s parameter object was a THIRD copy of a type
 * that is declared once in `@shared/types`.
 *
 * Anything below still written out by hand is a channel not yet in the
 * contract - `settings:*` and `diagnostics:*` - and is marked as such.
 */
type Answer<C extends IpcChannel> = Promise<IpcResult<C>>

declare global {
  /**
   * Payload common to every `update:*` broadcast. `source` names the surface
   * that owns the flow - see `UpdateSource` in `@shared/updates`. Both update
   * surfaces are mounted at once, so each one filters on it.
   */
  type UpdateEvent<T = unknown> = { source: import('@shared/updates').UpdateSource } & T

  /**
   * The settings bridge, typed by key.
   *
   * It used to be `get: <T = any>(key: string) => Promise<T>` - which cannot
   * tell a typo from a key, or a boolean from a number, and made every caller
   * assert its own answer. `AppStoreSchema` moved to `@shared/settings` so
   * this could be keyed against it.
   *
   * `settings:*` is not in `@shared/ipc` on purpose: that contract maps a
   * channel to ONE function type, and `settings:get` is not one function - its
   * return depends on the key. A generic method is the right shape, and this is
   * where it belongs.
   *
   * Dotted paths (`'settings.telemetry'`) are `electron-store`'s own syntax and
   * reach a nested value, so the key is widened to allow them; a bare string
   * still has to look like one of those rather than be anything at all.
   */
  interface SettingsAPI {
    get<K extends keyof import('@shared/settings').AppStoreSchema>(
      key: K
    ): Promise<import('@shared/settings').AppStoreSchema[K]>
    get<T = unknown>(key: `${string}.${string}`): Promise<T>
    set<K extends keyof import('@shared/settings').AppStoreSchema>(
      key: K,
      value: import('@shared/settings').AppStoreSchema[K]
    ): Promise<void>
    set(key: `${string}.${string}`, value: unknown): Promise<void>
    /** Batch write; one IPC round trip for a group of related keys. */
    setMany(entries: Record<string, unknown>): Promise<void>
    delete(
      key: keyof import('@shared/settings').AppStoreSchema | `${string}.${string}`
    ): Promise<void>
    clear(): Promise<void>
    has(
      key: keyof import('@shared/settings').AppStoreSchema | `${string}.${string}`
    ): Promise<boolean>
    getAll(): Promise<import('@shared/settings').AppStoreSchema>
  }

  interface Window {
    electronAPI: {
      openLink: (url: string) => void
    }
    electron: {
      ipcRenderer: IpcRenderer
    }
    settings: SettingsAPI
    appInfo: { getVersion(): Answer<'app:getVersion'> }
    telemetry: {
      status(): Answer<'telemetry:status'>
      /** Persists the setting and starts or stops the uploads. Resolves to the new status. */
      setEnabled(...args: IpcArgs<'telemetry:setEnabled'>): Answer<'telemetry:setEnabled'>
      /** Exactly what an upload would send right now. Does not mint an install id. */
      preview(): Answer<'telemetry:preview'>
      uploadNow(): Answer<'telemetry:uploadNow'>
      /**
       * Whether the one-time notice is due. Marks it shown - which is also what
       * unblocks uploading, so calling this is what lets the first upload go.
       * Refuses, without consuming anything, from a window that is not visible.
       */
      noticeDue(): Answer<'telemetry:noticeDue'>
    }
    support: {
      /**
       * The milestone to show, or null. Marks it shown server-side, so a second
       * call in the same install returns null for that milestone.
       */
      check(): Answer<'support:check'>
      /** 「不再顯示」: never prompt again. */
      optOut(): Answer<'support:optOut'>
    }
    /** NOT in the contract yet: needs `DiagnosticsSummary` moved to `@shared`. */
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
      check(...args: IpcArgs<'update:check'>): Answer<'update:check'>
      download(...args: IpcArgs<'update:download'>): Answer<'update:download'>
      install(): Answer<'update:install'>
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
      show(): Answer<'hud:show'>
      hide(): Answer<'hud:hide'>
      getState(): Answer<'hud:getState'>
      /** Resolves to the clamped value, or `undefined` when there is no HUD window. */
      setOpacity(...args: IpcArgs<'hud:setOpacity'>): Answer<'hud:setOpacity'>
      setCompact(...args: IpcArgs<'hud:setCompact'>): Answer<'hud:setCompact'>
      /** Report measured content height; resolves to the height actually applied. */
      setContentHeight(...args: IpcArgs<'hud:setContentHeight'>): Answer<'hud:setContentHeight'>
      /**
       * Let the pointer through to the game underneath (`true`) or take it back
       * for the HUD's own controls (`false`); resolves to the state applied.
       */
      setIgnoreMouse(...args: IpcArgs<'hud:setIgnoreMouse'>): Answer<'hud:setIgnoreMouse'>
      /** Manual dragging: press reported by the title row, cursor followed by main. */
      dragStart(): Answer<'hud:dragStart'>
      /**
       * Fire-and-forget, and with no coordinates: main re-reads the cursor
       * each tick so the window follows the real pointer.
       */
      dragMove(): void
      dragEnd(): Answer<'hud:dragEnd'>
      /** Raise the main window and take it to the match list. */
      openMatchHistory(): Answer<'hud:openMatchHistory'>
      onState(cb: (state: IpcResult<'hud:getState'>) => void): () => void
    }
    matches: {
      fetchRecent(n: number, mode?: GameMode | 'all'): Answer<'matches:fetchRecent'>
      /** Mode of the newest completed match, unfiltered. See matches:latestMode. */
      latestMode(): Answer<'matches:latestMode'>
      getRankedWinrate(params: RankedWinrateQuery): Answer<'stats:getRankedWinrateByOpponent'>
      /** Aggregate of the provenance columns. See main/data/provenanceStats.ts. */
      provenanceStats(): Answer<'matches:provenanceStats'>
    }
  }
}
