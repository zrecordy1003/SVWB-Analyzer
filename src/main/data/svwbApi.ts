/**
 * The one place that talks to shadowverse-wb.com.
 *
 * Everything about the portal that is not pure data-shaping lives here:
 * transport, language, timeouts, retries and caching. The parsing next door in
 * `src/shared/deckImport.ts` stays pure so it can be tested without a socket,
 * and the renderer never learns the portal's URL - it asks over IPC and gets a
 * `DeckImportPreview` back.
 *
 * Stage A needs only the two read endpoints, which take no credentials at all.
 * The write path (getDeckHash / DeckCode.publish) additionally needs a `sid`
 * cookie plus a CSRF token from a GET in the SAME session; see
 * docs/deck-import-plan.md before adding it, because a wrong payload there
 * returns `result_code: 1` with an empty hash rather than an error.
 */
import {
  buildDeckHashPayload,
  normalizeCardPoolResponse,
  normalizeDeckResponse,
  type DeckHashRequest,
  type DeckImportPreview,
  type ParsedDeckInput,
  type PoolCard
} from '../../shared/deckImport.js'

export const PORTAL_ORIGIN = 'https://shadowverse-wb.com'

/**
 * The portal's language switch is a custom `Lang` REQUEST HEADER.
 *
 * Not a query parameter, not `Accept-Language`, not a cookie, not the `/cht/`
 * path prefix - all four were tried and all four return Japanese. Card names
 * and skill text are the only thing this affects, but they are the whole point.
 */
export type PortalLang = 'ja' | 'en' | 'cht' | 'chs' | 'ko'
export const PORTAL_LANGS: readonly PortalLang[] = ['ja', 'en', 'cht', 'chs', 'ko'] as const
export const DEFAULT_PORTAL_LANG: PortalLang = 'cht'

export type SvwbErrorCode =
  /** Not a deck code, hash or share link. Never reached the network. */
  | 'INVALID_INPUT'
  /** The portal has no such deck. A mistyped code and an expired one are indistinguishable. */
  | 'NOT_FOUND_OR_EXPIRED'
  /** Offline, timed out, or a non-2xx response. */
  | 'NETWORK'
  /** Answered, but not in a shape we can read at all. */
  | 'UNEXPECTED_SHAPE'

export class SvwbApiError extends Error {
  constructor(
    readonly code: SvwbErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SvwbApiError'
  }
}

/** `data_headers.result_code` values seen in the wild. */
const RESULT_OK = 1
const RESULT_NOT_FOUND = 10200

const REQUEST_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 5 * 60_000

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let injectedFetch: FetchLike | null = null

/** Tests supply their own transport; production resolves Electron's `net.fetch`. */
export function setPortalFetchForTests(fn: FetchLike | null): void {
  injectedFetch = fn
  cache.clear()
}

async function portalFetch(url: string, init: RequestInit): Promise<Response> {
  if (injectedFetch) return injectedFetch(url, init)
  // Imported lazily so the module stays usable in a plain node test process,
  // where importing electron at the top level would fail before any mock ran.
  const { net } = await import('electron')
  return net.fetch(url, init)
}

/* ================================
 * Cache
 * ================================ */

type CacheEntry = { at: number; preview: DeckImportPreview }
const cache = new Map<string, CacheEntry>()

const cacheKey = (input: ParsedDeckInput, lang: PortalLang): string =>
  `${lang}:${input.kind}:${input.value}`

/**
 * Drop the cache. Called when the language changes, because every cached
 * preview carries card names in the old one.
 */
export function clearDeckCache(): void {
  cache.clear()
}

/* ================================
 * Requests
 * ================================ */

function headers(lang: PortalLang): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    Lang: lang,
    'X-Requested-With': 'XMLHttpRequest'
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) {
    throw new SvwbApiError('NETWORK', `portal returned HTTP ${res.status}`)
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new SvwbApiError('UNEXPECTED_SHAPE', 'portal response was not JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SvwbApiError('UNEXPECTED_SHAPE', 'portal response was not an object')
  }
  return parsed as Record<string, unknown>
}

/**
 * One attempt at whichever endpoint the input calls for.
 *
 * Both endpoints return the same `data` shape, so only the request differs -
 * the code path rejoins immediately after.
 */
async function requestDeck(
  input: ParsedDeckInput,
  lang: PortalLang,
  signal: AbortSignal
): Promise<unknown> {
  const res =
    input.kind === 'code'
      ? await portalFetch(`${PORTAL_ORIGIN}/web/DeckCode/getDeck`, {
          method: 'POST',
          headers: { ...headers(lang), 'Content-Type': 'application/json' },
          body: JSON.stringify({ deck_code: input.value }),
          signal
        })
      : await portalFetch(
          `${PORTAL_ORIGIN}/web/DeckBuilder/deckHashDetail?hash=${encodeURIComponent(input.value)}`,
          { method: 'GET', headers: headers(lang), signal }
        )

  const body = await readJson(res)
  const dataHeaders = body.data_headers as { result_code?: unknown } | undefined
  const resultCode = typeof dataHeaders?.result_code === 'number' ? dataHeaders.result_code : null

  if (resultCode === RESULT_NOT_FOUND || (resultCode !== RESULT_OK && body.data == null)) {
    // A wrong code and a code whose three minutes ran out answer identically;
    // the message has to cover both because the portal will not say which.
    throw new SvwbApiError(
      'NOT_FOUND_OR_EXPIRED',
      input.kind === 'code' ? 'deck code not found or expired' : 'no deck for that hash'
    )
  }
  if (body.data == null) {
    throw new SvwbApiError('UNEXPECTED_SHAPE', `portal result_code ${resultCode ?? 'missing'}`)
  }
  return body.data
}

