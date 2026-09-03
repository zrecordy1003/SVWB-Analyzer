/**
 * The anonymous usage upload: when it runs, what it sends, and the IPC the
 * settings page drives it with.
 *
 * Three rules, in order of importance.
 *
 * Nothing leaves a machine that has not been told. Since 1.3.0
 * `settings.telemetry` defaults to TRUE and an existing install is flipped to
 * true once (`telemetryDefaultFlipped` in store.ts), so the notice - not the
 * setting - is what keeps the promise: `performUpload` refuses while
 * `telemetryPromptShown` is false, and `telemetry:noticeDue` is the only thing
 * that sets it. A build with no endpoint configured sends nothing whatever the
 * setting says, and shows no notice either.
 *
 * (This paragraph used to say the setting defaulted to false. It did until
 * 2026-09-02; the code moved and the comment did not. Default-on is a
 * participation decision - a buried opt-in switch gets single-digit uptake and
 * a matchup table built from single digits is worse than no table - and it is
 * NOT a licence to send before saying so.)
 *
 * It can never hurt the app. Every network path here swallows its own
 * failure, records it for the settings page, and moves on. No upload is ever
 * awaited by startup, a window, or the engine.
 *
 * It sends counts, not records. `rollup.ts` is the only thing that reads
 * match rows on this path, and the settings page shows its output verbatim
 * before the switch is flipped. If a field is not in `TelemetryPayload`, it
 * does not leave the machine.
 *
 * Scheduling: one upload shortly after launch, one every few hours while the
 * app stays open, and one a while after a match finishes so the day's counts
 * do not wait for the next launch. The server replaces the whole window on
 * every upload, so none of these need to know about the others.
 */
import { app, BrowserWindow, ipcMain, net } from 'electron'
import { randomUUID } from 'node:crypto'
import { getDb, nowMs } from '../data/db/client.js'
import { store } from '../store.js'
import {
  TELEMETRY_SCHEMA,
  type TelemetryIngestResponse,
  type TelemetryPayload,
  type TelemetryStatus
} from '../../shared/telemetry.js'
import { telemetryEndpoint } from './config.js'
import { rollup, windowStartMs, type RollupRow } from './rollup.js'

/** Let startup finish first: splash, engine, card pool bootstrap. */
const FIRST_UPLOAD_DELAY_MS = 20_000
/** Long-running sessions still show up as active once a day at least. */
const PERIODIC_MS = 6 * 60 * 60_000
/** After a match: soon, but late enough to coalesce a whole session. */
const AFTER_MATCH_DELAY_MS = 10 * 60_000
/** Right after the switch is turned on. Long enough for the toast to settle. */
const ENABLE_DELAY_MS = 3_000
/** Two uploads closer than this are one upload; the second is dropped. */
const MIN_GAP_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000

const KEY_INSTALL_ID = 'installId'
const KEY_LAST_UPLOAD_AT = 'lastUploadAt'
const KEY_LAST_ERROR = 'lastError'

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Tests swap these; production reads Electron. */
type Deps = {
  fetch: FetchLike
  now: () => number
  endpoint: () => string | null
  environment: () => Pick<TelemetryPayload, 'appVersion' | 'platform' | 'arch' | 'locale'>
}

const productionDeps: Deps = {
  fetch: (url, init) => net.fetch(url, init),
  now: () => Date.now(),
  endpoint: telemetryEndpoint,
  environment: () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale()
  })
}

let deps: Deps = productionDeps

export function configureTelemetryForTests(overrides: Partial<Deps> | null): void {
  deps = overrides ? { ...productionDeps, ...overrides } : productionDeps
  clearTimers()
  lastUploadStartedAt = 0
}

// ------------------------------------------------------------------- state

async function readState(key: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom('TelemetryState')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
  return row?.value ?? null
}

async function writeState(key: string, value: string | null): Promise<void> {
  const db = getDb()
  if (value === null) {
    await db.deleteFrom('TelemetryState').where('key', '=', key).execute()
    return
  }
  await db
    .insertInto('TelemetryState')
    .values({ key, value, updatedAt: nowMs() })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updatedAt: nowMs() }))
    .execute()
}

/**
 * The install id, minted on first use.
 *
 * Only ever called on a path that is about to upload or about to show the
 * user what an upload would contain - never at startup - so an install that
 * keeps telemetry off never has one.
 */
async function ensureInstallId(): Promise<string> {
  const held = await readState(KEY_INSTALL_ID)
  if (held) return held
  const minted = randomUUID()
  await writeState(KEY_INSTALL_ID, minted)
  return minted
}

