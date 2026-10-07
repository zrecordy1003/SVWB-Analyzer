/**
 * Cross-device sync in the real app: two profiles, one Worker.
 *
 * `tests/main/syncEndToEnd.test.ts` runs the client logic against the Worker's
 * code with a stand-in for Electron. What it cannot show is that the pieces that
 * only exist inside Electron do their part: the preload bridge and the typed IPC
 * handlers, `safeStorage`, the database worker (transactions, `VACUUM INTO`,
 * `ATTACH`, the triggers firing in a real second process), and the Settings
 * page. So this launches the real app twice - two fresh profiles, which is what
 * two machines are - against the REAL Worker router served over HTTP from this
 * process, backed by SQLite and a Map.
 *
 * Only Google and the browser are stood in for. `shell.openExternal` is replaced
 * in the main process by something that records the URL; this file then does what
 * the browser would (follow the Worker's redirect to a fake Google, come back
 * through `/auth/callback`, land on the app's real loopback listener).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

import { test, expect } from './app'
import { handle } from '../../server/sync/src/router'
import { world, type World } from '../server/sync/helpers'
import type { SyncStatus, SyncEnableResult } from '../../src/shared/sync'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

let w: World
let server: Server
let origin = ''

test.beforeAll(async () => {
  w = await world()
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    // The Worker and the fake Google share one clock object; keep it on real time
    // so tokens are issued and judged on the same one the app is looking at.
    w.clock.t = Date.now()
    const response = await handle(
      w.deps,
      new Request(`${origin}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body
      })
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // The fixture reads `process.env` when it launches the app, which is after
  // this hook, so this is how the app under test learns where "Google sign-in"
  // lives. An unpackaged build has no sync endpoint without it.
  // The fake Google insists on the redirect URI the unit tests use. The Worker
  // builds the real one from the request's origin (here a random local port), so
  // translate on the way out rather than loosening the fake.
  const googleFetch = w.deps.fetch
  w.deps.fetch = ((url, init) => {
    if (typeof init?.body === 'string' && String(url).includes('/token')) {
      const form = new URLSearchParams(init.body)
      if (form.get('redirect_uri') === `${origin}/auth/callback`) {
        form.set('redirect_uri', 'https://sync.test/auth/callback')
        return googleFetch(url, { ...init, body: form.toString() })
      }
    }
    return googleFetch(url, init)
  }) as typeof w.deps.fetch
  process.env.SVWB_SYNC_URL = origin
})

test.afterAll(async () => {
  delete process.env.SVWB_SYNC_URL
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function invoke<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    ([ch, a]) =>
      (
        window as unknown as {
          electron: { ipcRenderer: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }
        }
      ).electron.ipcRenderer.invoke(ch as string, ...(a as unknown[])) as Promise<T>,
    [channel, args] as const
  )
}

/** Replace the browser-opening call so the test can play the browser. */
async function captureOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      g.__opened.push(url)
    }
  })
}

/** The user's side of Google sign-in. */
async function playBrowser(app: ElectronApplication, sub: string): Promise<void> {
  let url: string | undefined
  for (let i = 0; i < 100 && !url; i++) {
    url = await app.evaluate(() =>
      (globalThis as unknown as { __opened: string[] }).__opened.at(-1)
    )
    if (!url) await new Promise((r) => setTimeout(r, 100))
  }
  if (!url) throw new Error('the app never tried to open the browser')

  const start = await fetch(url, { redirect: 'manual' })
  const google = new URL(start.headers.get('location')!)
  w.clock.t = Date.now()
  const code = await w.google.issueCode({ sub, nonce: google.searchParams.get('nonce')! })
  const callback = await fetch(
    `${origin}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(google.searchParams.get('state')!)}`,
    { redirect: 'manual' }
  )
  const back = callback.headers.get('location')!
  if (process.env.E2E_VERBOSE) console.log('callback ->', back, start.status, callback.status)
  await fetch(back) // the app's own loopback listener
}

async function signIn(
  app: ElectronApplication,
  window: Page,
  sub: string
): Promise<SyncEnableResult> {
  await captureOpenExternal(app)
  const pending = invoke<SyncEnableResult>(window, 'sync:signIn')
  await playBrowser(app, sub)
  return pending
}