/**
 * Resolve a parsed deck code / hash into a preview.
 *
 * Retries once, and only on a network failure: a `NOT_FOUND_OR_EXPIRED` will
 * never change its mind, and hammering the portal over a typo is exactly the
 * behaviour a courtesy budget is meant to prevent.
 */
export async function fetchDeck(
  input: ParsedDeckInput,
  options: { lang?: PortalLang; timeoutMs?: number } = {}
): Promise<DeckImportPreview> {
  const lang = options.lang ?? DEFAULT_PORTAL_LANG
  const key = cacheKey(input, lang)

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.preview

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  let lastNetworkError: unknown = null

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const data = await requestDeck(input, lang, controller.signal)
      const preview = normalizeDeckResponse(data, input)
      if (!preview) {
        throw new SvwbApiError('UNEXPECTED_SHAPE', 'deck payload had no readable card list')
      }
      cache.set(key, { at: Date.now(), preview })
      return preview
    } catch (e) {
      if (e instanceof SvwbApiError && e.code !== 'NETWORK') throw e
      lastNetworkError = e
    } finally {
      clearTimeout(timer)
    }
  }

  throw new SvwbApiError(
    'NETWORK',
    lastNetworkError instanceof Error ? lastNetworkError.message : 'could not reach the portal'
  )
}

/* ================================
 * The write path
 * ================================ */

/**
 * A portal session: the `sid` cookie and a CSRF token issued against it.
 *
 * Reads need neither. Writes need BOTH, and they must come from the same
 * session - a valid token with no cookie is rejected with `1021`, which is the
 * same code a malformed payload gets, so the two are easy to confuse.
 *
 * `GET /web/Login/status` issues both in one response, which is why it is the
 * seed. Do NOT seed from an HTML page: curl gets a cookie from those, Node's
 * fetch does not (`getSetCookie()` comes back empty), and the difference is
 * invisible until a write fails.
 */
type PortalSession = { cookie: string; csrf: string; at: number }

let session: PortalSession | null = null

/** Tokens are not documented as expiring; re-seed hourly rather than trust that. */
const SESSION_TTL_MS = 60 * 60_000

/** Tests start from a clean session; production never calls this. */
export function clearPortalSession(): void {
  session = null
}

async function openSession(lang: PortalLang): Promise<PortalSession> {
  const res = await portalFetch(`${PORTAL_ORIGIN}/web/Login/status`, {
    method: 'GET',
    headers: headers(lang)
  })
  const body = await readJson(res)
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('sid='))
    .join('; ')
  const dataHeaders = body.data_headers as { csrf_token?: unknown } | undefined
  const csrf = typeof dataHeaders?.csrf_token === 'string' ? dataHeaders.csrf_token : ''

  if (!csrf) {
    throw new SvwbApiError('UNEXPECTED_SHAPE', 'portal issued no CSRF token')
  }
  return { cookie, csrf, at: Date.now() }
}

async function ensureSession(lang: PortalLang, force = false): Promise<PortalSession> {
  if (!force && session && Date.now() - session.at < SESSION_TTL_MS) return session
  session = await openSession(lang)
  return session
}

/**
 * Adopt the CSRF token the portal just handed back.
 *
 * **Tokens are single-use and rotate on every response.** Reusing one is
 * rejected with `1021`, so the second write of a sequence fails - which is
 * exactly the sequence that matters here (`getDeckHash` then
 * `DeckCode/publish`). Every response carries the next token in
 * `data_headers.csrf_token`, and this is what keeps hold of it.
 *
 * Verified against the live portal: publishing twice in a row works when each
 * call uses the token returned by the previous response, and fails when the
 * first token is sent again.
 */
function rememberToken(body: Record<string, unknown>): void {
  if (!session) return
  const next = (body.data_headers as { csrf_token?: unknown } | undefined)?.csrf_token
  if (typeof next === 'string' && next !== '') {
    session = { ...session, csrf: next }
  }
}

function writeHeaders(lang: PortalLang, current: PortalSession): Record<string, string> {
  return {
    ...headers(lang),
    'Content-Type': 'application/json',
    'X-Csrf-Token': current.csrf,
    // Sent explicitly rather than left to a cookie jar, so the same code works
    // under Electron's session, a plain fetch, and an injected test transport.
    ...(current.cookie ? { Cookie: current.cookie } : {})
  }
}

