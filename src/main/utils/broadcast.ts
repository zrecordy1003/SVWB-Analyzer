import { BrowserWindow } from 'electron'

export function broadcast(channel: string, ...args: any[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}
