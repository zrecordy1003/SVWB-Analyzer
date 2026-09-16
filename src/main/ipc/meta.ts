/**
 * 環境 - reading the public aggregate back out of the Worker.
 *
 * This is the only OUTBOUND read in the app that is not about cards or
 * updates, and it is deliberately one-way: `GET /v1/meta` carries no install
 * id, no headers of ours, no body, and nothing about this machine. So the page
 * works, and is allowed to work, whether or not the user uploads anything -
 * tying the read to the upload switch would make the switch a paywall rather
 * than a privacy control, and would tell the user that looking at a public
 * number costs them their own data. See `docs/meta-stats-plan.md` P6.
 *
 * It runs in main rather than as a `fetch` in the renderer for two reasons
 * that are not interchangeable: the endpoint is the one in `config.ts`, which
 * only main can read (and which a dev build overrides with
 * `SVWB_TELEMETRY_URL`), and a renderer `fetch` would be subject to the page's
 * CSP and would put a network error in front of the user as a console trace
 * instead of as a sentence.
 */
import { net } from 'electron'

import { wrapRes, type Res } from '../../shared/ipc.js'
import type { MetaDocument, MetaSnapshot } from '../../shared/meta.js'
import { telemetryEndpoint } from '../telemetry/config.js'
import { handleIpc } from './typed.js'

const REQUEST_TIMEOUT_MS = 15_000

/**
 * How long a fetched document is reused without asking again.
 *
 * Matched to the Worker's own `META_CACHE_SECONDS` (900). Asking more often
 * than the edge regenerates cannot return anything new, and this endpoint is
 * rate limited per caller address - so a page that refetched on every mount
 * would spend that budget to redraw the same numbers. The refresh button
 * bypasses this; the Worker's cache is what stands behind it then.
 */
const CACHE_TTL_MS = 15 * 60_000

/** What the endpoint itself accepts. A wider ask is a bug, not a preference. */
const MIN_DAYS = 1
const MAX_DAYS = 90

type Entry = { snapshot: MetaSnapshot; at: number }
/** Keyed by window, because the windows are separate documents. */
const cache = new Map<number, Entry>()

/** Tests and the dev override reach the endpoint through here, as telemetry does. */
type Deps = { fetch: (url: string, init?: RequestInit) => Promise<Response>; now: () => number }
const productionDeps: Deps = { fetch: (url, init) => net.fetch(url, init), now: () => Date.now() }
let deps: Deps = productionDeps

export function configureMetaForTests(overrides: Partial<Deps> | null): void {
  deps = overrides ? { ...productionDeps, ...overrides } : productionDeps
  cache.clear()
}

/**
 * Is this actually the document, or a proxy's idea of one?
 *
 * The check is shallow on purpose - it is not a schema validator, it is the
 * line between "the page can draw this" and "the page would throw somewhere
 * below the fold". A captive portal answering 200 with an HTML login page is
 * the realistic failure, and it fails on the first test here.
 */
function looksLikeMeta(value: unknown): value is MetaDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Partial<MetaDocument>
  return (
    Array.isArray(doc.cells) &&
    Array.isArray(doc.byClass) &&
    typeof doc.generatedAt === 'string' &&
    typeof doc.installs === 'number' &&
    typeof doc.window === 'object' &&
    doc.window !== null
  )
}

async function fetchMeta(days: number, refresh: boolean): Promise<MetaSnapshot> {
  const endpoint = telemetryEndpoint()
  /**
   * No endpoint is a state the page has to explain, not an error to log.
   *
   * Every build made before 2026-09-02 has an empty `BUILT_IN_ENDPOINT` and
   * cannot be redirected afterwards, so "this version of the app has nowhere
   * to ask" is a permanent, correct answer for those installs - and the
   * renderer says so in a sentence rather than showing a failed request.
   */
  if (!endpoint) throw new Error('這個版本沒有內建統計端點，請更新到較新的版本。')

  const now = deps.now()
  const hit = cache.get(days)
  if (!refresh && hit && now - hit.at < CACHE_TTL_MS) {
    return { ...hit.snapshot, cached: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await deps.fetch(`${endpoint}/v1/meta?days=${days}`, {
      method: 'GET',
      // `no-cache` on the REQUEST is what the Worker reads to skip its edge
      // copy (see its `bypass`), so the refresh button reaches the database
      // rather than returning the same cached body it just declined to reuse.
      headers: refresh ? { 'cache-control': 'no-cache' } : {},
      signal: controller.signal
    })
    if (res.status === 429) throw new Error('伺服器目前限制了查詢頻率，請稍後再試。')
    if (!res.ok) throw new Error(`伺服器回應 HTTP ${res.status}`)

    const body: unknown = await res.json()
    if (!looksLikeMeta(body)) throw new Error('伺服器回應的格式無法辨識。')

    const snapshot: MetaSnapshot = {
      document: body,
      fetchedAt: new Date(deps.now()).toISOString(),
      cached: false
    }
    cache.set(days, { snapshot, at: deps.now() })
    return snapshot
  } catch (e) {
    const error = e as Error
    if (error.name === 'AbortError') throw new Error('連線逾時，請稍後再試。')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function registerMetaIpc(): void {
  handleIpc('meta:fetch', async (_e, params): Promise<Res<MetaSnapshot>> => {
    const requested = Number(params?.days)
    const days = Number.isInteger(requested)
      ? Math.min(Math.max(requested, MIN_DAYS), MAX_DAYS)
      : 14
    return wrapRes(() => fetchMeta(days, params?.refresh === true))
  })
}