export function isTelemetryEnabled(): boolean {
  return store.get('settings.telemetry') === true
}

/**
 * Whether the one-time notice has been shown on this install.
 *
 * Since 1.3.0 the setting defaults to on, which makes this the thing that
 * keeps the promise: a machine that has not been told what is being sent, and
 * how to stop it, sends nothing. Default-on is a participation decision;
 * sending before saying so would be a different thing entirely.
 *
 * It is set when the notice is handed to a window, not when the user dismisses
 * it - an ignored notice is still a notice, and requiring a click would put us
 * back at opt-in participation rates under a different name.
 */
function noticeShown(): boolean {
  return store.get('telemetryPromptShown') === true
}

// ----------------------------------------------------------------- payload

async function readWindowRows(now: number): Promise<RollupRow[]> {
  return getDb()
    .selectFrom('Match')
    .select([
      'result',
      'play_order',
      'my_class',
      'oppo_class',
      'mode',
      'playedAt',
      'source',
      'edited_fields',
      'recog_flags'
    ])
    .where('playedAt', '>=', windowStartMs(now))
    .execute()
}

/**
 * What an upload would send right now.
 *
 * `installId` is the real one when it exists and a placeholder otherwise, so
 * previewing does not mint an id for someone who then decides against it.
 */
export async function buildPayload(opts: { mintInstallId: boolean }): Promise<TelemetryPayload> {
  const now = deps.now()
  const installId = opts.mintInstallId
    ? await ensureInstallId()
    : ((await readState(KEY_INSTALL_ID)) ?? '(尚未產生：開啟後才會建立)')
  const rows = await readWindowRows(now)
  return {
    schema: TELEMETRY_SCHEMA,
    installId,
    ...deps.environment(),
    sentAt: new Date(now).toISOString(),
    days: rollup(rows, now)
  }
}

// ------------------------------------------------------------------ upload

let inFlight: Promise<void> | null = null
let lastUploadStartedAt = 0

/**
 * One upload. Resolves when it is over, successful or not; never rejects.
 *
 * `force` is the settings page's 立即上傳: it bypasses the minimum gap but not
 * the enabled check, the endpoint check or the notice check - there is no way
 * to send from a build that has nowhere to send to, and none to send from an
 * install that has not been told. (Pressing 立即上傳 means the user is looking
 * at the settings page, so the notice has long since been shown.)
 */
