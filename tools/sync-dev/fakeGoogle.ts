/**
 * A stand-in for the parts of Google that sync uses: OAuth (consent, token,
 * refresh, revoke) and the Drive `appDataFolder` REST API.
 *
 * It exists so that the real client code - the loopback sign-in, PKCE, token
 * refresh, `DriveBackend`'s uploads and lists - can run in tests, in e2e and in
 * development with no Google account and no network. It is a `fetch` function,
 * so a test hands it straight to `GoogleSession`, and `server.ts` puts a plain
 * HTTP listener in front of it for the cases that need a real socket.
 *
 * It is deliberately as strict as Google about the things sync depends on and
 * says nothing about the rest: PKCE is checked (a wrong verifier is refused),
 * a revoked grant refuses a refresh with `invalid_grant`, an expired access
 * token is a 401, each user sees only their own files, and `appProperties`
 * round-trip. Every knob a test might want to turn is a public field.
 */
import { createHash, randomBytes } from 'node:crypto'

export const FAKE_CLIENT_ID = 'fake-client.apps.googleusercontent.com'
export const FAKE_CLIENT_SECRET = 'fake-client-secret'
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

interface StoredFile {
  id: string
  name: string
  props: Record<string, string>
  content: string
  modifiedAt: number
}

interface AccessGrant {
  email: string
  expiresAt: number
}

export interface FakeGoogleOptions {
  /** Origin the fake is reachable at; it only matters for URLs it builds itself. */
  origin?: string
  now?: () => number
}

export class FakeGoogle {
  readonly origin: string
  private readonly clock: () => number
  /** Access-token lifetime. Tests shorten it to exercise refresh. */
  accessTtlMs = 60 * 60_000
  /** Make the next Drive call(s) fail like this. Consumed one per call. */
  failNext: Array<{ status: number; reason?: string; retryAfter?: number }> = []
  /** Every Drive call, so a test can assert how chatty something is. */
  calls: string[] = []
  /** `drive.appdata` unticked on the consent screen. */
  denyDriveScope = false
  /** The Drive stops accepting new bytes (the user's storage is full). */
  storageFull = false
  /** Max files per list page, small so a test crosses a page boundary. */
  pageSize = 1000
  /** Token-endpoint calls by grant type, so a test can assert refreshes are shared. */
  tokenCalls = { code: 0, refresh: 0 }
  /** Make token-endpoint calls fail like this (a Google outage), without revoking anything. */
  tokenFail: number | null = null

  private codes = new Map<
    string,
    { email: string; challenge: string; clientId: string; redirectUri: string; scope: string }
  >()
  private access = new Map<string, AccessGrant>()
  private refresh = new Map<string, string>()
  private files = new Map<string, Map<string, StoredFile>>()
  private names = new Map<string, { name: string; picture: string | null }>()

  constructor(options: FakeGoogleOptions = {}) {
    this.origin = options.origin ?? 'https://fake.google'
    this.clock = options.now ?? (() => Date.now())
  }

  endpoints(): {
    auth: string
    token: string
    revoke: string
    drive: string
    upload: string
  } {
    return {
      auth: `${this.origin}/o/oauth2/v2/auth`,
      token: `${this.origin}/token`,
      revoke: `${this.origin}/revoke`,
      drive: `${this.origin}/drive/v3`,
      upload: `${this.origin}/upload/drive/v3`
    }
  }

  // ------------------------------------------------------- test-side access

  /** What `email`'s appDataFolder holds right now. */
  filesOf(email: string): StoredFile[] {
    return [...(this.files.get(email)?.values() ?? [])]
  }

  setProfile(email: string, profile: { name: string; picture: string | null }): void {
    this.names.set(email, profile)
  }

  /** The user removes the app in their Google account: every grant dies. */
  revokeAll(email: string): void {
    for (const [token, who] of this.refresh) if (who === email) this.refresh.delete(token)
    for (const [token, grant] of this.access) if (grant.email === email) this.access.delete(token)
  }

  /** Google stops honouring every access token (they lapse) while refresh tokens keep working. */
  forgetAccessTokens(): void {
    this.access.clear()
  }

  /** The user empties the app's hidden Drive folder. */
  clearDrive(email: string): void {
    this.files.delete(email)
  }

  totalBytes(email: string): number {
    return this.filesOf(email).reduce((n, f) => n + Buffer.byteLength(f.content), 0)
  }

  /**
   * What the browser does after the user picks an account and says yes: the
   * redirect back to the app's loopback listener, carrying a code.
   */
  approve(authUrl: string, email: string): string {
    const url = new URL(authUrl)
    const q = url.searchParams
    if (q.get('client_id') !== FAKE_CLIENT_ID) throw new Error('unknown client_id')
    if (q.get('response_type') !== 'code') throw new Error('response_type must be code')
    if (q.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required')
    const redirectUri = q.get('redirect_uri') ?? ''
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(redirectUri)) throw new Error('loopback redirect only')
    const requested = (q.get('scope') ?? '').split(' ')
    const granted = requested.filter((s) => !(this.denyDriveScope && s === DRIVE_SCOPE))
    const code = randomBytes(16).toString('hex')
    this.codes.set(code, {
      email,
      challenge: q.get('code_challenge') ?? '',
      clientId: FAKE_CLIENT_ID,
      redirectUri,
      scope: granted.join(' ')
    })
    const back = new URL(redirectUri)
    back.searchParams.set('code', code)
    back.searchParams.set('state', q.get('state') ?? '')
    return back.toString()
  }

