/**
 * Signing in, and staying signed in.
 *
 * The Worker does the OAuth (it holds Google's secret); this side runs the
 * browser round trip and keeps the Worker's own tokens. Contract and the reasons
 * for it: `docs/sync-protocol.md` and the 身分 section of the plan.
 *
 *   app                       browser                  Worker
 *    | listen on 127.0.0.1:PORT
 *    | openExternal --------> /auth/start?port&challenge&state ---> Google
 *    |                                                 <--- code ---'
 *    | <----------- 302 127.0.0.1:PORT/cb?grant&state --'
 *    | POST /v1/auth/token {grant, verifier, device...}  --> tokens
 *
 * PKCE sits between the app and the Worker: the grant is useless without the
 * verifier, which never left this process, so another program on the machine
 * that sees the loopback redirect cannot trade it for a session.
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type { CredentialStore, Credentials } from './credentials.js'
import { SyncError, errorFrom, type AuthedFetch } from './transport.js'

/** How long the browser round trip may take before we give up listening. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000

export interface SessionDeps {
  /** The Worker's origin, or null when this build has none. */
  endpoint(): string | null
  fetch: typeof fetch
  store: CredentialStore
  openExternal(url: string): Promise<void>
  /** This machine's id in the sync database. Also what the server knows the device as. */
  deviceId(): Promise<string>
  deviceName(): string
  appVersion(): string
  now(): number
  signInTimeoutMs?: number
}

interface AccessToken {
  token: string
  expiresAt: number
}

export class Session {
  private access: AccessToken | null = null
  private refreshing: Promise<AccessToken> | null = null

  constructor(private readonly deps: SessionDeps) {}

