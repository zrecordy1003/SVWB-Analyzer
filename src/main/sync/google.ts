/**
 * Signing in with Google, and staying signed in.
 *
 * The app talks to Google directly: a "Desktop app" OAuth client, the system
 * browser, a loopback redirect, PKCE. There is no server of ours in the middle -
 * the sync data lives in the user's own Google Drive (see `drive.ts`), so there
 * is nothing for a server to do.
 *
 *   app                          browser                        Google
 *    | listen on 127.0.0.1:PORT
 *    | openExternal ------------> accounts.google.com/...?code_challenge=...
 *    |                                                  <--- consent ---'
 *    | <----- 302 127.0.0.1:PORT/cb?code&state ---------'
 *    | POST token {code, code_verifier, client_id, client_secret} --> tokens
 *
 * PKCE is what protects the code: it is useless without the verifier, which
 * never left this process, so another program on the machine that sees the
 * loopback redirect cannot trade it for a session. The client secret that Google
 * issues for a desktop client is not a secret in the usual sense - it ships in
 * every copy of the app, and Google's own documentation says so - which is
 * exactly why PKCE, and not the secret, is what is relied on.
 *
 * The scope is `drive.appdata`: the app's own hidden folder in the user's Drive,
 * which Google classes as non-sensitive. Nothing else in the Drive is reachable.
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type { CredentialStore, Credentials } from './credentials.js'
import { SyncError } from './transport.js'

/** How long the browser round trip may take before we give up listening. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/**
 * Every request gives up after this long.
 *
 * `fetch` has no timeout of its own, and a round that is waiting on a socket that
 * never answers holds the sync service's single-flight slot forever: every later
 * round joins the stuck one, the settings page says 「同步中」 until the app is
 * restarted, and nothing ever reports an error. Thirty seconds is far longer than
 * a healthy request takes (segments are capped at 1 MB) and short enough that a
 * dead connection becomes an ordinary, retried failure.
 */
export const REQUEST_TIMEOUT_MS = 30_000
/** Refresh this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 60_000

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const SCOPES = ['openid', 'email', 'profile', DRIVE_APPDATA_SCOPE]

/** Where Google's endpoints are. Real ones by default; a local fake in tests and in development. */
export interface GoogleEndpoints {
  auth: string
  token: string
  revoke: string
  /** Drive REST base, e.g. `https://www.googleapis.com/drive/v3`. */
  drive: string
  /** Drive upload base, e.g. `https://www.googleapis.com/upload/drive/v3`. */
  upload: string
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3'
}

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  endpoints: GoogleEndpoints
}

export interface SessionDeps {
  /** The OAuth client and endpoints, or null when this build has none. */
  config(): GoogleConfig | null
  fetch: typeof fetch
  store: CredentialStore
  openExternal(url: string): Promise<void>
  /** This machine's id in the sync database. Also what its files are named after. */
  deviceId(): Promise<string>
  now(): number
  signInTimeoutMs?: number
  /** Per request; tests shorten it. */
  requestTimeoutMs?: number
}

interface AccessToken {
  token: string
  expiresAt: number
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  id_token?: string
  scope?: string
  error?: string
  error_description?: string
}

/**
 * The claims of an id_token, read without verifying the signature.
 *
 * Google's guidance is that a token received directly from its token endpoint
 * over TLS needs no signature check, and that is the only way one reaches this
 * function. What IS checked is that it was issued to this client and by Google.
 */
function claimsOf(idToken: string | undefined, clientId: string): Record<string, unknown> {
  const part = idToken?.split('.')[1]
  if (!part) throw new SyncError(0, 'invalid_id_token', 'Google 沒有回傳身分資料')
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new SyncError(0, 'invalid_id_token', 'Google 的身分資料無法解析')
  }
  const issuers = ['https://accounts.google.com', 'accounts.google.com']
  const audience = claims.aud
  const audOk = Array.isArray(audience) ? audience.includes(clientId) : audience === clientId
  if (!audOk || typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) {
    throw new SyncError(0, 'invalid_id_token', '身分資料不是發給這個應用程式的')
  }
  return claims
}

/** Only a Google-hosted https image is kept; anything else is dropped rather than fetched later. */
export function safePictureUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    const google = host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com')
    return url.protocol === 'https:' && google && url.username === '' && url.password === ''
      ? url.toString()
      : null
  } catch {
    return null
  }
}

export class GoogleSession {
  private access: AccessToken | null = null
  private refreshing: Promise<AccessToken> | null = null

