/**
 * Everything the settings page can ask of sync, and the timers that keep it going.
 *
 * This is the only place that knows about sign-in, the on/off switch, the
 * first-login question, back-off, and the schedule. `engine.ts` runs a round;
 * this decides whether to, and what to tell the user about how it went.
 *
 * Rules it keeps, each of which is a stated requirement of the plan:
 *
 *   - Failure is never loud and never blocking. A round that fails records a
 *     line for the settings page and changes nothing else; the app, the engine
 *     and every screen work exactly as they would offline.
 *   - It only runs when the user has turned it on. Signing in alone does not
 *     start it, because the first run may rewrite local data and the user has
 *     to be asked first (J-1).
 *   - Sync is not polled. It runs once after launch, shortly after a match
 *     finishes, when local changes are waiting, on a slow heartbeat, and when
 *     asked. The ceiling on requests per account is what keeps the free tier
 *     alive, so the schedule is part of the cost model, not an optimisation.
 */
import path from 'node:path'

import { nowMs } from '../data/db/client.js'
import { syncOnce, peekRemote, recordError, type SyncReport } from './engine.js'
import {
  KEY_ENABLED,
  KEY_INITIALISED,
  KEY_LAST_ERROR,
  KEY_LAST_SYNC_AT,
  KEY_NEEDS_UPDATE,
  ensureDeviceId,
  getNumber,
  getState,
  setState,
  type Db
} from './ledger.js'
import {
  APPLY_BACKUP_REASON,
  BACKUP_DIR_NAME,
  backUp,
  hasLocalMatches,
  listBackups,
  resetLedger,
  restoreBackup,
  seedOutbox,
  wipeLocal
} from './lifecycle.js'
import { pendingCount } from './push.js'
import { Session } from './auth.js'
import { HttpTransport, SyncError, errorFrom, type Transport } from './transport.js'
import type {
  SyncAccountInfo,
  SyncBackup,
  SyncDevice,
  SyncEnableResult,
  SyncFirstChoice,
  SyncStatus
} from '../../shared/sync.js'

const KEY_ACCOUNT_EMAIL = 'accountEmail'
const KEY_BACKOFF_UNTIL = 'backoffUntil'
const KEY_LAST_APPLY_BACKUP = 'lastApplyBackup'
/** A pre-apply backup at most this often: a VACUUM of a large database is not free. */
export const APPLY_BACKUP_GAP_MS = 6 * 60 * 60_000

/** After launch, once everything else has settled. */
export const FIRST_SYNC_DELAY_MS = 30_000
/** The slow heartbeat: picks up other machines' changes while the app stays open. */
export const HEARTBEAT_MS = 60 * 60_000
/** How often to look at whether local changes are waiting. A local query, never a request. */
export const WATCH_MS = 2 * 60_000
/** Automatic rounds are never closer together than this. Manual ones ignore it. */
export const MIN_GAP_MS = 5 * 60_000
/** After a match: late enough to batch a session's worth. */
export const AFTER_MATCH_MS = 60_000
/** What to wait when a 503/429 does not say how long. */
const DEFAULT_BACKOFF_S = 3600

export interface ServiceDeps {
  db(): Db
  session: Session
  /** Overridable so tests can swap the HTTP layer; production uses `HttpTransport` over `session.request`. */
  transport?: () => Transport
  /** Where backups go (userData/sync-backup). */
  backupDir(): string
  configured(): boolean
  memoryOnlyCredentials(): boolean
  /** Tell open windows to refetch: called after a round that changed local rows. */
  notifyChanged(): void
  /** After the first restore onto an empty machine: fetch the card pool (J-4). */
  afterRestore?(): Promise<void>
  /** Where "export my data" is written; null means the user cancelled. */
  chooseExportPath?(): Promise<string | null>
  writeFile?(file: string, data: string): Promise<void>
  now?(): number
}

