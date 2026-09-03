import { BrowserWindow, app, globalShortcut, screen, ipcMain } from 'electron'
import path from 'path'
import { store } from '../store.js'
import { is } from '@electron-toolkit/utils'

let hudWin: BrowserWindow | null = null
let ipcRegistered = false
let shortcutsRegistered = false

/**
 * The HUD is not user-resizable: its width is the one the layout is designed
 * for, and its height is whatever the content currently needs (see
 * `fitHeight`). A dragged edge could only ever cut content off or leave a band
 * of empty glass, so the window owns both dimensions outright.
 */
const HUD_WIDTH = 285
/** Only a floor for the first frame, before the renderer reports a height. */
const MIN_HEIGHT = 140

/**
 * Alt-tabbing passes through transient foreground windows, and a HUD that
 * blinks on every one of them is worse than one that lags slightly. Showing is
 * immediate; only hiding waits, and only long enough to outlast a switch that
 * is on its way back to the game.
 */
const HIDE_DELAY_MS = 100
let hideTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Whether the user explicitly hid the HUD.
 *
 * One-directional on purpose. This used to be a symmetric "override" that was
 * reset whenever focus changed - but closing the HUD by its own ✕ necessarily
 * crosses a focus edge on the way back to the game (the click focused the HUD,
 * returning refocuses the game), so the user's close was undone by the very
 * next tick, every time. Now: an explicit hide sticks until the user shows the
 * HUD again (tray, shortcut); an explicit show simply hands control back to
 * the follow-the-game rule, which is what "show" means while it is on.
 */
let userHidden = false

function cancelPendingHide(): void {
  if (!hideTimer) return
  clearTimeout(hideTimer)
  hideTimer = null
}

/** Show/hide asked for by the user. A hide sticks; a show rejoins the rule. */
function setVisibility(visible: boolean): void {
  if (!hudWin || hudWin.isDestroyed()) return
  cancelPendingHide()
  userHidden = !visible
  if (visible) hudWin.showInactive()
  else hudWin.hide()
}

/**
 * Whether a focus change could still move the HUD.
 *
 * The 16ms focus ticker in `index.ts` asks this so it can stop calling
 * `syncHudWithGame` when there is nothing the answer could change: no HUD
 * window, or one that is already off screen. It deliberately does not know
 * whether the game is running - that belongs to the poll - so the caller ands
 * the two halves together.
 */
export function hudCouldMove(): boolean {
  return !!hudWin && !hudWin.isDestroyed() && hudWin.isVisible()
}

/** Tray entry and global shortcut. Goes through the override, so the follow-game
 * rule cannot undo it on the very next tick. */
export function toggleHudVisibility(): void {
  if (!hudWin || hudWin.isDestroyed()) return
  setVisibility(!hudWin.isVisible())
}

/**
 * Follow the game's focus, so the HUD reads as part of the game rather than as
 * another window: it is on screen exactly while the game is the window in
 * front, and gone the moment the user is doing something else.
 *
 * Called on a tick rather than only on change, so toggling the setting takes
 * effect right away instead of waiting for the next alt-tab.
 */
export function syncHudWithGame(gameFocused: boolean): void {
  if (!hudWin || hudWin.isDestroyed()) return

  if (store.get('settings.hudFollowGame') === false || userHidden) {
    cancelPendingHide()
    return
  }
  // Reaching for the opacity slider or the history link focuses the HUD, which
  // by definition means the game is not in front. Hiding it out from under the
  // pointer would make its own controls unusable.
  if (hudWin.isFocused()) {
    cancelPendingHide()
    return
  }

  if (gameFocused) {
    cancelPendingHide()
    if (!hudWin.isVisible()) hudWin.showInactive()
    return
  }

  if (!hudWin.isVisible() || hideTimer) return
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (hudWin && !hudWin.isDestroyed() && !hudWin.isFocused()) hudWin.hide()
  }, HIDE_DELAY_MS)
}

type HudState = {
  opacity: number
  compact: boolean
}

