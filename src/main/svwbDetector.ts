import { windowManager } from 'node-window-manager'
import type { Window as WinMgrWindow } from 'node-window-manager'

export const findSvwbWindow = (): WinMgrWindow | undefined =>
  windowManager.getWindows().find((w) => w.getTitle().toLowerCase().includes('shadowversewb'))

interface bound {
  x?: number
  y?: number
  width?: number
  height?: number
}

export const isSvwbRunning = (): { running: boolean; hwnd: number | null; bound?: bound } => {
  const win = findSvwbWindow()
  if (!win) {
    return { running: false, hwnd: null }
  }
  const hwnd = win.id
  const bound = win?.getBounds()
  return { running: true, hwnd, bound }
}
