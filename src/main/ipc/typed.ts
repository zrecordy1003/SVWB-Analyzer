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
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { IpcArgs, IpcChannel, IpcResult } from '../../shared/ipc.js'

export function handleIpc<C extends IpcChannel>(
  channel: C,
  handler: (event: IpcMainInvokeEvent, ...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>
): void {
  // The cast is at the boundary and it is the only one: Electron's own
  // signature is `(event, ...args: any[]) => any`, so the types stop here and
  // everything above this line has them.
  ipcMain.handle(channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)
}