  async credentials(): Promise<Credentials | null> {
    return this.deps.store.load()
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.credentials()) !== null
  }

  private origin(): string {
    const endpoint = this.deps.endpoint()
    if (!endpoint) throw new SyncError(0, 'not_configured', '這個版本沒有設定同步伺服器')
    return endpoint
  }

  // ------------------------------------------------------------- signing in

  async signIn(): Promise<Credentials> {
    const origin = this.origin()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('base64url')

    const listener = await listenOnce(state, this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS)
    try {
      const url = new URL('/auth/start', origin)
      url.searchParams.set('port', String(listener.port))
      url.searchParams.set('challenge', challenge)
      url.searchParams.set('state', state)
      await this.deps.openExternal(url.toString())
      const grant = await listener.result
      return await this.exchange(origin, grant, verifier)
    } finally {
      listener.close()
    }
  }

  private async exchange(origin: string, grant: string, verifier: string): Promise<Credentials> {
    const deviceId = await this.deps.deviceId()
    const res = await this.deps.fetch(`${origin}/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant,
        verifier,
        deviceId,
        deviceName: this.deps.deviceName(),
        appVersion: this.deps.appVersion()
      })
    })
    if (!res.ok) throw await errorFrom(res)
    const body = (await res.json()) as {
      accessToken: string
      accessExpiresAt: number
      refreshToken: string
      account: { email: string; name: string | null }
    }
    const credentials: Credentials = {
      refreshToken: body.refreshToken,
      email: body.account.email,
      name: body.account.name ?? null,
      deviceId
    }
    await this.deps.store.save(credentials)
    this.access = { token: body.accessToken, expiresAt: body.accessExpiresAt }
    return credentials
  }

  // ------------------------------------------------------------ staying in

  /** A valid access token, refreshing first if it is about to lapse. Concurrent callers share one refresh. */
  async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - this.deps.now() > EXPIRY_MARGIN_MS) {
      return this.access.token
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return (await this.refreshing).token
  }

  private async refresh(): Promise<AccessToken> {
    const origin = this.origin()
    const credentials = await this.deps.store.load()
    if (!credentials) throw new SyncError(401, 'revoked', '尚未登入')
    const res = await this.deps.fetch(`${origin}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: credentials.refreshToken,
        deviceId: credentials.deviceId
      })
    })
    if (!res.ok) {
      const error = await errorFrom(res)
      // The server says this sign-in is over (revoked from another device,
      // retired, or never heard of): holding the token any longer only means
      // retrying with something that cannot work.
      if (error.needsSignIn) {
        this.access = null
        await this.deps.store.clear()
      }
      throw error
    }
    const body = (await res.json()) as {
      accessToken: string
      accessExpiresAt: number
      refreshToken: string
    }
    // Rotated: the old refresh token is dead the moment this response is sent,
    // so the new one must be stored before anything else can fail.
    await this.deps.store.save({ ...credentials, refreshToken: body.refreshToken })
    this.access = { token: body.accessToken, expiresAt: body.accessExpiresAt }
    return this.access
  }

  /** `fetch` against the Worker with the bearer token, retrying once if the token had just expired. */
  readonly request: AuthedFetch = async (path, init = {}) => {
    const origin = this.origin()
    const send = async (): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${await this.accessToken()}`)
      return this.deps.fetch(`${origin}${path}`, { ...init, headers })
    }
    const first = await send()
    if (first.status !== 401) return first
    // Only an `expired` 401 is worth a retry; a revoked one will say so on the
    // refresh and raise the right error from there.
    const peek = await first
      .clone()
      .json()
      .catch(() => null)
    if ((peek as { error?: string } | null)?.error !== 'expired') return first
    this.access = null
    return send()
  }

  // ------------------------------------------------------------- signing out

  /** Tell the server this device is done, then forget everything. A network failure does not stop the forgetting. */
  async signOut(): Promise<void> {
    if (this.deps.endpoint() && (await this.deps.store.load())) {
      await this.request('/v1/auth/logout', { method: 'POST' }).catch(() => undefined)
    }
    this.access = null
    await this.deps.store.clear()
  }

  /** Forget locally without telling anyone: the account was deleted, or the server already revoked us. */
  async forget(): Promise<void> {
    this.access = null
    await this.deps.store.clear()
  }
}

// ------------------------------------------------------------ the loopback

interface Listener {
  port: number
  /** Resolves with the grant, rejects on error/timeout/state mismatch. */
  result: Promise<string>
  close(): void
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32em;margin:4em auto;padding:0 1em">` +
  `<h2>${title}</h2><p>${body}</p></body>`

/**
 * One-shot HTTP listener on 127.0.0.1 for the redirect.
 *
 * Bound to the loopback interface only and to an OS-chosen port, answers
 * exactly one request path, and closes after the first valid callback. The
 * `state` is compared so a redirect that did not originate from OUR
 * `/auth/start` (another page poking the port) is refused.
 */
function listenOnce(state: string, timeoutMs: number): Promise<Listener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle: { resolve(grant: string): void; reject(e: Error): void }
    const result = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject }
    })
    // Never an unhandled rejection if nobody awaits it (e.g. openExternal failed first).
    result.catch(() => undefined)

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/cb') {
        res.writeHead(404).end()
        return
      }
      const reply = (status: number, html: string): void => {
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        res.end(html)
      }
      if (url.searchParams.get('state') !== state) {
        reply(400, PAGE('無法登入', '這個登入要求不是由 SVWB Analyzer 發起的，已忽略。'))
        return
      }
      const error = url.searchParams.get('error')
      const grant = url.searchParams.get('grant')
      if (error || !grant) {
        reply(200, PAGE('登入未完成', '你可以關閉這個分頁，回到 SVWB Analyzer 再試一次。'))
        settle.reject(new SyncError(0, error ?? 'cancelled', '登入未完成'))
        return
      }
      reply(200, PAGE('登入完成', '你可以關閉這個分頁，回到 SVWB Analyzer。'))
      settle.resolve(grant)
    })

    const timer = setTimeout(() => {
      settle.reject(new SyncError(0, 'timeout', '等不到瀏覽器的登入回應'))
    }, timeoutMs)
    timer.unref?.()

    server.once('error', rejectListener)
    server.listen(0, '127.0.0.1', () => {
      resolveListener({
        port: (server.address() as AddressInfo).port,
        result,
        close: () => {
          clearTimeout(timer)
          server.close()
          server.closeAllConnections?.()
        }
      })
    })
  })
}