  constructor(private readonly deps: SessionDeps) {}

  async credentials(): Promise<Credentials | null> {
    return this.deps.store.load()
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.credentials()) !== null
  }

  private config(): GoogleConfig {
    const config = this.deps.config()
    if (!config) throw new SyncError(0, 'not_configured', '這個版本沒有設定 Google 登入')
    return config
  }

  /** `fetch` with a deadline. A timeout becomes a `SyncError`, so it is reported like any other failure. */
  private async timed(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.deps.fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      })
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new SyncError(0, 'timeout', '連線逾時，稍後會自動重試')
      }
      throw e
    }
  }

  private async tokenCall(
    config: GoogleConfig,
    form: Record<string, string>
  ): Promise<TokenResponse> {
    const res = await this.timed(config.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...form
      }).toString()
    })
    const body = (await res.json().catch(() => ({}))) as TokenResponse
    if (!res.ok) {
      // `invalid_grant` on a refresh is Google saying the user revoked access, or the
      // token expired from disuse: nothing a retry can fix.
      if (body.error === 'invalid_grant') {
        throw new SyncError(401, 'revoked', 'Google 已撤銷這個應用程式的授權')
      }
      throw new SyncError(
        res.status,
        body.error ?? 'token_error',
        body.error_description ?? `Google 回應 ${res.status}`
      )
    }
    return body
  }

  // ------------------------------------------------------------- signing in

  async signIn(): Promise<Credentials> {
    const config = this.config()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('base64url')

    const listener = await listenOnce(state, this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS)
    try {
      const url = new URL(config.endpoints.auth)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', `http://127.0.0.1:${listener.port}/cb`)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', SCOPES.join(' '))
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      // Offline access is what yields a refresh token. `consent` makes Google send one
      // every time, not only the first: without it a second sign-in on the same
      // machine returns no refresh token and could not stay signed in.
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'select_account consent')
      await this.deps.openExternal(url.toString())
      const code = await listener.result
      return await this.exchange(config, code, verifier, listener.port)
    } finally {
      listener.close()
    }
  }

  private async exchange(
    config: GoogleConfig,
    code: string,
    verifier: string,
    port: number
  ): Promise<Credentials> {
    const body = await this.tokenCall(config, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: `http://127.0.0.1:${port}/cb`
    })
    // The consent screen lets a user untick individual permissions. Without Drive
    // there is nowhere to put the data, and saying so beats failing later.
    if (!(body.scope ?? '').split(' ').includes(DRIVE_APPDATA_SCOPE)) {
      throw new SyncError(
        0,
        'scope_missing',
        '需要允許存取 Google 雲端硬碟的應用程式資料夾才能同步'
      )
    }
    if (!body.access_token || !body.refresh_token) {
      throw new SyncError(0, 'token_error', 'Google 沒有回傳完整的登入資訊')
    }
    const claims = claimsOf(body.id_token, config.clientId)
    if (typeof claims.email !== 'string' || claims.email === '') {
      throw new SyncError(0, 'invalid_id_token', 'Google 沒有提供電子郵件')
    }
    const credentials: Credentials = {
      refreshToken: body.refresh_token,
      email: claims.email,
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name : null,
      picture: safePictureUrl(claims.picture),
      deviceId: await this.deps.deviceId()
    }
    await this.deps.store.save(credentials)
    this.access = {
      token: body.access_token,
      expiresAt: this.deps.now() + (body.expires_in ?? 3600) * 1000
    }
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
    const config = this.config()
    const credentials = await this.deps.store.load()
    if (!credentials) throw new SyncError(401, 'revoked', '尚未登入')
    let body: TokenResponse
    try {
      body = await this.tokenCall(config, {
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken
      })
    } catch (e) {
      if (e instanceof SyncError && e.needsSignIn) {
        this.access = null
        await this.deps.store.clear()
      }
      throw e
    }
    if (!body.access_token) throw new SyncError(0, 'token_error', 'Google 沒有回傳存取憑證')
    // Google does not rotate refresh tokens, so the stored one stays.
    this.access = {
      token: body.access_token,
      expiresAt: this.deps.now() + (body.expires_in ?? 3600) * 1000
    }
    return this.access
  }

  /** `fetch` with the bearer token, retrying once if Google says it just expired. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${await this.accessToken()}`)
      return this.timed(url, { ...init, headers })
    }
    const first = await send()
    if (first.status !== 401) return first
    this.access = null
    return send()
  }

  // ------------------------------------------------------------- signing out

  /** Tell Google to drop the grant, then forget everything. A network failure does not stop the forgetting. */
  async signOut(): Promise<void> {
    const config = this.deps.config()
    const credentials = await this.deps.store.load()
    if (config && credentials) {
      await this.timed(
        `${config.endpoints.revoke}?token=${encodeURIComponent(credentials.refreshToken)}`,
        { method: 'POST' }
      ).catch(() => undefined)
    }
    this.access = null
    await this.deps.store.clear()
  }

  /** Forget locally without telling anyone: Google already revoked it, or the user cleared the cloud copy. */
  async forget(): Promise<void> {
    this.access = null
    await this.deps.store.clear()
  }
}

