/**
 * The auto-update flow: check, optionally download, prompt to install.
 *
 * Three rules shape everything here.
 *
 * The user is only interrupted when there is genuinely a new version to
 * install. A background check that finds nothing, or fails because the machine
 * is offline, says nothing at all - it used to open a dialog either way, so
 * anyone with 自動檢查更新 on got a popup on every single launch.
 *
 * An update must not eat the user's bandwidth. That is what differential
 * download is for, so the settings that would silently defeat it are written
 * out explicitly rather than left to defaults.
 *
 * And the whole flow has to be testable without publishing a release. In dev
 * the real updater is replaced by a simulator (see `wireSimulator`) that drives
 * the exact same channels, so every phase - including the ones you cannot
 * reach from a packaged build sitting on the latest version - can be looked at
 * in `pnpm dev`.
 */
import { app, BrowserWindow } from 'electron'
import { store } from './store.js'
import type { ReleaseNote, UpdateProgress, UpdateSource, UpdateSummary } from '../shared/updates.js'
import { handleIpc } from './ipc/typed.js'

let wired = false

/** Emitter shared by the real updater and the dev simulator. */
type Send = (channel: string, payload?: Record<string, unknown>) => void

/**
 * GitHub hands us the release body as HTML. Rather than ship markup to the
 * renderer and make it decide how much of it to trust, flatten it here: list
 * items become bullets, block ends become newlines, everything else goes.
 */
function toPlainText(html: string): string {
  return (
    html
      .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|li|h[1-6]|div|tr)\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#3[49];/g, "'")
      // Last, so a literally-escaped entity does not get decoded twice.
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * `releaseNotes` is a string for a single release and an array when
 * `fullChangelog` is on - and null whenever the release body was left empty.
 */
type RawReleaseNotes = string | Array<{ version: string; note: string | null }> | null | undefined

function normalizeReleaseNotes(raw: RawReleaseNotes, version: string): ReleaseNote[] {
  if (raw == null) return []
  if (typeof raw === 'string') {
    const body = toPlainText(raw)
    return body ? [{ version, body }] : []
  }
  return raw
    .map((entry) => ({ version: entry.version, body: toPlainText(entry.note ?? '') }))
    .filter((entry) => entry.body.length > 0)
}

/** The renderer names its own surface; anything unrecognised is the background. */
function asSource(value: unknown): UpdateSource {
  return value === 'settings' ? 'settings' : 'background'
}

function toSummary(info: any): UpdateSummary {
  const version = String(info?.version ?? '')
  return {
    version,
    releaseDate: info?.releaseDate,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes, version),
    size: info?.files?.[0]?.size
  }
}