function getHudState(): HudState {
  return {
    opacity: store.get('hudOpacity') ?? 0.85,
    compact: store.get('hudCompact') ?? true
  }
}

/** Keeps the renderer's controls in step with tray clicks and global shortcuts. */
function publishState(): void {
  if (!hudWin || hudWin.isDestroyed() || hudWin.webContents.isDestroyed()) return
  hudWin.webContents.send('hud:state', getHudState())
}

function setCompact(compact: boolean): boolean {
  if (!hudWin || hudWin.isDestroyed()) return false
  store.set('hudCompact', compact)
  publishState()
  return compact
}

/**
 * Size the window to exactly the height the renderer measured, clamped to
 * something that still fits on screen. This is the only thing that ever changes
 * the HUD's size, so the content can never be clipped and no empty band can
 * appear below it.
 */
function fitHeight(contentHeight: number): number | null {
  if (!hudWin || hudWin.isDestroyed()) return null

  const workArea = screen.getDisplayMatching(hudWin.getBounds()).workArea
  const maxHeight = Math.max(MIN_HEIGHT, Math.floor(workArea.height * 0.8))
  const target = Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT, contentHeight)))

  const [, current] = hudWin.getContentSize()
  // A 1px difference is rounding noise; acting on it would oscillate.
  if (Math.abs(current - target) > 1) {
    // A non-resizable window drops the platform's resize border, and whether
    // `setContentSize` still lands on it is platform-dependent. Lifting the
    // flag for the duration of the call is synchronous, so there is no frame in
    // which the user could grab an edge.
    hudWin.setResizable(true)
    hudWin.setContentSize(HUD_WIDTH, target)
    hudWin.setResizable(false)
    store.set('hudBounds', hudWin.getBounds())
  }
  return target
}

/**
 * The HUD sits on top of a full-screen game, so by default it lets the pointer
 * reach the game underneath: only the strips the renderer reports as
 * interactive - the title row and the controls - actually take clicks.
 * `forward` is what makes that workable: the window keeps receiving move events
 * while ignoring clicks, which is how the renderer can tell when the pointer
 * has arrived over one of those strips and ask for the events back.
 */
function setIgnoreMouse(ignore: boolean): boolean {
  if (!hudWin || hudWin.isDestroyed()) return false
  hudWin.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined)
  return ignore
}

/**
 * Dragging, driven from here rather than by the OS.
 *
 * `-webkit-app-region: drag` does not work on this window (user-reported with a
 * real mouse; synthetic verification is impossible here - injected events never
 * reach this overlay's DOM at all). Rather than chase which of transparent /
 * frameless / click-through / `setIgnoreMouseEvents` toggling breaks the OS
 * hit-test, dragging is driven manually: it needs nothing but DOM pointer
 * events, which demonstrably arrive (the header's buttons work). The renderer
 * reports pointer-down on the title row, and this follows the real cursor until
 * it reports the release.
 *
 * The offset is captured once at the start; each tick just re-anchors the
 * window to the cursor. The pointer therefore stays over the title row for the
 * whole drag, which also keeps the passthrough hook holding the mouse events.
 */
let dragOffset: { dx: number; dy: number } | null = null

/** Lets the pollers stand down while a drag is in flight - see index.ts. */
export function isHudDragging(): boolean {
  return dragOffset !== null
}

function startManualDrag(): void {
  if (!hudWin || hudWin.isDestroyed()) return
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = hudWin.getPosition()
  dragOffset = { dx: cursor.x - x, dy: cursor.y - y }
}

/**
 * One position update per renderer pointermove.
 *
 * Event-driven rather than a timer on purpose: a 16ms interval here beat
 * against the 16ms focus poll (each tick a synchronous native call), and two
 * timers contending for the main loop is exactly what a stuttering drag looks
 * like. Pointer events arrive at the mouse's own cadence and cost one
 * fire-and-forget IPC each.
 */
