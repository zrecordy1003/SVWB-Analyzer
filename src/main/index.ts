import { app, shell, BrowserWindow, Notification, powerMonitor } from 'electron'
import path, { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { store } from './store.js'

// 輕依賴先載（重依賴延遲到用到才 import）
import { isGameWindowFocused, isShadowverseRunning } from './recognition/svwbDetector.js'
import { attachCapture, detachCapture } from './recognition/engine.js'

// DB 與更新延後：只載入 helper，初始化放到事件之後
import { initDatabase } from './data/db/initDb.js'
import { setupAutoUpdates } from './updates.js'
import { getBattleStatus, type BattleStatus } from './recognition/engine.js'
import type { GameStatus } from '../shared/types.js'
import { createHudWindow, hudCouldMove, isHudDragging, syncHudWithGame } from './windows/hud.js'
// import { attachCloseGuard } from './closeGuard.js'
import { createAppTray } from './windows/tray.js'
import { attachSmartClose } from './windows/smartClose.js'
import { openExitConfirmDialog } from './windows/exitConfirmDialog.js'
import { broadcast } from './utils/broadcast.js'
import { handleIpc, onIpc, onceIpc } from './ipc/typed.js'
import { registerCardImageProtocol, registerCardImageScheme } from './protocol/cardImageProtocol.js'

// Image recognition is handled by a self-contained Rust addon
// (tools/svwb-vision.node), so no OpenCV SDK paths or runtime DLLs are needed.

// --- 單例鎖 ---
/**
 * Launched by the login item, which asks for no window.
 *
 * `startOnBoot.ts` has always registered the login item with
 * `args: ['--hidden', '--auto-launch']`, and nothing ever read them: every
 * launch showed the splash and then the main window, so "start with Windows"
 * put a window in front of the user at every single login.
 *
 * It is read here rather than where the windows are created because two
 * separate decisions hang off it, and because it must be read from THIS
 * process's argv: a later launch arrives at the `second-instance` handler
 * below, where it means "the user opened the app again" and must show the
 * window whatever this run started as.
 */
const startedHidden = process.argv.includes('--hidden')

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  /**
   * The user launched the app again while it was already running.
   *
   * The lock was taken and the second process quit, but nothing told the first
   * one - so double-clicking the shortcut did nothing at all, silently. That
   * was a latent annoyance while every launch showed a window; with `--hidden`
   * it became the whole problem, because after a login the app sits in the
   * tray and the shortcut was the obvious way back in.
   *
   * `revealMainWindow` rather than the flag: whatever this run started as, a
   * second launch is an explicit request for the window.
   */
  app.on('second-instance', () => revealMainWindow())
}

// Has to happen at module scope: privileged scheme registration is only read
// once, before the app is ready.
registerCardImageScheme()

const MIN_SPLASH_MS = 800
// The main UI has a persistent navigation rail, a deck selector and data-heavy
// views. Below this size, controls start colliding rather than reflowing into a
// useful desktop layout.
const MAIN_WINDOW_MIN_WIDTH = 1100
const MAIN_WINDOW_MIN_HEIGHT = 700
let splashShownAt = 0

let tray: Electron.Tray | null = null
let mainWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let splash: BrowserWindow | null = null
let pollingTimer: NodeJS.Timeout | null = null
let pollingInFlight = false

// let isDirty = false
// let rememberNoAsk = false

// --- Analyzer 動態載入 ---
type GetBattleStatusFn = () => BattleStatus | Promise<BattleStatus>
type StartAnalyzerFn = (win: BrowserWindow) => void | Promise<void>
type StopAnalyzerFn = (opts?: { timeoutMs?: number }) => Promise<void> | void

let _getBattleStatus: GetBattleStatusFn | null = null
let _startAnalyzer: StartAnalyzerFn | null = null
let _stopAnalyzer: StopAnalyzerFn | null = null

async function ensureAnalyzer(): Promise<void> {
  if (_getBattleStatus && _startAnalyzer && _stopAnalyzer) return
  // The recognition pipeline now lives in `svwb-engine`; this module only
  // supervises it. Same three functions, so nothing else in this file changes.
  const mod = (await import('./recognition/engine.js')) as {
    getBattleStatus: GetBattleStatusFn
    startEngine: StartAnalyzerFn
    stopEngine: StopAnalyzerFn
  }
  _getBattleStatus = mod.getBattleStatus
  _startAnalyzer = mod.startEngine
  _stopAnalyzer = mod.stopEngine
}

