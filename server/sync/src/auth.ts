/**
 * Identity: Google sign-in mediated by this Worker, and the sessions we issue.
 *
 *   GET  /auth/start      -> 302 to Google (redirect_uri = {origin}/auth/callback)
 *   GET  /auth/callback   -> exchanges the code, verifies the id_token, mints a
 *                            one-time grant, 302 to the app's loopback listener
 *   POST /v1/auth/token   -> grant + PKCE verifier -> access JWT + refresh token
 *   POST /v1/auth/refresh -> rotates the refresh token
 *
 * Why the Worker sits in the middle (docs/account-sync-plan.md): Google's
 * client secret lives here and never in an installer, and the app only ever
 * talks to us.
 *
 * Two different PKCE-ish things happen and are easy to confuse:
 *   - app <-> Worker: the `challenge`/`verifier` pair. The browser hop is the
 *     untrusted one (anything on the machine can listen on a loopback port), so
 *     the grant that comes back is useless without the verifier, which never
 *     left the app.
 *   - Worker <-> Google: a plain confidential-client code exchange with our
 *     secret. No PKCE needed there, but we do bind a `nonce` so an id_token
 *     minted for some other flow cannot be replayed into this one.
 *
 * The OAuth `state` we send to Google is stateless: the port, challenge, the
 * app's own state and the nonce, signed with SESSION_SECRET. An anonymous
 * /auth/start therefore writes nothing to D1 - nobody can fill the database by
 * hammering a public URL.
 */
import { ApiError, json, readJsonObject } from './http'
import {
  b64urlDecode,
  b64urlEncode,
  decodeJwtSegment,
  hmacSign,
  hmacVerify,
  randomToken,
  sha256,
  sha256Hex,
  signAccessToken,
  timingSafeEqual,
  utf8,
  verifyAccessToken
} from './jwt'
import {
  ACCESS_TTL_MS,
  DEVICE_ID_RE,
  GRANT_TTL_MS,
  LAST_SEEN_GRANULARITY_MS,
  OAUTH_STATE_TTL_MS,
  SUB_RE
} from './limits'
import type { DeviceRow } from './devices'
import { sanitizeText } from './devices'
import type { Deps, JwksCache, Session } from './types'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const JWKS_TTL_MS = 60 * 60_000
/** An unknown `kid` re-fetches the keys, but never more often than this. */
const JWKS_MIN_REFETCH_MS = 60_000
/** Clock skew allowed on Google's `exp`. */
const ID_TOKEN_LEEWAY_MS = 60_000

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
/** RFC 7636 section 4.1. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

// ---------------------------------------------------------------- state

interface OAuthState {
  /** Loopback port. */
  p: number
  /** PKCE challenge. */
  c: string
  /** The app's own `state`, echoed back untouched. */
  s: string
  /** Nonce expected in the id_token. */
  n: string
  /** Expiry, epoch ms. */
  e: number
}

// The prefix keeps a signed state from ever verifying as anything else signed
// with the same secret (the access JWTs), and the reverse.
const STATE_DOMAIN = 'oauth-state.'

async function sealState(secret: string, state: OAuthState): Promise<string> {
  const body = b64urlEncode(utf8(JSON.stringify(state)))
  return `${body}.${await hmacSign(secret, STATE_DOMAIN + body)}`
}

async function openState(secret: string, sealed: string): Promise<OAuthState | null> {
  const [body, signature, extra] = sealed.split('.')
  if (!body || !signature || extra !== undefined) return null
  if (!(await hmacVerify(secret, STATE_DOMAIN + body, signature))) return null
  const decoded = decodeJwtSegment(body)
  if (!decoded) return null
  const { p, c, s, n, e } = decoded
  if (
    typeof p !== 'number' ||
    typeof c !== 'string' ||
    typeof s !== 'string' ||
    typeof n !== 'string' ||
    typeof e !== 'number'
  ) {
    return null
  }
  return { p, c, s, n, e }
}

function loopbackRedirect(port: number, params: Record<string, string>): Response {
  const target = new URL(`http://127.0.0.1:${port}/cb`)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), 'cache-control': 'no-store' }
  })
}

// ---------------------------------------------------------------- /auth/start