function moveManualDrag(): void {
  if (!hudWin || hudWin.isDestroyed() || !dragOffset) return
  // The event is only the trigger; the coordinates come from the same source
  // the offset was captured from. Renderer `screenX/Y` would work at 100%
  // display scaling and drift at any other - two coordinate systems, one drag.
  const at = screen.getCursorScreenPoint()
  hudWin.setPosition(at.x - dragOffset.dx, at.y - dragOffset.dy)
}

function endManualDrag(): void {
  if (!dragOffset) return
  dragOffset = null
  // The resting place is worth keeping; every intermediate frame was not.
  if (hudWin && !hudWin.isDestroyed()) store.set('hudBounds', hudWin.getBounds())
}

/**
 * Show/hide has to work while a full-screen game holds focus, which rules out
 * clicking the tray or the HUD's own button.
 */
function registerHudShortcuts(): void {
  if (shortcutsRegistered) return
  const accelerator = 'Alt+Shift+H'
  const registered = globalShortcut.register(accelerator, () => toggleHudVisibility())
  // A shortcut already taken by another app simply fails; the HUD still works
  // through the tray, so this is a warning rather than a startup failure.
  if (!registered) console.warn(`[HUD] global shortcut unavailable: ${accelerator}`)
  app.on('will-quit', () => globalShortcut.unregisterAll())
  shortcutsRegistered = true
}

const shouldShow =
  typeof store.get('settings.hudShow') === 'boolean'
    ? (store.get('settings.hudShow') as boolean)
    : true