/**
 * POST to a write endpoint, re-seeding the session once if it is refused.
 *
 * `1021` means "bad request OR bad credentials" and the portal will not say
 * which, so a single retry with a fresh session is the only way to tell a stale
 * token from a genuinely wrong payload - if the retry fails too, it is us.
 */
async function portalWrite(
  path: string,
  body: unknown,
  lang: PortalLang,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // Inside the try: seeding the session is itself a request, and a failure
      // there is a NETWORK failure like any other. Outside, it escaped as a raw
      // Error and the caller saw 'offline' where it expected a code.
      const current = await ensureSession(lang, attempt > 0)
      const res = await portalFetch(`${PORTAL_ORIGIN}${path}`, {
        method: 'POST',
        headers: writeHeaders(lang, current),
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const parsed = await readJson(res)
      // Before anything else: the response carries the token the NEXT write
      // must use, and dropping it here is what makes a two-step flow fail.
      rememberToken(parsed)
      const dataHeaders = parsed.data_headers as { result_code?: unknown } | undefined
      if (dataHeaders?.result_code === RESULT_OK) return parsed
      if (attempt === 0) continue
      throw new SvwbApiError(
        'UNEXPECTED_SHAPE',
        `portal rejected the write (result_code ${String(dataHeaders?.result_code ?? 'missing')})`
      )
    } catch (e) {
      if (e instanceof SvwbApiError) throw e
      if (attempt === 0) continue
      throw new SvwbApiError('NETWORK', e instanceof Error ? e.message : 'write failed')
    } finally {
      clearTimeout(timer)
    }
  }
  throw new SvwbApiError('NETWORK', 'write failed')
}

/**
 * Encode a card list into a long deck hash.
 *
 * An EMPTY hash is a failure, not a result: the portal answers `result_code: 1`
 * with `data.hash: ""` when the payload shape is wrong, so checking the code
 * alone would report success and hand the user a broken share link.
 */
export async function requestDeckHash(
  deck: DeckHashRequest,
  options: { lang?: PortalLang; timeoutMs?: number } = {}
): Promise<string> {
  const lang = options.lang ?? DEFAULT_PORTAL_LANG
  const body = await portalWrite(
    '/web/DeckBuilder/getDeckHash',
    buildDeckHashPayload(deck),
    lang,
    options.timeoutMs ?? REQUEST_TIMEOUT_MS
  )
  const hash = (body.data as { hash?: unknown } | undefined)?.hash
  if (typeof hash !== 'string' || hash === '') {
    throw new SvwbApiError('UNEXPECTED_SHAPE', 'portal returned an empty deck hash')
  }
  return hash
}

/**
 * Publish a hash as a 4-character in-game deck code.
 *
 * The code dies three minutes after issue. Calling this again with the same
 * hash re-publishes it, which is how the portal's own page keeps one alive - see
 * `DECK_CODE_RENEW_MS`.
 */
export async function publishDeckCode(
  hash: string,
  options: { lang?: PortalLang; timeoutMs?: number } = {}
): Promise<string> {
  const lang = options.lang ?? DEFAULT_PORTAL_LANG
  const body = await portalWrite(
    '/web/DeckCode/publish',
    { hash },
    lang,
    options.timeoutMs ?? REQUEST_TIMEOUT_MS
  )
  const code = (body.data as { deck_code?: unknown } | undefined)?.deck_code
  if (typeof code !== 'string' || code === '') {
    throw new SvwbApiError('UNEXPECTED_SHAPE', 'portal returned no deck code')
  }
  return code
}

/**
 * Fetch one class's slice of a format's card pool.
 *
 * The endpoint takes "neutral plus one class" and rejects a request for all of
 * them at once, so a full pool is seven calls. Each is ~560KB, which is why the
 * caller syncs a class at a time, on demand, rather than everything up front.
 *
 * Not cached in memory: the result goes straight into `Card` / `CardPool`, and
 * SQLite is the cache. A second in-process copy of several megabytes of card
 * text would only be a way for the two to disagree.
 */
export async function fetchCardPool(
  params: { classId: number; battleFormat: number },
  options: { lang?: PortalLang; timeoutMs?: number } = {}
): Promise<PoolCard[]> {
  const lang = options.lang ?? DEFAULT_PORTAL_LANG
  const controller = new AbortController()
  // Generous next to a deck lookup: this is a ~560KB body, not a 40-card list.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)

  try {
    const res = await portalFetch(
      `${PORTAL_ORIGIN}/web/DeckBuilder/cards?class=0,${params.classId}&battle_format=${params.battleFormat}`,
      { method: 'GET', headers: headers(lang), signal: controller.signal }
    )
    const body = await readJson(res)
    if (body.data == null) {
      throw new SvwbApiError('UNEXPECTED_SHAPE', 'card pool response had no data')
    }
    const cards = normalizeCardPoolResponse(body.data)
    if (!cards) {
      throw new SvwbApiError('UNEXPECTED_SHAPE', 'card pool response had no readable cards')
    }
    return cards
  } catch (e) {
    if (e instanceof SvwbApiError) throw e
    throw new SvwbApiError('NETWORK', e instanceof Error ? e.message : 'could not reach the portal')
  } finally {
    clearTimeout(timer)
  }
}