export async function startLogin(deps: Deps, url: URL): Promise<Response> {
  const portRaw = url.searchParams.get('port') ?? ''
  const port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : NaN
  const challenge = url.searchParams.get('challenge') ?? ''
  const appState = url.searchParams.get('state') ?? ''
  // Nowhere safe to redirect an error to yet (the port is the thing in doubt),
  // so these are plain 422s.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ApiError(422, 'invalid', 'port must be an integer from 1024 to 65535.')
  }
  if (!CHALLENGE_RE.test(challenge)) {
    throw new ApiError(422, 'invalid', 'challenge must be a base64url SHA-256 (43 characters).')
  }
  if (appState.length < 1 || appState.length > 64) {
    throw new ApiError(422, 'invalid', 'state must be 1 to 64 characters.')
  }

  const nonce = randomToken(16)
  const sealed = await sealState(deps.secrets.sessionSecret, {
    p: port,
    c: challenge,
    s: appState,
    n: nonce,
    e: deps.now() + OAUTH_STATE_TTL_MS
  })
  const google = new URL(GOOGLE_AUTH_URL)
  google.searchParams.set('client_id', deps.secrets.googleClientId)
  google.searchParams.set('redirect_uri', `${url.origin}/auth/callback`)
  google.searchParams.set('response_type', 'code')
  google.searchParams.set('scope', 'openid email profile')
  google.searchParams.set('state', sealed)
  google.searchParams.set('nonce', nonce)
  // Always show the account chooser: a household PC is often signed in to
  // someone else's Google account, and silently picking it is a wrong-account
  // sync that looks like a bug.
  google.searchParams.set('prompt', 'select_account')
  return new Response(null, {
    status: 302,
    headers: { location: google.toString(), 'cache-control': 'no-store' }
  })
}

// ---------------------------------------------------------------- id_token

export class LoginError extends Error {
  constructor(readonly code: 'invalid_id_token' | 'email_unverified' | 'exchange_failed') {
    super(code)
  }
}

async function loadKeys(deps: Deps, force: boolean): Promise<Array<Record<string, unknown>>> {
  const holder = deps.jwks
  const cached: JwksCache | null = holder?.current ?? null
  const age = cached ? deps.now() - cached.fetchedAt : Infinity
  if (cached && ((!force && age < JWKS_TTL_MS) || (force && age < JWKS_MIN_REFETCH_MS))) {
    return cached.keys
  }
  const response = await deps.fetch(GOOGLE_JWKS_URL)
  if (!response.ok) throw new LoginError('exchange_failed')
  const body = (await response.json()) as { keys?: unknown }
  if (!Array.isArray(body.keys)) throw new LoginError('exchange_failed')
  const keys = body.keys as Array<Record<string, unknown>>
  if (holder) holder.current = { keys, fetchedAt: deps.now() }
  return keys
}

export interface GoogleIdentity {
  sub: string
  email: string
  name: string | null
}

/**
 * Verify a Google id_token completely: RS256 signature against Google's
 * published keys, then issuer, audience, expiry, nonce, `email_verified`.
 *
 * Google says a token received directly from its token endpoint over TLS
 * needs no signature check. It gets one anyway: the cost is one cached fetch,
 * and it keeps this function correct if the token ever arrives by a route that
 * is not that.
 */
export async function verifyGoogleIdToken(
  deps: Deps,
  idToken: string,
  expectedNonce: string
): Promise<GoogleIdentity> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new LoginError('invalid_id_token')
  const [headerPart, payloadPart, signaturePart] = parts
  const header = decodeJwtSegment(headerPart)
  const signature = b64urlDecode(signaturePart)
  // Pinning the algorithm is the entire defence against `alg: none` and
  // against being talked into an HMAC check with a public key as the secret.
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !signature) {
    throw new LoginError('invalid_id_token')
  }

  let keys = await loadKeys(deps, false)
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    keys = await loadKeys(deps, true)
    jwk = keys.find((k) => k.kid === header.kid)
  }
  if (!jwk) throw new LoginError('invalid_id_token')

  let valid = false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk as unknown as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature as BufferSource,
      utf8(`${headerPart}.${payloadPart}`) as BufferSource
    )
  } catch {
    valid = false
  }
  if (!valid) throw new LoginError('invalid_id_token')

  const claims = decodeJwtSegment(payloadPart)
  if (!claims) throw new LoginError('invalid_id_token')
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new LoginError('invalid_id_token')
  }
  // `aud` may be a string or an array; either way OUR client id must be the
  // audience, or this token was minted for somebody else's app.
  const aud = claims.aud
  const audOk = Array.isArray(aud)
    ? aud.includes(deps.secrets.googleClientId)
    : aud === deps.secrets.googleClientId
  if (!audOk) throw new LoginError('invalid_id_token')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 + ID_TOKEN_LEEWAY_MS <= deps.now()) {
    throw new LoginError('invalid_id_token')
  }
  if (typeof claims.nonce !== 'string' || !timingSafeEqual(claims.nonce, expectedNonce)) {
    throw new LoginError('invalid_id_token')
  }
  if (typeof claims.sub !== 'string' || !SUB_RE.test(claims.sub)) {
    throw new LoginError('invalid_id_token')
  }
  if (typeof claims.email !== 'string' || claims.email === '') {
    throw new LoginError('invalid_id_token')
  }
  // Google has sent this as a boolean and, historically, as the string "true".
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new LoginError('email_unverified')
  }
  const name = typeof claims.name === 'string' && claims.name.trim() !== '' ? claims.name : null
  return { sub: claims.sub, email: claims.email, name: name ? sanitizeText(name, 200) : null }
}

