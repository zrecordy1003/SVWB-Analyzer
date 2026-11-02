import { app, type BrowserWindow } from 'electron'

/**
 * Keep every window of an e2e run off the developer's screen.
 *
 * The suite drives the real app, and a run used to put its splash and main
 * window in front of whatever the developer was doing - once per test, so a
 * full run stole focus dozens of times. The tests need the windows to be
 * *shown* (several assert visibility, and `window:shown` gates the telemetry
 * notice), so hiding them is not an option. Instead, with
 * `SVWB_E2E_OFFSCREEN=1` (set by `tests/e2e/app.ts`), every window:
 *
 *   - lives far outside any display, and is put back there if anything moves it;
 *   - is never activated: `show` becomes `showInactive`, `focus` does nothing;
 *   - stays out of the taskbar.
 *
 * Chromium on Windows treats a window it believes nobody can see as occluded
 * and stops painting it, which would stall `requestAnimationFrame` (the
 * renderer's ready signal waits on one) and blank Playwright's screenshots. The
 * occlusion check and background throttling are turned off for that reason.
 *
 * Never active in a normal launch: nothing outside the e2e fixture sets the
 * variable. Set `SVWB_E2E_OFFSCREEN=0` to watch a run on screen.
 */
const OFF = -32_000

function park(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const [x, y] = win.getPosition()
  if (x !== OFF || y !== OFF) win.setPosition(OFF, OFF)
}

export function installE2eOffscreen(): void {
  if (process.env.SVWB_E2E_OFFSCREEN !== '1') return

  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')

  app.on('browser-window-created', (_e, win) => {
    win.setSkipTaskbar(true)
    win.webContents.setBackgroundThrottling(false)
    win.show = () => {
      park(win)
      win.showInactive()
    }
    win.focus = () => undefined
    win.moveTop = () => undefined
    park(win)
    win.on('move', () => park(win))
    win.on('show', () => park(win))
  })
}
