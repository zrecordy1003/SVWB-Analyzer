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
import type { Tag } from './domain.js'

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
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = Parameters<IpcContract[C]>
/**
 * `Awaited`, so an entry may be declared with the shape the caller sees rather
 * than having to say `Promise<...>` for every handler that happens to be
 * async. Whether a handler awaits anything is its own business.
 */
export type IpcResult<C extends IpcChannel> = Awaited<ReturnType<IpcContract[C]>>