async function exchangeCode(deps: Deps, code: string, redirectUri: string): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: deps.secrets.googleClientId,
    client_secret: deps.secrets.googleClientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  }).toString()
  const response = await deps.fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) throw new LoginError('exchange_failed')
  const parsed = (await response.json()) as { id_token?: unknown }
  if (typeof parsed.id_token !== 'string') throw new LoginError('exchange_failed')
  return parsed.id_token
}

// ---------------------------------------------------------------- /auth/callback

export async function finishLogin(deps: Deps, url: URL): Promise<Response> {
  const state = await openState(deps.secrets.sessionSecret, url.searchParams.get('state') ?? '')
  // Without a valid state there is no verified port to send anyone to.
  if (!state) throw new ApiError(422, 'invalid', 'The login state is missing or was tampered with.')
  const back = (error: string): Response => loopbackRedirect(state.p, { error, state: state.s })
  if (state.e <= deps.now()) return back('expired')

  const googleError = url.searchParams.get('error')
  if (googleError) {
    // Passed through only if it looks like an OAuth error code (access_denied
    // is the common one: the user pressed Cancel).
    return back(/^[a-z_]{1,40}$/.test(googleError) ? googleError : 'denied')
  }
  const code = url.searchParams.get('code')
  if (!code) return back('invalid')

  let identity: GoogleIdentity
  try {
    const idToken = await exchangeCode(deps, code, `${url.origin}/auth/callback`)
    identity = await verifyGoogleIdToken(deps, idToken, state.n)
  } catch (error) {
    return back(error instanceof LoginError ? error.code : 'exchange_failed')
  }

  const grant = randomToken(32)
  await deps.db
    .prepare(
      `INSERT INTO grants (hash, sub, email, name, challenge, expiresAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      await sha256Hex(grant),
      identity.sub,
      identity.email,
      identity.name,
      state.c,
      deps.now() + GRANT_TTL_MS
    )
    .run()
  return loopbackRedirect(state.p, { grant, state: state.s })
}

// ---------------------------------------------------------------- sessions

function refreshTokenFor(sub: string): string {
  // The `sub` prefix is a lookup key, not a secret: it lets /refresh find the
  // device row by its primary key instead of needing an index on the hash
  // (which D1 would bill as an extra write on every rotation).
  return `${sub}.${randomToken(32)}`
}

function splitRefreshToken(token: string): string | null {
  const cut = token.lastIndexOf('.')
  if (cut < 1) return null
  const sub = token.slice(0, cut)
  return SUB_RE.test(sub) ? sub : null
}

async function issueAccess(
  deps: Deps,
  sub: string,
  deviceId: string
): Promise<{ accessToken: string; accessExpiresAt: number }> {
  const now = deps.now()
  const accessExpiresAt = now + ACCESS_TTL_MS
  const accessToken = await signAccessToken(deps.secrets.sessionSecret, {
    sub,
    did: deviceId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(accessExpiresAt / 1000)
  })
  return { accessToken, accessExpiresAt: Math.floor(accessExpiresAt / 1000) * 1000 }
}

function stringField(
  body: Record<string, unknown>,
  key: string,
  max: number,
  required = true
): string {
  const value = body[key]
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ApiError(422, 'invalid', `${key} is missing or malformed.`)
  }
  return value
}

/**
 * POST /v1/auth/token. Spends the grant, proves PKCE, registers (or revives)
 * the device, and hands out the first token pair.
 *
 * The grant is DELETEd before it is examined, and any failure afterwards
 * leaves it deleted. A wrong verifier is therefore also a burned grant: the
 * legitimate app has the right verifier, so the only caller a retry would help
 * is someone guessing.
 */
export async function exchangeGrant(deps: Deps, request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const grant = stringField(body, 'grant', 200)
  const verifier = stringField(body, 'verifier', 200)
  const deviceId = stringField(body, 'deviceId', 64)
  if (!DEVICE_ID_RE.test(deviceId)) throw new ApiError(422, 'invalid', 'deviceId is malformed.')
  if (!VERIFIER_RE.test(verifier)) throw new ApiError(422, 'invalid', 'verifier is malformed.')
  const deviceName = sanitizeText(stringField(body, 'deviceName', 200, false), 80) || 'device'
  const appVersion = sanitizeText(stringField(body, 'appVersion', 64, false), 32) || 'unknown'

  const spent = await deps.db
    .prepare(
      `DELETE FROM grants WHERE hash = ?1
       RETURNING sub, email, name, challenge, expiresAt`
    )
    .bind(await sha256Hex(grant))
    .first<{
      sub: string
      email: string
      name: string | null
      challenge: string
      expiresAt: number
    }>()
  const deny = (): ApiError =>
    new ApiError(403, 'forbidden', 'The login grant is invalid or has expired.')
  if (!spent || spent.expiresAt <= deps.now()) throw deny()
  if (!timingSafeEqual(b64urlEncode(await sha256(utf8(verifier))), spent.challenge)) throw deny()

  const now = deps.now()
  const { sub } = spent

  if (deps.config.maxDevices > 0) {
    const existing = await deps.db
      .prepare(`SELECT retiredAt, revokedAt FROM devices WHERE sub = ?1 AND id = ?2`)
      .bind(sub, deviceId)
      .first<{ retiredAt: number | null; revokedAt: number | null }>()
    const alreadyActive = existing && existing.retiredAt === null && existing.revokedAt === null
    if (!alreadyActive) {
      const count = await deps.db
        .prepare(
          `SELECT COUNT(*) AS n FROM devices
           WHERE sub = ?1 AND retiredAt IS NULL AND revokedAt IS NULL`
        )
        .bind(sub)
        .first<{ n: number }>()
      if ((count?.n ?? 0) >= deps.config.maxDevices) {
        throw new ApiError(403, 'forbidden', 'This account has reached its device limit.')
      }
    }
  }

  const refreshToken = refreshTokenFor(sub)
  await deps.db.batch([
    // Rewritten only when the email or name actually changed (a login is rare,
    // but the habit is cheap).
    deps.db
      .prepare(
        `INSERT INTO accounts (sub, email, name, createdAt) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (sub) DO UPDATE SET email = excluded.email, name = excluded.name
         WHERE accounts.email IS NOT excluded.email OR accounts.name IS NOT excluded.name`
      )
      .bind(sub, spent.email, spent.name, now),
    // A retired or revoked device that signs in again comes back: the person at
    // the keyboard just proved they own the account. `revivedAt` restarts its
    // idle clock so the next cron does not retire it again.
    deps.db
      .prepare(
        `INSERT INTO devices (sub, id, name, appVersion, createdAt, lastSeenAt, refreshHash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
         ON CONFLICT (sub, id) DO UPDATE SET
           name = excluded.name,
           appVersion = excluded.appVersion,
           lastSeenAt = excluded.lastSeenAt,
           refreshHash = excluded.refreshHash,
           prevRefreshHash = NULL,
           revivedAt = CASE
             WHEN devices.retiredAt IS NOT NULL OR devices.revokedAt IS NOT NULL
             THEN excluded.lastSeenAt ELSE devices.revivedAt END,
           retiredAt = NULL,
           revokedAt = NULL`
      )
      .bind(sub, deviceId, deviceName, appVersion, now, await sha256Hex(refreshToken))
  ])

  const access = await issueAccess(deps, sub, deviceId)
  return json({
    ...access,
    refreshToken,
    account: { email: spent.email, name: spent.name },
    deviceId
  })
}

/**
 * POST /v1/auth/refresh. Rotates the refresh token on every use.
 *
 * Presenting the PREVIOUS token means one was used twice - a copy exists
 * somewhere. The device is revoked outright: the person gets a login prompt,
 * which is a fair price for closing a stolen-token window. (A lost response
 * is the benign way to hit this; the app handles `revoked` by asking to sign in
 * again, as it must for any revoke.)
 */
export async function refreshSession(deps: Deps, request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const token = stringField(body, 'refreshToken', 400)
  const deviceId = stringField(body, 'deviceId', 64)
  const sub = splitRefreshToken(token)
  if (!sub || !DEVICE_ID_RE.test(deviceId)) {
    throw new ApiError(401, 'revoked', 'The refresh token is not valid.')
  }
  const device = await deps.db
    .prepare(
      `SELECT retiredAt, revokedAt, refreshHash, prevRefreshHash FROM devices
       WHERE sub = ?1 AND id = ?2`
    )
    .bind(sub, deviceId)
    .first<{
      retiredAt: number | null
      revokedAt: number | null
      refreshHash: string | null
      prevRefreshHash: string | null
    }>()
  if (!device) throw new ApiError(401, 'unknown_device', 'This device is not registered.')

  const hash = await sha256Hex(token)
  if (device.prevRefreshHash && timingSafeEqual(hash, device.prevRefreshHash)) {
    await deps.db
      .prepare(
        `UPDATE devices SET revokedAt = COALESCE(revokedAt, ?3), refreshHash = NULL,
           prevRefreshHash = NULL WHERE sub = ?1 AND id = ?2`
      )
      .bind(sub, deviceId, deps.now())
      .run()
    throw new ApiError(401, 'revoked', 'This refresh token was already used; sign in again.')
  }
  // Anything that is not the current token is refused the same way, and in
  // particular says nothing about the device's state: only a holder of the real
  // token learns "retired".
  if (!device.refreshHash || !timingSafeEqual(hash, device.refreshHash)) {
    throw new ApiError(401, 'revoked', 'The refresh token is not valid.')
  }
  if (device.revokedAt !== null) throw new ApiError(401, 'revoked', 'This device was revoked.')
  if (device.retiredAt !== null) {
    throw new ApiError(
      401,
      'retired',
      'This device was retired after a long idle period; sign in again.'
    )
  }

  const next = refreshTokenFor(sub)
  // Compare-and-swap on the hash we just verified: of two parallel refreshes
  // with the same token, exactly one rotates. The loser is told `revoked`
  // without revoking anything - the winner's new token is still good.
  const swapped = await deps.db
    .prepare(
      `UPDATE devices SET prevRefreshHash = refreshHash, refreshHash = ?3, lastSeenAt = ?4
       WHERE sub = ?1 AND id = ?2 AND refreshHash = ?5`
    )
    .bind(sub, deviceId, await sha256Hex(next), deps.now(), device.refreshHash)
    .run()
  if (swapped.meta.changes === 0) {
    throw new ApiError(401, 'revoked', 'The refresh token is not valid.')
  }
  return json({ ...(await issueAccess(deps, sub, deviceId)), refreshToken: next })
}

// ---------------------------------------------------------------- bearer auth

/**
 * Resolve `Authorization: Bearer ...` to a session, or throw the 401 the
 * protocol names.
 *
 * `sub` comes from the signed token and nowhere else. The device row is read
 * on every request (D1 reads are the cheap budget) so that revoke and retire
 * take effect immediately instead of when the 15-minute token runs out.
 */
export async function authenticate(deps: Deps, request: Request): Promise<Session> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer (\S+)$/.exec(header)
  // A missing or forged token is reported as `revoked`: the protocol has no
  // "unauthenticated" code, credentials that do not verify will not verify
  // after a refresh either, and `revoked` is the code that makes the client
  // drop them and ask the person to sign in.
  if (!match) throw new ApiError(401, 'revoked', 'A bearer token is required.')
  const verified = await verifyAccessToken(deps.secrets.sessionSecret, match[1], deps.now())
  if (!verified.ok) {
    if (verified.reason === 'expired')
      throw new ApiError(401, 'expired', 'The access token expired.')
    throw new ApiError(401, 'revoked', 'The access token is not valid.')
  }
  const { sub, did } = verified.claims
  const device = await deps.db
    .prepare(`SELECT retiredAt, revokedAt, lastSeenAt FROM devices WHERE sub = ?1 AND id = ?2`)
    .bind(sub, did)
    .first<Pick<DeviceRow, 'retiredAt' | 'revokedAt' | 'lastSeenAt'>>()
  if (!device) throw new ApiError(401, 'unknown_device', 'This device is not registered.')
  if (device.revokedAt !== null) throw new ApiError(401, 'revoked', 'This device was revoked.')
  if (device.retiredAt !== null) throw new ApiError(401, 'retired', 'This device was retired.')

  const now = deps.now()
  if (now - device.lastSeenAt >= LAST_SEEN_GRANULARITY_MS) {
    await deps.db
      .prepare(`UPDATE devices SET lastSeenAt = ?3 WHERE sub = ?1 AND id = ?2`)
      .bind(sub, did, now)
      .run()
  }
  return { sub, deviceId: did }
}
