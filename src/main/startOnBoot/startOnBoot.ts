import { app } from 'electron'

export function enableAutoLaunch(): void {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe')
  })
}

export function disableAutoLaunch(): void {
  app.setLoginItemSettings({
    openAtLogin: false,
    path: app.getPath('exe')
  })
}
