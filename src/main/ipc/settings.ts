import { app, ipcMain } from 'electron'
import { store } from '../store.js'
import { handleIpc, onIpc } from './typed.js'
import { disableAutoLaunch, enableAutoLaunch } from '../startOnBoot/startOnBoot.js'

/**
 * Settings passthrough plus the two app-level queries that have no other home.
 *
 * These lived inline in `index.ts`, which made that file both the startup
 * sequence and an IPC registry. The handlers that stayed behind are the ones
 * genuinely bound to its closures (the analyzer accessor, the poll's last known
 * game status); everything here only needed the shared store.
 */
export function registerSettingsIpc(): void {
  handleIpc('app:getVersion', () => app.getVersion())

  ipcMain.handle('settings:get', (_event, key: string) => store.get(key as never))
  ipcMain.handle('settings:set', (_event, key: string, value: unknown) =>
    store.set(key as never, value as never)
  )
  /**
   * One round trip for a batch of related keys. The analyzer persists ten
   * filter fields; writing them one at a time meant ten IPC calls for every
   * single change to any one of them.
   */
  ipcMain.handle('settings:setMany', (_event, entries: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(entries)) {
      store.set(key as never, value as never)
    }
  })
  ipcMain.handle('settings:delete', (_event, key: string) => store.delete(key as never))
  ipcMain.handle('settings:clear', () => store.clear())
  ipcMain.handle('settings:has', (_event, key: string) => store.has(key as never))
  ipcMain.handle('settings:getAll', () => store.store)

  /**
   * Register or remove the login item.
   *
   * The Settings page sent `'s:startOnBoot'` at this for as long as the switch
   * existed, and this listens on `'settings:startOnBoot'` - two bare strings
   * that never had to match, so the switch persisted its own state, rendered
   * as on next visit, and this never ran. It is in `IpcSendContract` now, so
   * the two names cannot part company again.
   *
   * No user was affected in the end: the switch itself is commented out in
   * `Settings.tsx`, so the path has been unreachable from the UI. That is why
   * this is a note rather than a fix with a test behind it - there is nothing
   * on screen to drive. Re-enable the control and it works.
   */
  onIpc('settings:startOnBoot', (_event, enable) => {
    if (enable) enableAutoLaunch()
    else disableAutoLaunch()
  })
}
