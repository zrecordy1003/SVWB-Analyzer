import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron'
import path from 'path'

export function createAppTray(
  mainWindow: BrowserWindow,
  hudWindow: BrowserWindow,
  requestExit: () => void
): Tray {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png') // 改成你的打包後 icon
    : path.join(__dirname, '../../resources/icon.png')

  const tray = new Tray(nativeImage.createFromPath(iconPath))

  const toggleShow = (): void => {
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  }
  const toggleHudShow = (): void => {
    if (hudWindow.isVisible()) {
      hudWindow.hide()
    } else {
      hudWindow.show()
      hudWindow.focus()
    }
  }

  tray.setToolTip('SVWB Analyzer')
  tray.on('double-click', toggleShow)

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '顯示 / 隱藏', click: toggleShow },
      { label: '顯示 HUD / 隱藏 HUD', click: toggleHudShow },
      { type: 'separator' },
      {
        label: '退出',
        click: requestExit
      }
    ])
  )

  return tray
}

// export function notifyMinimizedToTray(): void {
//   try {
//     new Notification({
//       title: '已最小化至系統列',
//       body: '點擊系統列圖示可回到應用。'
//     }).show()
//   } catch {}
// }
