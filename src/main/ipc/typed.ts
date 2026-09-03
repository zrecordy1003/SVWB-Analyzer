/**
 * `ipcMain.handle`, checked against `src/shared/ipc.ts`.
 *
 * The only thing this adds is that it will not compile when a handler's
 * arguments or its result disagree with the channel's declared shape - which
 * is the entire gap it exists to close, since a mismatch used to be invisible
 * on both sides until a screen read a field that was not there.
 *
 * It is deliberately not a wrapper around anything else. No logging, no
 * error trapping, no argument coercion: handlers that can fail in a way the UI
 * can act on return `Res<T>` through `wrapRes`, and adding a second mechanism
 * here would give two answers to the same question.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

import type {
  IpcArgs,
  IpcChannel,
  IpcResult,
  IpcSendArgs,
  IpcSendChannel
} from '../../shared/ipc.js'

export function handleIpc<C extends IpcChannel>(
  channel: C,
  handler: (event: IpcMainInvokeEvent, ...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>
): void {
  // The cast is at the boundary and it is the only one: Electron's own
  // signature is `(event, ...args: any[]) => any`, so the types stop here and
  // everything above this line has them.
  ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)
}

/**
 * `ipcMain.on`, checked against `IpcSendContract`.
 *
 * The same guarantee for the fire-and-forget direction, which is where the
 * `'s:startOnBoot'` / `'settings:startOnBoot'` mismatch lived: a channel that
 * is not in the contract will not compile on either side, so the two names
 * cannot drift apart.
 */
export function onIpc<C extends IpcSendChannel>(
  channel: C,
  listener: (event: IpcMainEvent, ...args: IpcSendArgs<C>) => void
): void {
  ipcMain.on(channel, listener as (event: IpcMainEvent, ...args: unknown[]) => void)
}

/** `ipcMain.once`, same contract. */
export function onceIpc<C extends IpcSendChannel>(
  channel: C,
  listener: (event: IpcMainEvent, ...args: IpcSendArgs<C>) => void
): void {
  ipcMain.once(channel, listener as (event: IpcMainEvent, ...args: unknown[]) => void)
}