  // ----------------------------------------------------------------- fetch

  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input as string, init)
    const url = new URL(request.url)
    const path = url.pathname
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers }
      })

    if (path === '/o/oauth2/v2/auth' && request.method === 'GET') return this.consentPage(url)
    if (path === '/o/oauth2/v2/auth/approve' && request.method === 'GET') {
      const authUrl = new URL(`${this.origin}/o/oauth2/v2/auth`)
      for (const [k, v] of url.searchParams) if (k !== 'email') authUrl.searchParams.set(k, v)
      const back = this.approve(
        authUrl.toString(),
        url.searchParams.get('email') ?? 'me@example.com'
      )
      return Response.redirect(back, 302)
    }
    if (path === '/token' && request.method === 'POST') {
      return this.token(new URLSearchParams(await request.text()), json)
    }
    if (path === '/revoke' && request.method === 'POST') {
      const token = url.searchParams.get('token') ?? ''
      const who = this.refresh.get(token)
      if (who) this.revokeAll(who)
      return new Response(null, { status: 200 })
    }
    if (path.startsWith('/drive/v3/') || path.startsWith('/upload/drive/v3/')) {
      return this.drive(request, url, json)
    }
    return new Response('not found', { status: 404 })
  }

  private consentPage(url: URL): Response {
    const hidden = [...url.searchParams]
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('')
    const html =
      `<!doctype html><meta charset="utf-8"><title>Fake Google</title>` +
      `<body style="font-family:system-ui;max-width:30em;margin:4em auto;padding:0 1em">` +
      `<h2>Sign in with Google <small style="color:#b00">(local fake)</small></h2>` +
      `<p>The development stand-in. Pick any address; the same address is the same account.</p>` +
      `<form method="get" action="/o/oauth2/v2/auth/approve">${hidden}` +
      `<input name="email" value="me@example.com" style="width:100%;padding:.5em;font-size:1em">` +
      `<p><button style="padding:.5em 1.2em;font-size:1em">Continue</button></p></form></body>`
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  private async token(
    form: URLSearchParams,
    json: (s: number, b: unknown) => Response
  ): Promise<Response> {
    if (
      form.get('client_id') !== FAKE_CLIENT_ID ||
      form.get('client_secret') !== FAKE_CLIENT_SECRET
    ) {
      return json(401, { error: 'invalid_client' })
    }
    const now = this.clock()
    if (this.tokenFail !== null) return json(this.tokenFail, { error: 'backend_error' })
    if (form.get('grant_type') === 'authorization_code') {
      this.tokenCalls.code++
      const entry = this.codes.get(form.get('code') ?? '')
      this.codes.delete(form.get('code') ?? '') // single use
      if (!entry || entry.redirectUri !== form.get('redirect_uri')) {
        return json(400, { error: 'invalid_grant' })
      }
      const verifier = form.get('code_verifier') ?? ''
      if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
      }
      const accessToken = `ya29.${randomBytes(12).toString('hex')}`
      const refreshToken = `1//${randomBytes(12).toString('hex')}`
      this.access.set(accessToken, { email: entry.email, expiresAt: now + this.accessTtlMs })
      this.refresh.set(refreshToken, entry.email)
      return json(200, {
        access_token: accessToken,
        expires_in: Math.floor(this.accessTtlMs / 1000),
        refresh_token: refreshToken,
        scope: entry.scope,
        token_type: 'Bearer',
        id_token: this.idToken(entry.email)
      })
    }
    if (form.get('grant_type') === 'refresh_token') {
      this.tokenCalls.refresh++
      const email = this.refresh.get(form.get('refresh_token') ?? '')
      if (!email) return json(400, { error: 'invalid_grant' })
      const accessToken = `ya29.${randomBytes(12).toString('hex')}`
      this.access.set(accessToken, { email, expiresAt: now + this.accessTtlMs })
      return json(200, {
        access_token: accessToken,
        expires_in: Math.floor(this.accessTtlMs / 1000),
        scope: `openid email profile ${DRIVE_SCOPE}`,
        token_type: 'Bearer'
      })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  private idToken(email: string): string {
    const profile = this.names.get(email) ?? { name: email.split('@')[0], picture: null }
    const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
    const now = Math.floor(this.clock() / 1000)
    return [
      part({ alg: 'none', typ: 'JWT' }),
      part({
        iss: 'https://accounts.google.com',
        aud: FAKE_CLIENT_ID,
        sub: String(BigInt('0x' + createHash('sha256').update(email).digest('hex').slice(0, 15))),
        email,
        email_verified: true,
        name: profile.name,
        ...(profile.picture ? { picture: profile.picture } : {}),
        iat: now,
        exp: now + 3600
      }),
      'unsigned'
    ].join('.')
  }

  // ----------------------------------------------------------------- Drive

  private async drive(
    request: Request,
    url: URL,
    json: (s: number, b: unknown, h?: Record<string, string>) => Response
  ): Promise<Response> {
    this.calls.push(`${request.method} ${url.pathname}`)
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const grant = this.access.get(bearer)
    if (!grant || grant.expiresAt <= this.clock()) {
      return json(401, { error: { code: 401, message: 'Invalid Credentials' } })
    }
    const injected = this.failNext.shift()
    if (injected) {
      return json(
        injected.status,
        {
          error: {
            code: injected.status,
            message: 'injected',
            errors: [{ reason: injected.reason }]
          }
        },
        injected.retryAfter ? { 'Retry-After': String(injected.retryAfter) } : {}
      )
    }
    const mine = this.files.get(grant.email) ?? new Map<string, StoredFile>()
    this.files.set(grant.email, mine)
    const view = (f: StoredFile): Record<string, unknown> => ({
      id: f.id,
      name: f.name,
      size: String(Buffer.byteLength(f.content)),
      appProperties: f.props,
      modifiedTime: new Date(f.modifiedAt).toISOString()
    })

    const upload = url.pathname.startsWith('/upload/drive/v3/files')
    const rest = url.pathname.replace(/^\/(upload\/)?drive\/v3\/files\/?/, '')
    const id = rest === '' ? null : decodeURIComponent(rest)

    // list
    if (!upload && id === null && request.method === 'GET') {
      if (url.searchParams.get('spaces') !== 'appDataFolder') {
        return json(400, { error: { code: 400, message: 'only appDataFolder is supported' } })
      }
      const all = [...mine.values()].sort((a, b) => a.name.localeCompare(b.name))
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? 100), this.pageSize)
      const offset = Number(url.searchParams.get('pageToken') ?? 0)
      const page = all.slice(offset, offset + size)
      return json(200, {
        files: page.map(view),
        ...(offset + size < all.length ? { nextPageToken: String(offset + size) } : {})
      })
    }
    // metadata-only create
    if (!upload && id === null && request.method === 'POST') {
      const meta = (await request.json()) as {
        name: string
        parents?: string[]
        appProperties?: Record<string, string>
      }
      if (!meta.parents?.includes('appDataFolder')) return json(400, { error: { code: 400 } })
      const file: StoredFile = {
        id: randomBytes(8).toString('hex'),
        name: meta.name,
        props: meta.appProperties ?? {},
        content: '',
        modifiedAt: this.clock()
      }
      mine.set(file.id, file)
      return json(200, view(file))
    }
    // multipart create / replace
    if (upload) {
      if (this.storageFull) {
        return json(403, {
          error: { code: 403, message: 'full', errors: [{ reason: 'storageQuotaExceeded' }] }
        })
      }
      const boundary = /boundary=(.+)$/.exec(request.headers.get('content-type') ?? '')?.[1]
      if (!boundary)
        return json(400, { error: { code: 400, message: 'multipart/related required' } })
      const { meta, media } = parseMultipart(await request.text(), boundary)
      if (request.method === 'POST' && id === null) {
        if (!meta.parents?.includes('appDataFolder')) return json(400, { error: { code: 400 } })
        const file: StoredFile = {
          id: randomBytes(8).toString('hex'),
          name: meta.name as string,
          props: (meta.appProperties as Record<string, string>) ?? {},
          content: media,
          modifiedAt: this.clock()
        }
        mine.set(file.id, file)
        return json(200, view(file))
      }
      const file = id ? mine.get(id) : undefined
      if (request.method === 'PATCH' && file) {
        file.content = media
        if (meta.appProperties) file.props = meta.appProperties as Record<string, string>
        file.modifiedAt = this.clock()
        return json(200, view(file))
      }
      return json(404, { error: { code: 404, message: 'File not found' } })
    }
    const file = id ? mine.get(id) : undefined
    if (!file) return json(404, { error: { code: 404, message: 'File not found' } })
    if (request.method === 'GET') {
      if (url.searchParams.get('alt') === 'media') {
        return new Response(file.content, { headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      return json(200, view(file))
    }
    if (request.method === 'PATCH') {
      const meta = (await request.json()) as { appProperties?: Record<string, string> }
      if (meta.appProperties) file.props = meta.appProperties
      file.modifiedAt = this.clock()
      return json(200, view(file))
    }
    if (request.method === 'DELETE') {
      mine.delete(file.id)
      return new Response(null, { status: 204 })
    }
    return json(405, { error: { code: 405 } })
  }
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** The two parts of a `multipart/related` upload: JSON metadata, then the media. */
interface UploadMeta {
  name?: string
  parents?: string[]
  appProperties?: Record<string, string>
}

function parseMultipart(body: string, boundary: string): { meta: UploadMeta; media: string } {
  const parts = body.split(`--${boundary}`).filter((p) => p.trim() !== '' && p.trim() !== '--')
  const content = (part: string): string => {
    const start = part.indexOf('\r\n\r\n')
    return part.slice(start + 4).replace(/\r\n$/, '')
  }
  return { meta: JSON.parse(content(parts[0])), media: content(parts[1]) }
}
