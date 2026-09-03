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
import type { Deck, DeckCategory, GameMode, Match, Tag } from './domain.js'
import type {
  DeckCreateInput,
  DeckImportCommitInput,
  DeckListItem,
  DeckSaveLocalInput,
  DeckStatsQuery,
  DeckStatsRow,
  DeckUpdateInput,
  PortalLang
} from './decks.js'
import type { DeckImportPreview, ParsedDeckInput, StoredDeckCard } from './deckImport.js'
import type { CardStatsResult } from './cardStats.js'
import type { CardPoolResult, CardPoolStatusRow, CardStatsPayload } from './cards.js'
import type { BattleStatus, GameStatus, HudState } from './types.js'
import type { UpdateSource } from './updates.js'
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

  // ------------------------------------------------------------------ decks
  //
  // Every one of these answers with `Res<T>`. They are the channels a person
  // can make fail - a duplicate name, a deck code that has expired, an
  // optimistic-lock conflict - and the message has to reach the dialog that
  // asked, which is what the envelope is for.
  'deckCategories:all': () => Res<DeckCategory[]>
  'deckCategories:create': (input: { name: string }) => Res<DeckCategory>
  /** Default scope is the current version of each live family; `'all'` includes every version. */
  'decks:all': (params?: { scope?: 'current' | 'all' }) => Res<DeckListItem[]>
  'decks:stats': (params?: DeckStatsQuery) => Res<DeckStatsRow[]>
  'decks:get': (params: { id: number }) => Res<{ deck: Deck; cards: StoredDeckCard[] }>
  'decks:cards': (params: { deckId: number }) => Res<StoredDeckCard[]>
  'decks:create': (input: DeckCreateInput) => Res<Deck>
  'decks:update': (input: DeckUpdateInput) => Res<Deck>
  'decks:saveLocal': (input: DeckSaveLocalInput) => Res<Deck>
  'decks:setDefaultForClass': (params: { deckId: number }) => Res<Deck>
  /** `deleted` and `archived` are counts: a played deck is archived, an unplayed one deleted. */
  'decks:delete': (params: {
    id: number
  }) => Res<{ success: true; deleted: number; archived: number }>
  'decks:deleteImpact': (params: { id: number }) => Res<{ matches: number; versions: number }>
  'decks:versionImpact': (params: {
    id: number
  }) => Res<{ matches: number; versions: number; isLastActive: boolean }>
  'decks:importPreview': (input: {
    text: string
    lang?: PortalLang
  }) => Res<{ preview: DeckImportPreview; duplicateDeckId: number | null }>
  'decks:import': (input: DeckImportCommitInput) => Res<Deck>
  /** What is on the clipboard, if it parses as a deck code or portal link. */
  'decks:clipboardCandidate': () => Res<ParsedDeckInput | null>
  'decks:renewCode': (input: { hash: string }) => Res<{ deckCode: string; ttlMs: number }>
  /**
   * Discarding one version. `familyDeleted` is how the caller knows the whole
   * deck went with it - discarding the only remaining active version means
   * "delete this deck", so it behaves like `decks:delete` rather than leaving
   * the family pointing at an archived row.
   */
  'decks:deleteVersion': (params: {
    id: number
  }) => Res<{ success: true; deleted: number; archived: number; familyDeleted: boolean }>
  /** Gives a deck a shareable identity on the portal, for one that never went there. */
  'decks:publishCode': (input: {
    deckId: number
  }) => Res<{ hash: string; deckCode: string; shareUrl: string; ttlMs: number }>

  // ------------------------------------------------------------------ cards
  'cards:pool': (input: { classId: number; battleFormat: number }) => Res<CardPoolResult>
  'cards:syncPool': (input: {
    classId: number
    battleFormat: number
  }) => Res<{ cardCount: number; syncedAt: number }>
  'cards:poolStatus': () => Res<CardPoolStatusRow[]>
  'cards:stats': (input?: CardStatsPayload) => Res<CardStatsResult>

  // -------------------------------------------------------------------- hud
  //
  // None of these can fail in a way the UI can act on, so none of them use the
  // envelope: the window is either there or the call is a no-op.
  'hud:getState': () => HudState
  /**
   * The opacity that was applied, clamped - or `undefined` when there is no
   * HUD window to apply it to. Every one of these returns nothing in that
   * case; this is the one whose caller reads the value back, so it is the one
   * where the `undefined` has to be stated.
   */
  'hud:setOpacity': (opacity: number) => number | undefined
  'hud:setCompact': (compact: boolean) => boolean
  /** The height that was applied, or null when the value was not a number. */
  'hud:setContentHeight': (height: number) => number | null
  'hud:setIgnoreMouse': (ignore: boolean) => boolean
  'hud:show': () => void
  'hud:hide': () => void
  'hud:close': () => void
  'hud:dragStart': () => void
  'hud:dragEnd': () => void

  // ----------------------------------------------------------------- app
  'app:getVersion': () => string

  // ----------------------------------------------------------------- window
  'battle:getStatus': () => BattleStatus | undefined
  /** The last broadcast status, for a window that opened between transitions. */
  'game:getStatus': () => GameStatus | null
  'hud:openMatchHistory': () => boolean
  /** Refuses anything but http/https, and says so by returning false. */
  'app:openLink': (url: unknown) => boolean

  // ---------------------------------------------------------------- updates
  /**
   * `info` is present only on the real updater's path.
   *
   * The dev simulator answers `{ ok: true }` with nothing else, while the real
   * `autoUpdater` branch adds `info: r?.updateInfo`. Both registrations are
   * for the same channel - only one is ever installed - and the divergence is
   * harmless because nothing reads the reply's `info`: the details reach the
   * renderer on the `update:available` broadcast instead. Declared as optional
   * rather than tidied, because pretending the two agree would be the lie.
   */
  'update:check': (
    from: UpdateSource
  ) => { ok: true; info?: unknown } | { ok: false; error: string }
  'update:download': (from: UpdateSource) => { ok: true } | { ok: false; error: string }
  'update:install': () => { ok: true } | { ok: false; error: string }
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

