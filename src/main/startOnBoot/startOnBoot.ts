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