export function createHudWindow(): BrowserWindow {
  if (hudWin && !hudWin.isDestroyed()) return hudWin

  const wa = screen.getPrimaryDisplay().workArea
  const saved = store.get('hudBounds')

  hudWin = new BrowserWindow({
    // Only the position is restored. The size is not the user's to keep: the
    // width is fixed and the height is re-measured on every layout change, so
    // a stale saved size would just show as a wrong first frame.
    x: saved?.x ?? wa.x + wa.width - 420,
    y: saved?.y ?? wa.y + 100,
    width: HUD_WIDTH,
    // Only avoids a visible jump before the renderer reports its measured
    // content height; `fitHeight` owns it from then on.
    height: saved?.height ?? 224,
    frame: false,
    resizable: false,
    movable: true,
    vibrancy: 'hud',
    show: false,
    maximizable: false,
    fullscreenable: false,
    // On Windows this maps to WS_EX_TOOLWINDOW, which is also what keeps the
    // HUD out of Alt-Tab - without it, every Alt-Tab pass has to step over a
    // dead overlay entry, which reads as the switcher being stuck on it.
    skipTaskbar: true,
    thickFrame: false,
    backgroundColor: '#00000000',
    // Not a user setting. The HUD is shown without activation while the game is
    // the active window, so staying above it is the whole mechanism - a switch
    // whose off position hides the HUD behind a fullscreen game is not a
    // feature. Overlays in this genre do the same: Hearthstone Deck Tracker
    // exposes "hide when the game is in the background", never a pin.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (is.dev && process.env['OPEN_DEVTOOLS'] === '1') hudWin.webContents.openDevTools()

  // A transparent frameless window otherwise hides renderer failures completely.
  // Mirror its diagnostics to the dev terminal so a blank HUD is actionable.
  // The positional-argument form of this listener is deprecated in Electron 35
  // and warns on every run; the details object replaces it. Its `level` is a
  // name rather than the old 0-3 number, so these lines now read
  // `[HUD console:warning]` instead of `[HUD console:2]`.
  hudWin.webContents.on('console-message', (details) => {
    console.log(
      `[HUD console:${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`
    )
  })
  hudWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[HUD load failed] ${errorCode} ${errorDescription} (${validatedURL})`)
  })
  hudWin.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[HUD renderer gone] ${details.reason}`)
  })

  hudWin.hide()

  // Branch on "is there a dev server", not on "are we packaged" - those are not
  // the same question, and the gap between them is a third mode that does
  // exist: an unpackaged build with no dev server, which is what `pnpm start`
  // and the e2e harness both run. The old `app.isPackaged` form sent that mode
  // down the dev branch and loaded `"undefined/hud.html"`, so the HUD never
  // came up and said so only as `[HUD load failed] -300 ERR_INVALID_URL`. The
  // `!` on the env var is what kept the typechecker quiet about it.
  //
  // This mirrors how the main window picks its URL in `main/index.ts`.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    hudWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/hud.html`)
  } else {
    // `loadFile` over a hand-built `file://` string: it resolves the path
    // itself, so a Windows drive letter or a space in the install directory
    // cannot turn into a malformed URL.
    hudWin.loadFile(path.join(__dirname, '../renderer/hud.html'))
  }

  hudWin.setVisibleOnAllWorkspaces(true)
  hudWin.setOpacity(store.get('hudOpacity') ?? 0.85)
  hudWin.setAlwaysOnTop(true, 'screen-saver')

  // 移動時保存位置（尺寸由 fitHeight 決定，不隨使用者操作改變）
  hudWin.on('moved', () => {
    // electron-store writes the config file SYNCHRONOUSLY. A native drag fires
    // this once, at the end; the manual drag's setPosition fires it on every
    // frame, and one blocking disk write per frame is a drag that stutters.
    // The manual drag saves once itself, on release.
    if (dragOffset) return
    store.set('hudBounds', hudWin!.getBounds())
  })

  hudWin.on('closed', () => {
    cancelPendingHide()
    hudWin = null
  })

  const forceRepaint = (): void => {
    if (!hudWin || hudWin.isDestroyed()) return
    const b = hudWin.getBounds()
    hudWin.setBounds(b)
  }
  hudWin.webContents.once('did-finish-load', () => {
    forceRepaint()
    // Click-through from the first frame: until the renderer has seen a pointer
    // move it cannot know where the interactive strips are, and a HUD that eats
    // clicks meant for the game is worse than one that misses its own.
    setIgnoreMouse(true)
    // While following the game the first poll owns this, a second from now;
    // showing here would flash the HUD over the desktop on every launch.
    if (shouldShow && store.get('settings.hudFollowGame') === false) {
      hudWin!.showInactive()
    }
  })
  hudWin.setHasShadow(true)
  hudWin.on('show', forceRepaint)
  hudWin.on('restore', forceRepaint)
  hudWin.on('focus', forceRepaint)

  // ---- IPC（避免重複註冊）----
  if (!ipcRegistered) {
    // 若曾經註冊過，先移除（保險）
    ipcMain.removeHandler('hud:setOpacity')
    ipcMain.removeHandler('hud:setCompact')
    ipcMain.removeHandler('hud:getState')
    ipcMain.removeHandler('hud:setContentHeight')
    ipcMain.removeHandler('hud:setIgnoreMouse')
    ipcMain.removeHandler('hud:show')
    ipcMain.removeHandler('hud:hide')
    ipcMain.removeHandler('hud:close')
    ipcMain.removeAllListeners('hud:dragMove')

    ipcMain.handle('hud:setOpacity', (_e, v: number) => {
      if (!hudWin) return
      const val = Math.min(1, Math.max(0.2, v))
      hudWin.setOpacity(val)
      store.set('hudOpacity', val)
      return val
    })
    ipcMain.handle('hud:setCompact', (_e, compact: boolean) => setCompact(compact))
    ipcMain.handle('hud:getState', () => getHudState())
    ipcMain.handle('hud:setContentHeight', (_e, height: number) =>
      Number.isFinite(height) ? fitHeight(height) : null
    )
    ipcMain.handle('hud:setIgnoreMouse', (_e, ignore: boolean) => setIgnoreMouse(ignore !== false))
    ipcMain.handle('hud:show', () => setVisibility(true))
    ipcMain.handle('hud:hide', () => setVisibility(false))
    ipcMain.handle('hud:close', () => hudWin?.close())
    ipcMain.handle('hud:dragStart', () => startManualDrag())
    // fire-and-forget: a drag position has no reply worth waiting a round trip for
    ipcMain.on('hud:dragMove', () => moveManualDrag())
    ipcMain.handle('hud:dragEnd', () => endManualDrag())

    ipcRegistered = true
  }

  registerHudShortcuts()

  return hudWin
}