export async function setupAutoUpdates(win: BrowserWindow): Promise<void> {
  if (wired) return
  wired = true

  // `SVWB_UPDATE_SIM=real` opts a dev run into the real updater against
  // `dev-app-update.yml`; anything else in dev gets the simulator.
  const scenario = process.env.SVWB_UPDATE_SIM
  if (!app.isPackaged && scenario !== 'real') {
    wireSimulator(win, scenario)
    return
  }

  const pkg = await import('electron-updater')
  const { autoUpdater } = pkg.default ?? pkg

  /** The surface that owns the check or download currently in flight. */
  let source: UpdateSource = 'background'

  const send: Send = (channel, payload = {}) => {
    if (!win.isDestroyed()) win.webContents.send(channel, { source, ...payload })
  }

  if (!app.isPackaged) {
    // Reads dev-app-update.yml instead of the resources/app-update.yml that
    // only exists inside an installed build.
    autoUpdater.forceDevUpdateConfig = true
  }

  // Downloading is always our call (see the 'update-available' handler), so
  // that "auto download" is a decision we can read, gate and log - rather than
  // a flag buried in electron-updater that fires before we see the event.
  autoUpdater.autoDownload = false

  // Notes for every version the user skipped, not just the newest release's.
  autoUpdater.fullChangelog = true

  // This app publishes one NSIS installer and no web installer. Saying so
  // silences a warning, and keeps the web-installer branch of NsisUpdater -
  // which skips the differential path entirely - unreachable.
  autoUpdater.disableWebInstaller = true

  // The bandwidth story in one line. The NSIS installer copies itself to
  // %LOCALAPPDATA%\svwb-analyzer-updater\installer.exe at install time, and
  // electron-updater diffs the new release against that file via the published
  // .blockmap, so an update transfers the changed blocks instead of ~90MB.
  // It is on by default; it is written out because turning it off would cost
  // every user a full download and nothing would visibly break.
  autoUpdater.disableDifferentialDownload = false

  // When the differential path fails for any reason - a missing .blockmap on
  // the old release, a cache without installer.exe - electron-updater falls
  // back to a full download and says so only through its logger. Without one
  // wired up, the single most expensive thing this module can do to a user is
  // also the thing it reports least.
  autoUpdater.logger = {
    info: (m) => console.log('[Update]', m),
    warn: (m) => console.warn('[Update]', m),
    error: (m) => console.error('[Update]', m),
    debug: () => {}
  }

  autoUpdater.on('checking-for-update', () => send('update:checking'))

  autoUpdater.on('update-available', (info) => {
    const autoDownload = store.get('settings.autoDownloadUpdates') === true
    send('update:available', { info: toSummary(info), autoDownload })
    // The renderer stays quiet while this runs and speaks up on
    // 'update-downloaded' instead: with auto-download on, the only thing worth
    // interrupting for is an update that is ready to install.
    if (autoDownload) {
      autoUpdater.downloadUpdate().catch((e) => {
        console.log('[Update] auto download failed:', e)
      })
    }
  })

  autoUpdater.on('update-not-available', (info) =>
    send('update:none', { version: String(info?.version ?? '') })
  )
  autoUpdater.on('error', (err) => send('update:error', { error: String(err) }))
  autoUpdater.on('download-progress', (p) =>
    send('update:progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    send('update:downloaded', { info: toSummary(info) })
  )

  // ---- IPC（Renderer 主動控制）----
  handleIpc('update:check', async (_e, from: UpdateSource) => {
    source = asSource(from)
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, info: r?.updateInfo }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  })

  handleIpc('update:download', async (_e, from: UpdateSource) => {
    source = asSource(from)
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  })

  handleIpc('update:install', async () => {
    try {
      setImmediate(() => autoUpdater.quitAndInstall(false, true))
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  })

  // 開 app 幾秒後自動檢查一次（不阻塞首屏）
  //
  // `checkForUpdates()` 回的是 promise，所以 try/catch 接不到它的 rejection —
  // 舊寫法在任何一次檢查失敗（離線、latest.yml 404）時都是 unhandled rejection，
  // 只是平常看不到而已。錯誤本身已經由上面的 'error' 事件送給 renderer 了，
  // 這裡只需要讓 promise 不要炸出去。
  if (store.get('settings.autoCheckUpdates') === true)
    setTimeout(() => {
      source = 'background'
      autoUpdater.checkForUpdates().catch((e) => {
        console.log('[Update] background check failed:', e)
      })
    }, 2000)
}

/* ------------------------------------------------------------------ */
/* Dev simulator                                                       */
/* ------------------------------------------------------------------ */

const SIM_NOTES = `<h3>新增</h3><ul><li>分析器新增第二張圖表，兩個頁面都會填滿視窗。</li><li>對局列表的篩選移到共用工具列。</li></ul><h3>修正</h3><ul><li>更新檢查在沒有新版時不再彈窗。</li><li>自動更新失敗不再產生 unhandled rejection。</li></ul>`

const SIM_NOTES_OLDER = `<ul><li>引擎二進位檔改為可攜式。</li><li>重寫因此失效的文件。</li></ul>`

/**
 * Stands in for electron-updater in `pnpm dev`, driving the same channels with
 * the same payloads.
 *
 * The point is the phases a packaged build cannot show you: a dev build is
 * always on the version it was built from, so "an update is available",
 * "downloading at 37%" and "the download failed" are otherwise only reachable
 * by publishing a release. Pick one with `SVWB_UPDATE_SIM`:
 *
 *   available (default) - a small differential-sized download
 *   big                 - a full ~92MB download, for watching the progress UI
 *   none                - already up to date
 *   error               - the check fails
 *   download-error      - the check succeeds, the download fails midway
 *   real                - not simulated at all; use dev-app-update.yml
 *
 * Set it to run the check automatically on launch as well; without it, nothing
 * happens until 檢查更新 is pressed, so ordinary dev runs stay quiet.
 */
function wireSimulator(win: BrowserWindow, scenario: string | undefined): void {
  const mode = scenario ?? 'available'
  let source: UpdateSource = 'background'
  let timers: NodeJS.Timeout[] = []

  const send: Send = (channel, payload = {}) => {
    if (!win.isDestroyed()) win.webContents.send(channel, { source, ...payload })
  }
  const later = (ms: number, fn: () => void): void => {
    timers.push(setTimeout(fn, ms))
  }
  const clearTimers = (): void => {
    timers.forEach(clearTimeout)
    timers = []
  }

  const summary: UpdateSummary = {
    version: '9.9.9',
    releaseDate: new Date().toISOString(),
    releaseNotes: normalizeReleaseNotes(
      [
        { version: '9.9.9', note: SIM_NOTES },
        { version: '9.9.8', note: SIM_NOTES_OLDER }
      ],
      '9.9.9'
    ),
    size: 91_863_326
  }

  // 'available' mimics a differential download - a few MB, which is what a real
  // update between two adjacent releases actually transfers. 'big' is the
  // fallback-to-full-download case.
  const totalBytes = mode === 'big' ? 91_863_326 : 4_812_544

  const runDownload = (): void => {
    clearTimers()
    const tickMs = 120
    const steps = mode === 'big' ? 60 : 28
    for (let i = 1; i <= steps; i++) {
      later(tickMs * i, () => {
        if (mode === 'download-error' && i === Math.floor(steps / 2)) {
          clearTimers()
          send('update:error', { error: 'net::ERR_CONNECTION_RESET (simulated)' })
          return
        }
        const transferred = Math.round((totalBytes / steps) * i)
        send('update:progress', {
          percent: (i / steps) * 100,
          transferred,
          total: totalBytes,
          bytesPerSecond: Math.round(totalBytes / steps / (tickMs / 1000))
        } satisfies UpdateProgress)
        if (i === steps) send('update:downloaded', { info: summary })
      })
    }
  }

  const runCheck = (): void => {
    clearTimers()
    send('update:checking')
    later(700, () => {
      if (mode === 'none') {
        send('update:none', { version: app.getVersion() })
        return
      }
      if (mode === 'error') {
        send('update:error', { error: 'ENOTFOUND api.github.com (simulated)' })
        return
      }
      const autoDownload = store.get('settings.autoDownloadUpdates') === true
      send('update:available', { info: summary, autoDownload })
      if (autoDownload) runDownload()
    })
  }

  handleIpc('update:check', async (_e, from: UpdateSource) => {
    source = asSource(from)
    runCheck()
    return { ok: true }
  })

  handleIpc('update:download', async (_e, from: UpdateSource) => {
    source = asSource(from)
    runDownload()
    return { ok: true }
  })

  handleIpc('update:install', async () => {
    console.log('[Update][sim] quitAndInstall() - no-op in dev')
    return { ok: true }
  })

  console.log(
    `[Update][sim] dev updater active (scenario: ${mode}). ` +
      `Set SVWB_UPDATE_SIM to one of available|big|none|error|download-error|real.`
  )

  // Only run on launch when a scenario was asked for explicitly, so a plain
  // `pnpm dev` is not interrupted by an update dialog every time.
  if (scenario != null && store.get('settings.autoCheckUpdates') === true) {
    later(2000, () => {
      source = 'background'
      runCheck()
    })
  }
}
