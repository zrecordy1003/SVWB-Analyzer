/**
 * `invoke`, with the channel's argument and return types inferred.
 *
 * The renderer had 33 call sites reaching for
 * `window.electron.ipcRenderer.invoke('decks:all')` directly - every decks,
 * tags and matches mutation channel among them - which is a bare string and an
 * `any` on both ends. This is the same call with `src/shared/ipc.ts` in front
 * of it: a channel that is not declared will not compile, an argument of the
 * wrong shape will not compile, and the result arrives typed instead of as
 * `any`.
 *
 * It goes through `window.electron.ipcRenderer` rather than adding a method to
 * the preload bridge per channel. The bridge's job is to decide what the
 * renderer may reach at all; once `ipcRenderer.invoke` is exposed - it has
 * been from the start - a per-channel wrapper adds a name to maintain and no
 * safety, whereas the contract adds the safety and no names.
 */
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'

export function invokeIpc<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> {
  return window.electron.ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>
}
