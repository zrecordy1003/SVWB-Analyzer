/**
 * Cross-device sync, wired to Electron.
 *
 * `service.ts` holds the behaviour and takes everything Electron-shaped as a
 * dependency; this file is where those dependencies are supplied. It is also
 * the only file in the folder that imports `electron`, which is why the rest
 * can be tested without it.
 */
import { app, dialog, net, safeStorage, shell } from 'electron'
import os from 'node:os'
import path from 'node:path'

import { getDb } from '../data/db/client.js'
import { store } from '../store.js'
import { broadcast } from '../utils/broadcast.js'
import { handleIpc } from '../ipc/typed.js'
import { Session } from './auth.js'
import { syncEndpoint } from './config.js'
import { createFileCredentialStore } from './credentials.js'
import { ensureDeviceId } from './ledger.js'
import { SyncService, backupDirFor } from './service.js'
import { SyncError } from './transport.js'
import { recordError } from './engine.js'
import type { SyncEnableResult } from '../../shared/sync.js'

let service: SyncService | null = null

const AVATAR_MAX_BYTES = 300 * 1024

/**
 * A Google profile picture, as a data URL the renderer is allowed to show.
 *
 * Fetched here and not by the renderer because its CSP permits no remote images,
 * and that is worth keeping. The URL is checked again even though the Worker
 * already filtered it: this is the process that actually makes the request.
 */
async function fetchAvatarAsDataUrl(raw: string): Promise<string | null> {
  const url = new URL(raw)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:') return null
  if (host !== 'googleusercontent.com' && !host.endsWith('.googleusercontent.com')) return null
  const res = await net.fetch(url.toString(), { signal: AbortSignal.timeout(8000) })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || !type.startsWith('image/')) return null
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return null
  return `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`
}

function build(): SyncService {
  const credentials = createFileCredentialStore(
    path.join(app.getPath('userData'), 'sync-credentials.bin'),
    safeStorage
  )
  const session = new Session({
    endpoint: syncEndpoint,
    fetch: (url, init) => net.fetch(url as string, init as RequestInit),
    store: credentials,
    openExternal: (url) => shell.openExternal(url),
    deviceId: () => ensureDeviceId(getDb()),
    deviceName: () => os.hostname(),
    appVersion: () => app.getVersion(),
    now: () => Date.now()
  })
  return new SyncService({
    db: getDb,
    session,
    backupDir: () => backupDirFor(app.getPath('userData')),
    configured: () => syncEndpoint() !== null,
    memoryOnlyCredentials: () => !credentials.persistent,
    notifyChanged: () => {
      broadcast('matches:needRefetch')
      for (const scope of ['decks', 'tags', 'categories']) {
        broadcast('reference-data:changed', { scope })
      }
    },
    afterRestore: async () => {
      const { bootstrapCardPool } = await import('../data/cardPoolBootstrap.js')
      await bootstrapCardPool(getDb(), store.get('settings')?.cardLang ?? 'cht')
    },
    fetchAvatar: fetchAvatarAsDataUrl,
    chooseExportPath: async () => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '匯出雲端資料',
        defaultPath: `svwb-sync-export-${new Date().toISOString().slice(0, 10)}.jsonl`,
        filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
      })
      return canceled || !filePath ? null : filePath
    }
  })
}

export function getSyncService(): SyncService {
  service ??= build()
  return service
}

/** A match just finished: sync soon, batched with whatever else happens in the next minute. */
export function noteSyncMatchFinished(): void {
  service?.noteMatchFinished()
}

/**
 * A failure the user can read on the settings page rather than a rejected IPC
 * promise: sign-in in particular fails in ordinary ways (closed the tab, no
 * network) that are not exceptional.
 */
async function guarded(run: () => Promise<SyncEnableResult>): Promise<SyncEnableResult> {
  try {
    return await run()
  } catch (e) {
    const message =
      e instanceof SyncError && e.code === 'cancelled'
        ? '登入已取消'
        : e instanceof Error
          ? e.message
          : String(e)
    await recordError(getDb(), message)
    return { needsChoice: false, status: await getSyncService().status() }
  }
}

export function registerSyncIpc(): void {
  const s = getSyncService
  handleIpc('sync:status', () => s().status())
  handleIpc('sync:signIn', () => guarded(() => s().signIn()))
  handleIpc('sync:signOut', () => s().signOut())
  handleIpc('sync:enable', (_e, choice) => guarded(() => s().enable(choice)))
  handleIpc('sync:disable', () => s().disable())
  handleIpc('sync:syncNow', () => s().syncNow({ manual: true }))
  handleIpc('sync:account', () => s().account())
  handleIpc('sync:devices', () => s().devices())
  handleIpc('sync:revokeDevice', (_e, id) => s().revokeDevice(id))
  handleIpc('sync:deleteAccount', () => s().deleteAccount())
  handleIpc('sync:exportAccount', () => s().exportAccount())
  handleIpc('sync:backups', () => s().backups())
  handleIpc('sync:rollback', (_e, file) => s().rollback(file))
}

/** Called once at startup, after the database is open. */
export function startSync(): void {
  registerSyncIpc()
  void getSyncService().resume()
}