export class SyncService {
  private running: Promise<SyncReport | null> | null = null
  private lastAttemptAt = 0
  private timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = []
  private afterMatchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: ServiceDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : nowMs()
  }

  private transport(): Transport {
    return this.deps.transport
      ? this.deps.transport()
      : new HttpTransport(this.deps.session.request)
  }

  // ------------------------------------------------------------------ status

  async status(): Promise<SyncStatus> {
    const db = this.deps.db()
    const creds = await this.deps.session.credentials()
    const enabled = (await getState(db, KEY_ENABLED)) === '1' && creds !== null
    const lastSync = await getNumber(db, KEY_LAST_SYNC_AT, 0)
    const backoff = await getNumber(db, KEY_BACKOFF_UNTIL, 0)
    return {
      configured: this.deps.configured(),
      signedIn: creds !== null,
      email: creds?.email ?? null,
      enabled,
      syncing: this.running !== null,
      lastSyncAt: lastSync > 0 ? lastSync : null,
      lastError: await getState(db, KEY_LAST_ERROR),
      pending: await pendingCount(db),
      needsUpdate: (await getState(db, KEY_NEEDS_UPDATE)) === '1',
      backoffUntil: backoff > this.now() ? backoff : null,
      memoryOnlyCredentials: creds !== null && this.deps.memoryOnlyCredentials(),
      deviceId: await getState(db, 'deviceId')
    }
  }

  // ------------------------------------------------------------- signing in

  /** Open the browser, wait for the user, and move straight on to turning sync on. */
  async signIn(): Promise<SyncEnableResult> {
    const credentials = await this.deps.session.signIn()
    const db = this.deps.db()
    // A different Google account than last time: the old ledger describes
    // someone else's devices and cursors, and reusing it would skip data.
    const previous = await getState(db, KEY_ACCOUNT_EMAIL)
    if (previous !== null && previous !== credentials.email) {
      await resetLedger(db)
    }
    await setState(db, KEY_ACCOUNT_EMAIL, credentials.email)
    await setState(db, KEY_LAST_ERROR, null)
    return this.enable()
  }

  async signOut(): Promise<SyncStatus> {
    this.stopTimers()
    await this.deps.session.signOut()
    await setState(this.deps.db(), KEY_ENABLED, null)
    return this.status()
  }

  // ----------------------------------------------------------- the switch

  /**
   * Turn sync on.
   *
   * The first time, on a machine that already has games while the cloud also
   * has some, this stops and asks (J-1): merging is two-way, so this machine's
   * test data would not just stay here, it would be pushed and scattered to
   * every other device. Everything that rewrites local rows is preceded by a
   * backup.
   */
  async enable(choice?: SyncFirstChoice): Promise<SyncEnableResult> {
    const db = this.deps.db()
    if (!(await this.deps.session.isSignedIn())) {
      throw new SyncError(401, 'revoked', '尚未登入')
    }
    await ensureDeviceId(db)

    if ((await getState(db, KEY_INITIALISED)) !== '1') {
      let remote: { hasData: boolean }
      try {
        remote = await peekRemote(this.transport())
      } catch (e) {
        // Signed in, but the server is not answering (or is switched off): say
        // so in the usual quiet way, and stay off. Nothing local was touched, and
        // turning it on again later asks the same question from the start.
        await this.recordFailure(e)
        return { needsChoice: false, status: await this.status() }
      }
      const localHas = await hasLocalMatches(db)

      if (remote.hasData && localHas && choice === undefined) {
        return { needsChoice: true, status: await this.status() }
      }
      if (localHas) await backUp(db, this.deps.backupDir(), 'before-first-sync')

      const restoring = remote.hasData && !localHas
      if (choice === 'cloud') {
        await wipeLocal(db)
        await resetLedger(db)
      } else {
        await seedOutbox(db)
      }
      await setState(db, KEY_INITIALISED, '1')
      await setState(db, KEY_ENABLED, '1')
      // The first round applies the whole cloud. It has either just been backed up
      // above (this machine had games) or there was nothing here to lose, so a
      // second copy of the same database would only be noise in the list.
      await setState(db, KEY_LAST_APPLY_BACKUP, String(this.now()))
      await this.syncNow({ manual: true })
      if ((restoring || choice === 'cloud') && this.deps.afterRestore) {
        // Best effort, and not awaited: the card pool is a big download and the
        // restore has already worked without it - decks just have no art yet.
        void this.deps.afterRestore().catch(() => undefined)
      }
    } else {
      await setState(db, KEY_ENABLED, '1')
      await this.syncNow({ manual: true })
    }
    this.startTimers()
    return { needsChoice: false, status: await this.status() }
  }

  async disable(): Promise<SyncStatus> {
    this.stopTimers()
    await setState(this.deps.db(), KEY_ENABLED, null)
    return this.status()
  }

  // ------------------------------------------------------------------ rounds

  /** One round, now. Never throws: the outcome is in the returned status. */
  async syncNow(opts: { manual?: boolean } = {}): Promise<SyncStatus> {
    await this.round(opts.manual === true)
    return this.status()
  }

  /**
   * Single-flight, decided synchronously: the check and the claim happen before
   * the first `await`, so two callers in the same tick cannot both get past it.
   */
  private round(manual: boolean): Promise<SyncReport | null> {
    if (this.running) return this.running
    const run = this.doRound(manual).finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }

  private async doRound(manual: boolean): Promise<SyncReport | null> {
    const db = this.deps.db()
    const creds = await this.deps.session.credentials()
    if (!creds || (await getState(db, KEY_ENABLED)) !== '1') return null
    if (!this.deps.configured()) return null

    if (!manual) {
      const backoff = await getNumber(db, KEY_BACKOFF_UNTIL, 0)
      if (backoff > this.now()) return null
      if (this.now() - this.lastAttemptAt < MIN_GAP_MS && this.lastAttemptAt !== 0) return null
    }

    this.lastAttemptAt = this.now()
    try {
      const deviceId = await ensureDeviceId(db)
      const report = await syncOnce(db, this.transport(), {
        deviceId,
        beforeApply: () => this.backUpBeforeApply()
      })
      await setState(db, KEY_BACKOFF_UNTIL, null)
      if (report.applied.applied + report.applied.deleted + report.applied.mergedByName > 0) {
        this.deps.notifyChanged()
      }
      return report
    } catch (e) {
      await this.recordFailure(e)
      return null
    }
  }

  /**
   * The safety net under every merge, until the rules have a track record: take a
   * copy of the database before remote changes are applied - but not before every
   * one, since copying a large database each time would cost more than the risk.
   */
  private async backUpBeforeApply(): Promise<void> {
    const db = this.deps.db()
    const last = await getNumber(db, KEY_LAST_APPLY_BACKUP, 0)
    if (this.now() - last < APPLY_BACKUP_GAP_MS) return
    await backUp(db, this.deps.backupDir(), APPLY_BACKUP_REASON)
    await setState(db, KEY_LAST_APPLY_BACKUP, String(this.now()))
  }

  private async recordFailure(e: unknown): Promise<void> {
    const db = this.deps.db()
    if (e instanceof SyncError) {
      if (e.needsSignIn) {
        await this.deps.session.forget()
        await setState(db, KEY_ENABLED, null)
        await recordError(
          db,
          '登入已失效（可能在另一台裝置被撤銷），請重新登入。本機資料完全沒有動。'
        )
        return
      }
      if (e.shouldBackOff) {
        // The server asked us to go away. That is not an error worth showing in
        // red: sync is optional and the app is unaffected.
        const wait = (e.retryAfterSeconds ?? DEFAULT_BACKOFF_S) * 1000
        await setState(db, KEY_BACKOFF_UNTIL, String(this.now() + wait))
        await recordError(db, '同步服務暫時不可用，稍後會自動重試。')
        return
      }
      if (e.code === 'quota') {
        await recordError(db, '雲端空間已滿（100 MB），新的變更暫時無法上傳。')
        return
      }
      await recordError(db, e.message)
      return
    }
    await recordError(db, e instanceof Error ? e.message : String(e))
  }

  // ---------------------------------------------------------------- timers

  startTimers(): void {
    this.stopTimers()
    const first = setTimeout(() => void this.round(false), FIRST_SYNC_DELAY_MS)
    const heartbeat = setInterval(() => void this.round(false), HEARTBEAT_MS)
    // The watcher is the only thing that notices a hand-edit or an engine
    // write; it asks the local database a question and sends nothing unless the
    // answer is yes, so it costs no requests.
    const watch = setInterval(() => void this.roundIfPending(), WATCH_MS)
    for (const t of [first, heartbeat, watch]) t.unref?.()
    this.timers = [first, heartbeat, watch]
  }

  private async roundIfPending(): Promise<void> {
    if ((await pendingCount(this.deps.db())) > 0) await this.round(false)
  }

  /** Call when a match finishes: a sync soon, batched with whatever else happens in the next minute. */
  noteMatchFinished(): void {
    if (this.afterMatchTimer) clearTimeout(this.afterMatchTimer)
    this.afterMatchTimer = setTimeout(() => {
      this.afterMatchTimer = null
      void this.round(false)
    }, AFTER_MATCH_MS)
    this.afterMatchTimer.unref?.()
  }

  stopTimers(): void {
    for (const t of this.timers) {
      clearTimeout(t as ReturnType<typeof setTimeout>)
      clearInterval(t as ReturnType<typeof setInterval>)
    }
    this.timers = []
    if (this.afterMatchTimer) clearTimeout(this.afterMatchTimer)
    this.afterMatchTimer = null
  }

  /** At launch: resume if the user left it on. */
  async resume(): Promise<void> {
    const db = this.deps.db()
    if ((await getState(db, KEY_ENABLED)) === '1' && (await this.deps.session.isSignedIn())) {
      this.startTimers()
    }
  }

  // ------------------------------------------------------- account and data

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.deps.session.request(path, init)
    if (!res.ok) throw await errorFrom(res)
    return (await res.json()) as T
  }

  async account(): Promise<SyncAccountInfo | null> {
    if (!(await this.deps.session.isSignedIn())) return null
    return this.json<SyncAccountInfo>('/v1/me')
  }

  async devices(): Promise<SyncDevice[]> {
    if (!(await this.deps.session.isSignedIn())) return []
    const body = await this.json<{ devices: SyncDevice[] }>('/v1/devices')
    return body.devices
  }

  async revokeDevice(id: string): Promise<SyncDevice[]> {
    const res = await this.deps.session.request(`/v1/devices/${encodeURIComponent(id)}/revoke`, {
      method: 'POST'
    })
    if (!res.ok) throw await errorFrom(res)
    return this.devices()
  }

  /** Delete the cloud copy and sign out. Local data is untouched - it is what the user keeps. */
  async deleteAccount(): Promise<SyncStatus> {
    const res = await this.deps.session.request('/v1/account/delete', { method: 'POST' })
    if (!res.ok) throw await errorFrom(res)
    this.stopTimers()
    await this.deps.session.forget()
    const db = this.deps.db()
    await resetLedger(db)
    await setState(db, KEY_ACCOUNT_EMAIL, null)
    return this.status()
  }

  /** Save everything the cloud holds for this account as one file. Returns where, or null if cancelled. */
  async exportAccount(): Promise<string | null> {
    const file = await this.deps.chooseExportPath?.()
    if (!file) return null
    const res = await this.deps.session.request('/v1/account/export')
    if (!res.ok) throw await errorFrom(res)
    await (this.deps.writeFile ?? defaultWrite)(file, await res.text())
    return file
  }

  // -------------------------------------------------------------- rollback

  async backups(): Promise<SyncBackup[]> {
    return listBackups(this.deps.backupDir())
  }

  /** Put the database back as it was before a merge, and stop syncing. */
  async rollback(file: string): Promise<SyncStatus> {
    // Only files this folder holds: the path comes from the renderer.
    const dir = path.resolve(this.deps.backupDir())
    const target = path.resolve(file)
    if (path.dirname(target) !== dir) throw new Error('not a sync backup')
    this.stopTimers()
    const db = this.deps.db()
    // Not pruned: the backup being restored may be the oldest of three.
    await backUp(db, dir, 'before-rollback', { prune: false })
    await restoreBackup(db, target)
    this.deps.notifyChanged()
    return this.status()
  }
}

async function defaultWrite(file: string, data: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, data, 'utf8')
}

export const backupDirFor = (userData: string): string => path.join(userData, BACKUP_DIR_NAME)