export async function uploadNow(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      await performUpload(opts.force === true)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

async function performUpload(force: boolean): Promise<void> {
  if (!isTelemetryEnabled()) return
  if (!noticeShown()) return
  const endpoint = deps.endpoint()
  if (!endpoint) return

  const now = deps.now()
  if (!force && now - lastUploadStartedAt < MIN_GAP_MS) return
  lastUploadStartedAt = now

  let payload: TelemetryPayload
  try {
    payload = await buildPayload({ mintInstallId: true })
  } catch (e) {
    await recordError(`本機讀取失敗：${(e as Error).message}`)
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await deps.fetch(`${endpoint}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (!res.ok) {
      await recordError(`伺服器回應 HTTP ${res.status}`)
      return
    }
    // The body is informational. A server that accepted the request but
    // refused some days is worth a log line, not a user-facing error.
    try {
      const body = (await res.json()) as Partial<TelemetryIngestResponse>
      if (body.rejected?.length) {
        console.warn('[Telemetry] server rejected days:', body.rejected)
      }
    } catch {
      /* not JSON; the 2xx already said what mattered */
    }
    await writeState(KEY_LAST_UPLOAD_AT, new Date(deps.now()).toISOString())
    await writeState(KEY_LAST_ERROR, null)
  } catch (e) {
    const message = (e as Error).name === 'AbortError' ? '連線逾時' : (e as Error).message
    await recordError(`連線失敗：${message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function recordError(message: string): Promise<void> {
  console.warn('[Telemetry]', message)
  try {
    await writeState(KEY_LAST_ERROR, message)
  } catch {
    /* if the database is the problem, there is nowhere to write the problem */
  }
}

// -------------------------------------------------------------- scheduling

let periodicTimer: NodeJS.Timeout | null = null
let pendingTimer: NodeJS.Timeout | null = null
let pendingAt = 0

function clearTimers(): void {
  if (periodicTimer) clearInterval(periodicTimer)
  if (pendingTimer) clearTimeout(pendingTimer)
  periodicTimer = null
  pendingTimer = null
  pendingAt = 0
}

/** Upload after `delayMs`, unless one is already due sooner. */
function scheduleIn(delayMs: number): void {
  if (!isTelemetryEnabled()) return
  const at = deps.now() + delayMs
  if (pendingTimer && pendingAt <= at) return
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingAt = at
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    pendingAt = 0
    void uploadNow()
  }, delayMs)
  // A timer must not keep the process alive on quit.
  pendingTimer.unref?.()
}

function startSchedule(): void {
  clearTimers()
  if (!isTelemetryEnabled()) return
  scheduleIn(FIRST_UPLOAD_DELAY_MS)
  periodicTimer = setInterval(() => void uploadNow(), PERIODIC_MS)
  periodicTimer.unref?.()
}

/** Called by the engine supervisor when a match closes. Cheap when off. */
export function noteMatchFinished(): void {
  scheduleIn(AFTER_MATCH_DELAY_MS)
}

async function setEnabled(enabled: boolean): Promise<void> {
  store.set('settings.telemetry', enabled)
  clearTimers()
  if (!enabled) return
  // The id is kept when telemetry is turned off, and reused when it comes
  // back: it is random and linked to nothing, and a fresh one on every toggle
  // would count the same machine twice.
  await ensureInstallId()
  scheduleIn(ENABLE_DELAY_MS)
  periodicTimer = setInterval(() => void uploadNow(), PERIODIC_MS)
  periodicTimer.unref?.()
}

export async function getStatus(): Promise<TelemetryStatus> {
  const endpoint = deps.endpoint()
  return {
    enabled: isTelemetryEnabled(),
    configured: endpoint !== null,
    endpoint,
    installId: await readState(KEY_INSTALL_ID),
    lastUploadAt: await readState(KEY_LAST_UPLOAD_AT),
    lastError: await readState(KEY_LAST_ERROR)
  }
}

// --------------------------------------------------------------------- ipc

export function registerTelemetryIpc(): void {
  ipcMain.handle('telemetry:status', () => getStatus())

  ipcMain.handle('telemetry:setEnabled', async (_e, enabled: unknown) => {
    await setEnabled(enabled === true)
    return getStatus()
  })

  ipcMain.handle('telemetry:preview', () => buildPayload({ mintInstallId: false }))

  ipcMain.handle('telemetry:uploadNow', async () => {
    await uploadNow({ force: true })
    return getStatus()
  })

  /**
   * Whether the one-time notice should show now. Marks it shown on the way
   * out, like `support:check`, so a reload cannot replay it - and because that
   * mark is what unblocks uploading, this is the only route by which anything
   * is ever sent.
   *
   * Not due when telemetry is already off: that user found the switch before
   * the notice appeared, and announcing 「已為你開啟」 to them would be false.
   * Not due when there is no endpoint either: a build that sends nowhere has
   * nothing to announce, and marking it shown would let a later build with an
   * endpoint upload without ever having said anything.
   */
  ipcMain.handle('telemetry:noticeDue', (event) => {
    if (!isTelemetryEnabled()) return false
    if (noticeShown()) return false
    if (deps.endpoint() === null) return false
    /**
     * Not due to a window nobody can see.
     *
     * `--hidden` (see `startedHidden` in index.ts) starts the app into the
     * tray with a renderer running behind it, and marking the notice shown
     * from there would tick the only box standing between this install and its
     * first upload for a notice that was never on screen.
     *
     * The check is HERE rather than in the renderer, and the first attempt at
     * it was not. `TelemetryPrompt` asked `document.hidden` first, which reads
     * as `false` inside a `show: false` window - Electron does not tie
     * document visibility to whether the window has been shown - so the guard
     * was inert and an e2e test is what said so. Asking the window itself, in
     * the same handler that does the marking, cannot be wrong about it and
     * cannot be bypassed by a renderer that forgets to ask.
     *
     * Refusing does not consume anything: the prompt asks again when the
     * window is shown (`window:shown`), and the next launch asks again anyway.
     */
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!senderWindow || !senderWindow.isVisible()) return false
    store.set('telemetryPromptShown', true)
    return true
  })
}

/** Called once at startup, after the database is open. Registers IPC and starts the timers. */
export function startTelemetry(): void {
  registerTelemetryIpc()
  startSchedule()
  const endpoint = deps.endpoint()
  if (isTelemetryEnabled() && !endpoint) {
    console.warn('[Telemetry] enabled but no endpoint is configured; nothing will be sent')
  }
}