// ------------------------------------------------------------ the loopback

interface Listener {
  port: number
  /** Resolves with Google's authorization code; rejects on error/timeout/state mismatch. */
  result: Promise<string>
  close(): void
}

export type PageTone = 'ok' | 'neutral' | 'error'

const ICON: Record<PageTone, string> = {
  ok: '<path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  neutral:
    '<path d="M12 7v6M12 17h.01" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  error:
    '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
}

const TONE_COLOR: Record<PageTone, string> = {
  ok: '#2e7d32',
  neutral: '#ed6c02',
  error: '#d32f2f'
}

/**
 * The page the browser lands on after Google. It is the last thing a user sees of
 * signing in, so it says what happened and what to do, in the app's own words.
 *
 * Self-contained (no requests, no scripts beyond the one close attempt): it is
 * served from a loopback listener that answers one path, and anything it loaded
 * from elsewhere would be one more thing riding on a page that holds an
 * authorization code in its URL. Follows the system light/dark setting.
 */
export const PAGE = (tone: PageTone, title: string, body: string): string =>
  `<!doctype html><html lang="zh-Hant"><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="referrer" content="no-referrer"><title>${title} · SVWB Analyzer</title>` +
  `<style>` +
  `:root{color-scheme:light dark;--bg:#f4f6fa;--card:#fff;--fg:#1c2530;--sub:#5b6776;--line:#e3e8ef}` +
  `@media(prefers-color-scheme:dark){:root{--bg:#10151c;--card:#19202a;--fg:#e8edf3;--sub:#9aa7b6;--line:#27303b}}` +
  `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;` +
  `background:var(--bg);color:var(--fg);font-family:system-ui,"Segoe UI","Microsoft JhengHei",sans-serif}` +
  `main{width:min(26rem,calc(100vw - 2rem));background:var(--card);border:1px solid var(--line);` +
  `border-radius:16px;padding:2.25rem 2rem;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.08)}` +
  `.badge{width:64px;height:64px;margin:0 auto 1.25rem;border-radius:50%;display:grid;place-items:center;` +
  `color:${TONE_COLOR[tone]};background:color-mix(in srgb,${TONE_COLOR[tone]} 14%,transparent)}` +
  `.badge svg{width:34px;height:34px}h1{font-size:1.35rem;margin:0 0 .6rem}` +
  `p{margin:0;color:var(--sub);line-height:1.6}.brand{margin-top:1.75rem;font-size:.8rem;color:var(--sub);opacity:.8}` +
  `</style>` +
  `<body><main><div class="badge"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[tone]}</svg></div>` +
  `<h1>${title}</h1><p>${body}</p><div class="brand">SVWB Analyzer</div></main>` +
  // Browsers only honour this for tabs a script opened, so it usually does
  // nothing - which is why the text above still tells the user to close it.
  `<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script></body></html>`

/**
 * One-shot HTTP listener on 127.0.0.1 for the redirect.
 *
 * Bound to the loopback interface only and to an OS-chosen port, answers
 * exactly one request path, and closes after the first valid callback. The
 * `state` is compared so a redirect that did not originate from OUR
 * authorization request (another page poking the port) is refused.
 */
function listenOnce(state: string, timeoutMs: number): Promise<Listener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle: { resolve(code: string): void; reject(e: Error): void }
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
        reply(400, PAGE('error', '無法登入', '這個登入要求不是由 SVWB Analyzer 發起的，已忽略。'))
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error || !code) {
        reply(
          200,
          PAGE('neutral', '登入未完成', '你可以關閉這個分頁，回到 SVWB Analyzer 再試一次。')
        )
        settle.reject(new SyncError(0, error ?? 'cancelled', '登入未完成'))
        return
      }
      reply(200, PAGE('ok', '登入完成', '已登入成功。你可以關閉這個分頁，回到 SVWB Analyzer。'))
      settle.resolve(code)
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
