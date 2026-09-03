/**
 * The login item.
 *
 * `--hidden` is read by `main/index.ts`; `--auto-launch` is not read by
 * anything and is there to make the argv self-describing in Task Manager and
 * in a bug report. Both were passed for a long time while nothing read either,
 * so "start with Windows" showed a window at every login - see the comment on
 * `startedHidden`.
 */
import { app } from 'electron'

export function enableAutoLaunch(): void {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: ['--hidden', '--auto-launch']
    })
  } else if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden', '--auto-launch'] })
  }
}

export function disableAutoLaunch(): void {
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: process.execPath,
      args: ['--hidden', '--auto-launch']
    })
  } else if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: false })
  }
}
