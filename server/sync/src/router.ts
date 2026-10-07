/**
 * Routing and the cross-cutting policy: kill switch, rate limits, bearer auth,
 * error shaping. Handlers live in their own modules; this file is the table of
 * contents for docs/sync-protocol.md.
 *
 *   /health                         liveness
 *   GET  /auth/start                auth.ts   startLogin
 *   GET  /auth/callback             auth.ts   finishLogin
 *   POST /v1/auth/token             auth.ts   exchangeGrant
 *   POST /v1/auth/refresh           auth.ts   refreshSession
 *   POST /v1/auth/logout            devices.ts logout           (bearer)
 *   GET  /v1/me                     account.ts me
 *   GET  /v1/devices                devices.ts listDevices
 *   POST /v1/devices/{id}/revoke    devices.ts revokeDevice
 *   POST /v1/account/delete         account.ts deleteAccount
 *   GET  /v1/account/export         account.ts exportAccount
 *   GET  /v1/segments               segments.ts listSegments
 *   PUT  /v1/segments/{seq}         segments.ts putSegment
 *   PUT  /v1/snapshot?upToSeq=N     segments.ts putSnapshot
 *   GET  /v1/segments/{dev}/{seq}   segments.ts getSegment
 *   GET  /v1/snapshots/{dev}        segments.ts getSnapshot
 */
import { deleteAccount, exportAccount, me } from './account'
import { authenticate, exchangeGrant, finishLogin, refreshSession, startLogin } from './auth'
import { listDevices, logout, revokeDevice } from './devices'
import { ApiError, errorResponse, json } from './http'
import { RETRY_AFTER_KILL_SWITCH, rateLimited, withinLimit } from './limits'
import { getSegment, getSnapshot, listSegments, putSegment, putSnapshot } from './segments'
import type { Deps, Session } from './types'

/** `/auth/*` and `/v1/auth/*`: the login path, which the kill switch spares. */
function isAuthPath(path: string): boolean {
  return path.startsWith('/auth/') || path.startsWith('/v1/auth/')
}

export async function handle(deps: Deps, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  try {
    if (path === '/health' && request.method === 'GET') return json({ ok: true })

    // The kill switch sits ahead of every other check so that flipping it
    // really does stop the load, including the work of rejecting requests.
    // Login is spared: whoever is mid-sign-in finishes, and the client's own
    // backoff keeps the rest quiet.
    if (deps.config.killSwitch && !isAuthPath(path)) {
      throw new ApiError(503, 'unavailable', 'Sync is paused. Try again later.', {
        'retry-after': String(RETRY_AFTER_KILL_SWITCH)
      })
    }
    if (!deps.secrets.sessionSecret) {
      throw new ApiError(500, 'misconfigured', 'The server is not configured.')
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    if (!(await withinLimit(deps.ipLimiter, ip))) throw rateLimited()
    if (isAuthPath(path) && !(await withinLimit(deps.authIpLimiter, ip))) throw rateLimited()

    return (await route(deps, request, url)) ?? errorResponse(notFound())
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error)
    // Not ours: a D1/R2 failure or a bug. The detail goes to the log (wrangler
    // tail); the client gets nothing it could parse a secret out of.
    console.error('sync: unhandled error', error)
    return errorResponse(new ApiError(500, 'internal', 'Something went wrong on the server.'))
  }
}

const notFound = (): ApiError => new ApiError(404, 'not_found', 'No such route.')

async function route(deps: Deps, request: Request, url: URL): Promise<Response | null> {
  const { pathname: path } = url
  const method = request.method

  // ---- unauthenticated: the login path
  if (method === 'GET' && path === '/auth/start') {
    requireGoogle(deps)
    return startLogin(deps, url)
  }
  if (method === 'GET' && path === '/auth/callback') {
    requireGoogle(deps)
    return finishLogin(deps, url)
  }
  if (method === 'POST' && path === '/v1/auth/token') return exchangeGrant(deps, request)
  if (method === 'POST' && path === '/v1/auth/refresh') return refreshSession(deps, request)

  // ---- everything else needs a bearer token. Matched BEFORE authenticating so
  // an unknown path is a 404 and not a 401 that leaks nothing but costs a read.
  const handler = matchAuthenticated(deps, request, url)
  if (!handler) return null
  const session = await authenticate(deps, request)
  if (!(await withinLimit(deps.accountLimiter, session.sub))) throw rateLimited()
  return handler(session)
}

function requireGoogle(deps: Deps): void {
  if (!deps.secrets.googleClientId || !deps.secrets.googleClientSecret) {
    throw new ApiError(500, 'misconfigured', 'Google sign-in is not configured.')
  }
}

type Handler = (session: Session) => Promise<Response>

function matchAuthenticated(deps: Deps, request: Request, url: URL): Handler | null {
  const { pathname: path } = url
  const method = request.method
  let m: RegExpExecArray | null

  if (method === 'POST' && path === '/v1/auth/logout') return (s) => logout(deps, s)
  if (method === 'GET' && path === '/v1/me') return (s) => me(deps, s)
  if (method === 'GET' && path === '/v1/devices') return (s) => listDevices(deps, s)
  if (method === 'POST' && (m = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(path))) {
    const id = decodeURIComponent(m[1])
    return (s) => revokeDevice(deps, s, id)
  }
  if (method === 'POST' && path === '/v1/account/delete') return (s) => deleteAccount(deps, s)
  if (method === 'GET' && path === '/v1/account/export') return (s) => exportAccount(deps, s)

  if (method === 'GET' && path === '/v1/segments') return (s) => listSegments(deps, s)
  if (method === 'PUT' && (m = /^\/v1\/segments\/([^/]+)$/.exec(path))) {
    const seq = m[1]
    return (s) => putSegment(deps, s, seq, request)
  }
  if (method === 'PUT' && path === '/v1/snapshot') {
    return (s) => putSnapshot(deps, s, url.searchParams.get('upToSeq'), request)
  }
  if (method === 'GET' && (m = /^\/v1\/segments\/([^/]+)\/([^/]+)$/.exec(path))) {
    const [device, seq] = [decodeURIComponent(m[1]), m[2]]
    return (s) => getSegment(deps, s, device, seq)
  }
  if (method === 'GET' && (m = /^\/v1\/snapshots\/([^/]+)$/.exec(path))) {
    const device = decodeURIComponent(m[1])
    return (s) => getSnapshot(deps, s, device)
  }
  return null
}