async function recordMatch(window: Page, note: string): Promise<void> {
  await invoke(window, 'matches:create', {
    my_class: 'witch',
    oppo_class: 'bishop',
    play_order: 'first',
    result: true,
    note
  })
}

const notesOf = async (window: Page): Promise<string[]> => {
  const rows = await invoke<Array<{ note: string | null }>>(window, 'matches:getPage', {})
  return rows.map((r) => r.note ?? '').sort()
}

test('Settings shows the sync section, offering Google sign-in', async ({ window }) => {
  // The title bar's account button is the same sign-in, one click from anywhere.
  await expect(window.getByRole('button', { name: '使用 Google 登入' }).first()).toBeEnabled()
  await window.getByRole('button', { name: '設定', exact: true }).click()
  const panel = window.getByRole('main')
  await expect(panel.getByText('跨裝置同步')).toBeVisible()
  // beforeAll points this build at a server, so the switch is real, not the "not available" note.
  await expect(panel.getByRole('button', { name: '使用 Google 登入' })).toBeVisible()
})

test('sign in on one profile, restore on a second, and an edit travels back', async ({
  app,
  window
}) => {
  test.setTimeout(180_000)

  // ---- machine A: has a game, signs in, it goes up
  await recordMatch(window, '電腦 A 的一場')
  const first = await signIn(app, window, '1000000001')
  expect(first.status.lastError).toBeNull()
  expect(first.needsChoice).toBe(false)
  expect(first.status).toMatchObject({ signedIn: true, enabled: true })
  expect(w.bucket.keys().length).toBeGreaterThan(0)

  // The credential is on disk encrypted, not in the database: the settings
  // page never sees the token, only who is signed in.
  const status = await invoke<SyncStatus>(window, 'sync:status')
  expect(status.email).toBeTruthy()

  // ---- machine B: a second app on a fresh profile
  const userDataDir = mkdtempSync(join(tmpdir(), 'svwb-e2e-sync-b-'))
  const env = { ...process.env, SVWB_SYNC_URL: origin } as Record<string, string>
  const appB = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: PROJECT_ROOT,
    env,
    timeout: 60_000
  })
  try {
    let windowB: Page | undefined
    for (let i = 0; i < 300 && !windowB; i++) {
      windowB = appB.windows().find((p) => p.url().includes('renderer/index.html'))
      if (!windowB) await new Promise((r) => setTimeout(r, 100))
    }
    if (!windowB) throw new Error('second window never appeared')
    await windowB.waitForFunction(() =>
      Boolean((window as unknown as { electron?: { ipcRenderer?: unknown } }).electron?.ipcRenderer)
    )

    expect(await notesOf(windowB)).toEqual([])
    const restored = await signIn(appB, windowB, '1000000001')
    expect(restored.needsChoice).toBe(false) // nothing here to ask about
    expect(restored.status.enabled).toBe(true)
    expect(await notesOf(windowB)).toEqual(['電腦 A 的一場'])

    // ---- an edit on B reaches A
    const [row] = await invoke<Array<{ id: number }>>(windowB, 'matches:getPage', {})
    await invoke(windowB, 'matches:updateNote', row.id, '從電腦 B 改的')
    const afterB = await invoke<SyncStatus>(windowB, 'sync:syncNow')
    expect(afterB.lastError).toBeNull()
    expect(afterB.pending).toBe(0)

    const afterA = await invoke<SyncStatus>(window, 'sync:syncNow')
    expect(afterA.lastError).toBeNull()
    expect(await notesOf(window)).toEqual(['從電腦 B 改的'])
    expect(await notesOf(windowB)).toEqual(['從電腦 B 改的'])

    // ---- and signing out leaves everything on the machine
    const out = await invoke<SyncStatus>(windowB, 'sync:signOut')
    expect(out).toMatchObject({ signedIn: false, enabled: false })
    expect(await notesOf(windowB)).toEqual(['從電腦 B 改的'])
  } finally {
    await appB.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