// --- DB on-demand（第一次用到才 init） ---
// let dbReady = false
// async function ensureDbReady(): Promise<void> {
//   if (!dbReady) {
//     await initDatabase()
//     dbReady = true
//   }
// }

/**
 * Put the main window in front of the user, from wherever it was.
 *
 * Three calls, and all three are needed: `restore` for a minimised window,
 * `show` for one that was never shown or was hidden to the tray, and `focus`
 * because `show` on Windows does not always raise an existing window above
 * whatever is in front of it.
 */
function revealMainWindow(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return true
}

// --- 視窗建立 ---
function createSplash(): void {
  splash = new BrowserWindow({
    width: 360,
    // Sized to the content (238px at this width) plus a little air. It was 420,
    // which left a band of window above and below the panel - invisible while
    // the window was transparent, and the first thing you saw once it was not.
    height: 260,
    frame: false,
    // Opaque on purpose. This was `transparent: true`, and the splash's card
    // leaned on `backdrop-filter: blur()` to be readable - but a transparent
    // Electron window has nothing behind it to blur, so the card was a few
    // percent of white laid straight over the desktop and its near-black text
    // landed on whatever wallpaper happened to be there.
    resizable: false,
    // Painted before the HTML does, so the first frame is not a white flash.
    backgroundColor: '#0f1216',
    show: true,
    webPreferences: {
      // No preload. There never was one: `../preload/splash-preload.js` is not
      // built by any entry in `electron.vite.config.ts` and does not exist in
      // `out/preload/`, so Electron logged a load failure and carried on. The
      // splash is a static document that talks to nothing, so the fix is to
      // stop asking rather than to add a file.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  splashShownAt = Date.now()
  const splashPath = app.isPackaged
    ? path.join(process.resourcesPath, 'splash.html')
    : path.join(__dirname, '../../resources/splash.html')

  splash.loadFile(splashPath)
}

function createWindow(): void {
  // const wa = screen.getPrimaryDisplay().workArea
  const saved: { x?: number; y?: number; width: number; height: number } = store.get(
    'mainWindowBounds'
  ) ?? {
    width: 1450,
    height: 800
  }

  const defaultWidth = 1450
  const defaultHeight = 800

  mainWindow = new BrowserWindow({
    // ...saved,
    width: saved?.width ?? defaultWidth,
    height: saved?.height ?? defaultHeight,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    ...(saved.x && saved.y ? { x: saved.x, y: saved.y } : { center: true }),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    ...(process.platform === 'linux' ? { icon } : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      /**
       * Still off, and the reason is the file extension above.
       *
       * A sandboxed preload has to be CommonJS - Electron's ESM support
       * explicitly excludes them - and every preload entry here builds to
       * `.mjs` because the package is `"type": "module"`. So turning this on
       * is not a one-line flag: it means giving the preload build a CJS output
       * format for all three entries and re-verifying every bridge, including
       * `@electron-toolkit/preload`'s, under the sandbox's reduced module set.
       *
       * What has been done is the prerequisite: the preload no longer imports
       * a privileged module. `shell.openExternal` moved to the `app:openLink`
       * handler below, so what is left to check is the build format rather
       * than the code.
       */
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  /**
   * Anything that waits for the window to become visible hangs off this.
   *
   * `document.visibilityState` cannot answer it: inside a window created with
   * `show: false` it still reads `visible`, which is what made the first
   * version of the telemetry notice guard inert. So the window says it
   * instead, and it covers every route that reveals it - the startup show,
   * `revealMainWindow`, the tray, the HUD's history link.
   */
  mainWindow.on('show', () => broadcast('window:shown'))

  mainWindow.on('moved', () => store.set('mainWindowBounds', mainWindow!.getBounds()))
  mainWindow.on('resized', () => store.set('mainWindowBounds', mainWindow!.getBounds()))

  mainWindow.removeMenu()

  onceIpc('renderer:ready', () => {
    const elapsed = Date.now() - splashShownAt
    // Nothing to wait for when there is no splash to give a minimum life to.
    const wait = startedHidden ? 0 : Math.max(0, MIN_SPLASH_MS - elapsed)
    setTimeout(async () => {
      if (splash && !splash.isDestroyed()) {
        splash.close()
        splash = null
      }
      if (!startedHidden) mainWindow!.show()
      // 首繪後才做初始化
      // 背景準備
      // await ensureDbReady()
      // Analyzer 載入
      await ensureAnalyzer()
      // _startAnalyzer?.(mainWindow!)
      // 自動更新檢查
      setupAutoUpdates(mainWindow!)
      // 啟動遊戲輪詢
      startPollingForGame()
    }, wait)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // DevTools can consume a renderer and materially skew scrolling/performance
  // tests. Opt in explicitly when investigating rather than opening it for
  // every development run.
  if (is.dev && process.env['OPEN_DEVTOOLS'] === '1') mainWindow.webContents.openDevTools()

  hudWindow = createHudWindow()

  if (!tray) tray = createAppTray(mainWindow, app.exit)

  mainWindow.on('closed', () => {
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.close()
    }
    hudWindow = null
  })

  const shouldAskExit = (): boolean =>
    getBattleStatus().inBattle || store.get('settings.askBeforeExit') === true

  const confirmExit = async (): Promise<boolean> => {
    if (store.get('settings.askBeforeExit') === true) return true

    const { confirmed, remember } = await openExitConfirmDialog({
      parent: mainWindow!,
      appName: 'SVWB Analyzer',
      title: '確認關閉應用？',
      message: '你確定要關閉 SVWB Analyzer 嗎？',
      detail: '對戰進行中，關閉後將停止紀錄，本場記錄將被捨棄。',
      rememberLabel: '以後不要再詢問'
    })

    if (remember) store.set('settings.askBeforeExit', false)
    return confirmed
  }

  attachSmartClose(mainWindow, {
    shouldAskExit,
    confirmExit,
    onBeforeMinimize: () => {
      // 最小化時順便做的事（例如暫停 HUD 或停止擷取）
      // stopCapture()
    },
    onBeforeExitApproved: () => {
      // 真的要關時做收尾
      // stopCapture()
    }
  })
}

// 閒置秒數門檻（可改成從 settings 讀取）
const IDLE_THRESHOLD_SECONDS = 1800
// const IDLE_THRESHOLD_SECONDS = 10

async function isSystemIdle(thresholdSec: number): Promise<boolean> {
  const pm: any = powerMonitor as any
  try {
    // 新版 Electron：同步
    if (typeof pm.getSystemIdleState === 'function') {
      const state = pm.getSystemIdleState(thresholdSec) // 'active' | 'idle' | 'locked' | 'unknown'
      return state === 'idle' || state === 'locked'
    }
    // 舊版：回呼或 promise
    if (typeof pm.querySystemIdleState === 'function') {
      const state = await pm.querySystemIdleState(thresholdSec)
      return state === 'idle' || state === 'locked'
    }
    // 最後備援：用 idle time
    if (typeof pm.getSystemIdleTime === 'function') {
      const t = pm.getSystemIdleTime()
      return t >= thresholdSec
    }
  } catch (e) {
    console.log(e)
  }
  return false
}

/**
 * Latest broadcast game status, kept so a window that opens (or reloads) after
 * the last change can ask for it instead of waiting for the next transition.
 */
let lastGameStatus: GameStatus | null = null

/**
 * Foreground-focus ticker; see the comment where it is started. One frame at
 * 60Hz, so the HUD appears in the same frame the game takes focus.
 */
const FOCUS_POLL_MS = 16
let focusTimer: ReturnType<typeof setInterval> | null = null

// --- 遊戲狀態輪詢 ---
function startPollingForGame(): void {
  if (pollingTimer) return

  let isCapturing = false
  let isAnalyzerRunning = false
  let isSentMinimizedInfo = false
  let isSentIdleInfo = false

  // 上次「遊戲有在跑」的時間（不論最小化）
  let lastGameRunningAt: number | null = null
  // 上次「遊戲在跑且可擷取（未最小化、具有 bounds）」的時間
  let lastUnpausedAt: number | null = null

  const poll = async (): Promise<void> => {
    if (pollingInFlight) return
    pollingInFlight = true
    try {
      // Synchronous since the PowerShell round-trips were removed: this is now
      // a handle re-check, or at worst one window enumeration.
      const svwbStatus = isShadowverseRunning()
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed() || win.webContents?.isDestroyed()) return

      // 推送遊戲狀態給 UI
      if (svwbStatus) win.webContents.postMessage('svwb:status', svwbStatus)

      const now = Date.now()
      const isGameRunning = !!svwbStatus?.running
      const bx = svwbStatus?.bounds?.x
      const by = svwbStatus?.bounds?.y
      const hasBounds = typeof bx === 'number' && typeof by === 'number'
      const isMinimized = hasBounds && bx === -32000 && by === -32000

      // 「擷取」的暫停條件（和之前相同）：最小化 / 無 Bounds 視為不可擷取
      const treatAsPaused = isGameRunning && (!hasBounds || isMinimized)

      // The HUD is a separate window, so `win.webContents.send` below never
      // reaches it. Broadcast a compact status so the HUD can say *why* it has
      // nothing to show - "game not detected" and "no matches yet" look
      // identical otherwise, which is the worst message for a new user.
      // Only on change: this poll runs every second and the state rarely moves.
      const gameStatus: GameStatus = {
        running: isGameRunning,
        paused: treatAsPaused,
        capturing: isGameRunning && !treatAsPaused && svwbStatus?.hwnd != null
      }
      if (
        !lastGameStatus ||
        lastGameStatus.running !== gameStatus.running ||
        lastGameStatus.paused !== gameStatus.paused ||
        lastGameStatus.capturing !== gameStatus.capturing
      ) {
        lastGameStatus = gameStatus
        broadcast('game:status', gameStatus)
      }

      // 更新時間戳
      if (isGameRunning) lastGameRunningAt = now
      if (isGameRunning && !treatAsPaused) lastUnpausedAt = now

      // 閒置是否已超過 30 分鐘
      const idleTooLong = await isSystemIdle(IDLE_THRESHOLD_SECONDS) // 1800

      const THRESHOLD_MS = IDLE_THRESHOLD_SECONDS * 1000
      const gameClosedTooLong =
        !isGameRunning && lastGameRunningAt !== null && now - lastGameRunningAt >= THRESHOLD_MS
      const minimizedTooLong =
        isGameRunning && lastUnpausedAt !== null && now - lastUnpausedAt >= THRESHOLD_MS

      // ─────────────────────────────────────────────────
      // 擷取（Capture）：維持原本行為（最小化/隱藏就停，恢復就啟）
      // ─────────────────────────────────────────────────
      const hwnd = svwbStatus.hwnd
      const shouldCapture = isGameRunning && !treatAsPaused && hwnd !== null

      // No `battle:recog` send here or in the else branch any more. It carried
      // exactly `shouldCapture`, which is `gameStatus.capturing` above - so the
      // renderer was told the same fact twice, once change-gated with a
      // `game:getStatus` catch-up for a window that opens late, and once
      // unconditionally on every one-second tick. The second one is gone;
      // `BattleStatus` reads `game:status` like the HUD already did.
      if (shouldCapture) {
        // The engine owns capture now, so it must be up before the attach; the
        // attach itself is idempotent and re-sent every poll, which is also
        // what re-establishes capture after an engine restart.
        if (!isAnalyzerRunning) {
          await ensureAnalyzer()
          _startAnalyzer?.(win)
          isAnalyzerRunning = true
        }
        attachCapture(hwnd)
        if (!isCapturing) {
          isCapturing = true
          win.webContents.send('capture:status', true)
        }
      } else {
        if (isCapturing) {
          detachCapture()
          isCapturing = false
          win.webContents.send('capture:status', false)
        }
      }

      // 通知（只在第一次偵測到事件時提醒一次）
      if (isGameRunning) {
        if (isSentMinimizedInfo && !isMinimized && hasBounds) isSentMinimizedInfo = false
        if (!isSentMinimizedInfo && (isMinimized || !hasBounds)) {
          isSentMinimizedInfo = true
          store.get('settings.enableNotifications') === true &&
            new Notification({
              title: '［提醒］遊戲最小化 / 視窗不在前景',
              body: '已暫停擷取畫面，分析仍在待命；超過 30 分鐘會自動關閉。'
            }).show()
        }
      } else {
        isSentMinimizedInfo = false
      }

      if (isGameRunning) {
        if (isSentIdleInfo && !idleTooLong) isSentIdleInfo = false
        if (!isSentIdleInfo && idleTooLong) {
          isSentIdleInfo = true
          // new Notification({
          //   title: '［提醒］系統閒置已達 30 分鐘',
          //   body: '將自動關閉分析以節省資源。恢復操作或開啟遊戲時會再啟動。'
          // }).show()
        }
      } else {
        isSentIdleInfo = false
      }

      // ─────────────────────────────────────────────────
      // 分析（Analyzer）：只有「閒置≥30 分鐘」或「遊戲關閉≥30 分鐘」才關閉
      // 啟動時機仍保持「看到遊戲在跑」才啟動
      // ─────────────────────────────────────────────────
      const shouldStopAnalyzer = idleTooLong || gameClosedTooLong || minimizedTooLong

      if (shouldStopAnalyzer) {
        if (isAnalyzerRunning) {
          try {
            await _stopAnalyzer?.()
          } catch (e) {
            console.log(e)
          }
          isAnalyzerRunning = false
        }
      } else {
        // 未達關閉條件時：
        // 只有在「遊戲正在執行」且尚未啟動時，才啟動分析
        if (isGameRunning && !isAnalyzerRunning) {
          await ensureAnalyzer()
          _startAnalyzer?.(win)
          isAnalyzerRunning = true
        }
        // 遊戲關閉但尚未滿 30 分鐘 → 保持「暖機待命」
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Polling error:', msg)
    } finally {
      pollingInFlight = false
    }
  }

  void poll()
  pollingTimer = setInterval(() => void poll(), 1000)

  // Foreground checks run on their own, much faster timer: the HUD follows the
  // game's focus, and lag on an alt-tab is the one thing that would give away
  // that this is a separate window.
  //
  // Polling rather than `SetWinEventHook`, deliberately. The hook would be
  // instant and wake nothing, but it registers a *global* hook that any
  // anti-cheat on the machine can enumerate - and this app sits in the
  // background while the user plays other games. A read-only
  // `GetForegroundWindow` registers nothing, injects nothing and is what every
  // overlay and task manager on Windows already does. Sixteen milliseconds of
  // latency is not worth putting someone's other games at risk.
  //
  // The cost is measured, not assumed: 19.4us per call on a development
  // machine, so ~0.12% of one core. For scale, the game-detection `poll` below
  // shells out to PowerShell, which costs ~389ms per spawn.
  //
  // (node-window-manager's own `window-activated` event is itself a 50ms poll
  // of the same call, so subscribing to it would buy nothing here.)
  focusTimer = setInterval(() => {
    // The focus check is a synchronous native call; at 16ms it owns a real
    // share of the main loop. While the user is dragging the HUD, position
    // updates need that time more than focus tracking does - and mid-drag the
    // answer cannot change anything the drag would not override anyway.
    if (isHudDragging()) return
    // And nothing to track while the game is not running and the HUD is
    // already off screen: no focus change can move it until the 1s poll sees
    // the game again, so 62 native calls a second would be buying nothing.
    // The `hudCouldMove()` half is what still lets a running game's alt-tab
    // bring the HUD back, and what lets a hide finish after the game exits.
    if (!lastGameStatus?.running && !hudCouldMove()) return
    syncHudWithGame(isGameWindowFocused())
  }, FOCUS_POLL_MS)

  // 系統事件：睡眠/鎖定 → 只停擷取，不立即停分析（交給 30 分鐘門檻）
  powerMonitor.on('suspend', async () => {
    try {
      detachCapture()
    } catch (e) {
      console.log(e)
    }
  })
  powerMonitor.on('lock-screen', async () => {
    try {
      detachCapture()
    } catch (e) {
      console.log(e)
    }
  })

  app.once('quit', () => {
    if (pollingTimer) clearInterval(pollingTimer)
    pollingTimer = null
    if (focusTimer) clearInterval(focusTimer)
    focusTimer = null
  })
}

// --- App lifecycle ---
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('app.electron.svwb-analyzer')

  registerCardImageProtocol()

  await initDatabase()

  const { registerMatchesIpc } = await import('./ipc/matches.js')
  registerMatchesIpc()

  const { registerDecksIpc } = await import('./ipc/decks.js')
  registerDecksIpc()

  const { registerTagsIpc } = await import('./ipc/tags.js')
  registerTagsIpc()

  const { registerCardImagesIpc } = await import('./ipc/cardImages.js')
  registerCardImagesIpc()

  const { registerCardsIpc } = await import('./ipc/cards.js')
  registerCardsIpc()

  const { registerCardStatsIpc } = await import('./ipc/cardStats.js')
  registerCardStatsIpc()

  // Fill the card pool if we have never done it, so decks and the builder are
  // populated on first run instead of showing a button nobody knew to press.
  //
  // Deliberately NOT awaited: it is ~14 requests to somebody else's server, and
  // the window must not wait on them. It skips everything already held, so this
  // is a no-op from the second launch onwards, and a failure just means the
  // next launch tries again.
  void (async () => {
    const { bootstrapCardPool } = await import('./data/cardPoolBootstrap.js')
    const { getDb } = await import('./data/db/client.js')
    const lang = store.get('settings')?.cardLang ?? 'cht'
    await bootstrapCardPool(getDb(), lang).catch(() => {})
  })()

  const { registerDiagnosticsIpc } = await import('./ipc/diagnostics.js')
  registerDiagnosticsIpc()

  app.on('browser-window-created', (_e, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const { registerSettingsIpc } = await import('./ipc/settings.js')
  registerSettingsIpc()

  const { recordLaunch, registerSupportIpc } = await import('./support/supportPrompt.js')
  recordLaunch()
  registerSupportIpc()

  // Never awaited: it schedules its own first upload well after the window is
  // up, and nothing goes out before the one-time notice has been shown there.
  // See telemetry/telemetry.ts.
  const { startTelemetry } = await import('./telemetry/telemetry.js')
  startTelemetry()

  // These two stay here: they close over this file's analyzer accessor and the
  // last status the game poll broadcast, neither of which belongs in ipc/.
  handleIpc('battle:getStatus', async () => {
    await ensureAnalyzer()
    return _getBattleStatus?.()
  })

  // `game:status` is only broadcast on change, so a window that opens between
  // transitions needs to be able to ask.
  handleIpc('game:getStatus', () => lastGameStatus)

  // The HUD's "完整對戰歷史" link. Registered here rather than in windows/hud.ts
  // because this file is the only holder of the main window.
  handleIpc('hud:openMatchHistory', () => {
    if (!revealMainWindow()) return false
    mainWindow!.webContents.send('app:navigate', 'MatchList')
    return true
  })

  /**
   * The one bridge that can hand an arbitrary string to the OS shell.
   *
   * The validation used to live in the preload, which is why the preload had
   * to import `shell` - and importing `shell` is why the main window could not
   * run `sandbox: true`. A sandboxed preload gets `ipcRenderer`,
   * `contextBridge` and `webFrame` and nothing else, so the check moved here
   * and the preload now only forwards.
   *
   * Same rule as before, in the process that can actually enforce it: real web
   * links only, so no call site - or injected markup - can reach `file:`,
   * `javascript:` or a registered protocol handler.
   */
  handleIpc('app:openLink', (_e, url: unknown) => {
    if (typeof url !== 'string') return false
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    void shell.openExternal(parsed.toString())
    return true
  })

  // 停止 capture
  onIpc('stop-capture', () => detachCapture())

  // 建立視窗
  //
  // No splash on a hidden launch: it is a window, and the whole point of
  // `--hidden` is that a login does not put one on screen. The main window is
  // still created - the tray, the HUD and the engine all need a renderer - it
  // just never gets shown.
  if (!startedHidden) createSplash()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplash()
      createWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  detachCapture()
  try {
    await _stopAnalyzer?.()
  } catch (e) {
    console.log(e)
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  detachCapture()
  try {
    await _stopAnalyzer?.()
  } catch (e) {
    console.log(e)
  }
})
