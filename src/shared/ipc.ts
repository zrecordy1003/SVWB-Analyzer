/**
 * The IPC contract: one declaration of every channel, its arguments and what
 * it answers with.
 *
 * # Why this file exists
 *
 * There are 84 `ipcMain.handle` registrations in `src/main`, and until this
 * file the renderer's view of them was `src/renderer/src/global.d.ts` - hand
 * written, with no link of any kind to the handlers it described. So changing
 * what a handler returns compiled clean on both sides and failed at runtime,
 * in whichever screen read the missing field first. Separately, 33 call sites
 * skipped the preload bridge entirely (`window.electron.ipcRenderer.invoke`),
 * which meant no types at all: every decks, tags and matches mutation channel
 * was a bare string and an `any`.
 *
 * # How it is arranged
 *
 * A channel is declared as a FUNCTION TYPE, because that is what it is: the
 * parameters are what the caller sends and the return is what it gets back.
 * `Parameters<>` and `ReturnType<>` then give both sides their halves from the
 * one declaration, so there is nothing to keep in sync.
 *
 * This file is the source of truth and both processes depend on it - the same
 * direction as `shared/domain.ts` and `shared/types.ts`, and the reason the
 * dependency does not point from the renderer into `src/main`. Return shapes
 * that used to live in a main-side module have moved here for that reason,
 * which is where they belonged anyway: a type the renderer consumes is part of
 * the contract, not an implementation detail of the handler.
 *
 * # Using it
 *
 * Main registers with `handleIpc` (`src/main/ipc/typed.ts`), which will not
 * accept a handler whose arguments or result disagree with the entry below.
 * The renderer calls `invokeIpc` (`src/renderer/src/ipc.ts`), which infers
 * both. Adding a channel means adding a line here first; the compiler then
 * says which side is missing.
 */
import type { GameMode, Match, Tag } from './domain.js'
import type { SupportPromptPayload } from './support.js'
import type { TelemetryPayload, TelemetryStatus } from './telemetry.js'
import type {
  MatchDetail,
  MatchEditInput,
  MatchExtras,
  MatchListPage,
  QueryPayload,
  ProvenanceStats,
  RankedWinrateByOpponent,
  RankedWinrateQuery
} from './types.js'

/**
 * The envelope the fallible handlers answer with.
 *
 * Four main-side modules had their own identical copy of this and their own
 * `wrap()` to produce it. It is part of the wire format, so it lives with the
 * wire format.
 *
 * Not every channel uses it, and that is not an oversight: the ones that
 * cannot fail in a way the UI can act on (reading a setting, asking the HUD
 * its state) return their value directly, and wrapping them would mean every
 * call site unwrapping something that is always `ok`.
 */
export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: string }
export type Res<T> = Ok<T> | Err

/**
 * Run `fn` and package the outcome.
 *
 * The `catch` is the point: an exception in a handler crosses the IPC boundary
 * as an opaque `Error: Error invoking remote method ...` with the real message
 * buried, so every fallible handler catches its own and returns the text.
 */
export const wrapRes = async <T>(fn: () => Promise<T>): Promise<Res<T>> => {
  try {
    return { ok: true, data: await fn() }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// ------------------------------------------------------------------- contract

/**
 * Every `invoke`-able channel.
 *
 * Being incomplete is a normal state while the migration finishes: an
 * unlisted channel simply cannot be registered through `handleIpc` or called
 * through `invokeIpc` yet, and still works the old way. It is not a second
 * door onto the same channel - a channel is in exactly one of the two worlds.
 */
export type IpcContract = {
  // ------------------------------------------------------------------- tags
  'tags:list': () => Tag[]
  'tags:create': (name: string) => Tag
  'tags:update': (params: { id: number; name: string }) => Tag
  'tags:delete': (id: number) => { ok: true }

  // ---------------------------------------------------------------- support
  /** `null` when nothing is due, or the user has opted out. Marks it shown. */
  'support:check': () => SupportPromptPayload | null
  'support:optOut': () => void

  // -------------------------------------------------------------- telemetry
  'telemetry:status': () => TelemetryStatus
  'telemetry:setEnabled': (enabled: boolean) => TelemetryStatus
  /** What an upload would send right now. Does not mint an install id. */
  'telemetry:preview': () => TelemetryPayload
  'telemetry:uploadNow': () => TelemetryStatus
  /**
   * Whether the one-time notice should be shown, marking it shown on the way
   * out. Refuses - without consuming anything - when the asking window is not
   * on screen; see the handler.
   */
  'telemetry:noticeDue': () => boolean

  // ------------------------------------------------------------ card images
  'cardImages:stats': () => { files: number; bytes: number }
  'cardImages:clear': () => { ok: boolean }

  // ---------------------------------------------------------------- matches
  'matches:count': (payload?: QueryPayload) => number
  /** The match list's hot path: keyset pagination, relations loaded. */
  'matches:queryList': (payload?: QueryPayload) => MatchListPage
  'matches:getPage': (payload?: QueryPayload) => MatchDetail[]
  'matches:getById': (id: number) => MatchDetail | null
  'matches:getExtras': (id: number) => MatchExtras
  'matches:fetchRecent': (n?: number, mode?: GameMode | 'all' | null) => Match[]
  'matches:latestMode': () => GameMode | null
  'matches:provenanceStats': () => ProvenanceStats
  'matches:delete': (id: number) => boolean
  'matches:updateBP': (matchId: number, bp: number | null) => MatchDetail
  'matches:updateNote': (matchId: number, note: string | null) => MatchDetail
  'matches:updateDeck': (matchId: number, side: 'my' | 'oppo', deckId: number | null) => MatchDetail
  'matches:setTags': (matchId: number, tagNames: string[]) => MatchDetail
  /**
   * `Record<string, unknown>`, and honestly so: this handler validates its own
   * input properly - `asClass`, the play-order check, `Number.isFinite` on the
   * timestamp, clearing the deck for deckless modes - and the comment on
   * `invalid()` is explicit that the write path must not trust the UI.
   * Declaring a tidy type here would describe a narrower contract than the
   * channel actually honours.
   */
  'matches:create': (payload: Record<string, unknown>) => MatchDetail | null
  /**
   * Typed, unlike `create`, and for the opposite reason: this handler checks
   * each field for presence and writes it straight into the column without
   * checking its type. See `MatchEditInput`.
   */
  'matches:updateWithExtras': (payload: MatchEditInput) => MatchDetail | null

  'stats:getRankedWinrateByOpponent': (args: RankedWinrateQuery) => RankedWinrateByOpponent
}

/**
 * Channels not yet in the contract, and why - so the gap is a decision rather
 * than a to-do nobody wrote down.
 *
 * `settings:*` is a generic key/value bridge over `electron-store`. Typing it
 * honestly means moving `AppStoreSchema` out of `src/main/store.ts` into
 * `shared/`, which is a change to where the app's settings shape lives - worth
 * doing, but not as a side effect of typing IPC.
 *
 * `diagnostics:*` needs `DiagnosticsSummary`, which lives in
 * `src/main/recognition/diagnosticsBundle.ts` and has to move here first.
 *
 * `hud:*`, `update:*` and the handful in `index.ts` are next; `update:*` is
 * registered twice - once by the real updater and once by the simulator - so
 * both registrations have to move together.
 */

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = Parameters<IpcContract[C]>
/**
 * `Awaited`, so an entry may be declared with the shape the caller sees rather
 * than having to say `Promise<...>` for every handler that happens to be
 * async. Whether a handler awaits anything is its own business.
 */
export type IpcResult<C extends IpcChannel> = Awaited<ReturnType<IpcContract[C]>>