/**
 * Fire-and-forget, renderer to main. No reply, so no return type.
 *
 * This exists because of a bug it would have caught: the Settings page sent
 * `'s:startOnBoot'` while main listened on `'settings:startOnBoot'`, so
 * "start with Windows" persisted its switch, showed as on, and never once
 * registered a login item. Nothing could have noticed - two bare strings that
 * did not have to match.
 *
 * Only the renderer-to-main direction is here. The broadcasts the other way
 * (`game:status`, `reference-data:changed`, `update:*`, ...) are still bare
 * strings on both ends and want the same treatment; they are a larger set and
 * their own change.
 */
export type IpcSendContract = {
  'settings:startOnBoot': (enable: boolean) => void
  /** Ask main to stop capture. Nothing waits on it. */
  'stop-capture': () => void
  /**
   * A drag tick, with NO coordinates.
   *
   * The bridge used to declare `dragMove(x, y)` and send the pointer's screen
   * position, which main's handler ignored: it re-reads the cursor itself, on
   * purpose, because the window is re-anchored to the real cursor each tick
   * rather than to a position that has already moved. Declaring arguments the
   * receiver drops is the same kind of fiction as the mismatched name above.
   */
  'hud:dragMove': () => void
  /** First paint. Main closes the splash and shows the window on it. */
  'renderer:ready': () => void
}

export type IpcSendChannel = keyof IpcSendContract
export type IpcSendArgs<C extends IpcSendChannel> = Parameters<IpcSendContract[C]>

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = Parameters<IpcContract[C]>
/**
 * `Awaited`, so an entry may be declared with the shape the caller sees rather
 * than having to say `Promise<...>` for every handler that happens to be
 * async. Whether a handler awaits anything is its own business.
 */
export type IpcResult<C extends IpcChannel> = Awaited<ReturnType<IpcContract[C]>>
