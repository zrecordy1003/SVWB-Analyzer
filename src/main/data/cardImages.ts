/**
 * The card image cache.
 *
 * Card art is not ours to ship: nothing here is bundled, and nothing is
 * redistributed. The user's own machine fetches from Cygames' own servers into
 * the user's own disk, the same way a browser caches an image it displays. See
 * docs/deck-import-plan.md, "本專案散布的是什麼".
 *
 * Three consequences shape this file:
 *
 * - The whole directory is disposable. There is no index to keep in sync and no
 *   migration: the file NAME is the cache key, and a missing file just means a
 *   re-download. Least-recently-used order comes from mtime, touched on read.
 * - There must be a hard ceiling. A full card pool at full size runs to several
 *   hundred megabytes, and this is a win-rate tracker, not an art gallery.
 * - It must be possible to turn the whole thing off without the UI noticing.
 *   Cygames may withdraw permission at any time (guideline §2), so the switch
 *   lives below the renderer, which only ever asks for `svwb-card://…`.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { PORTAL_ORIGIN, type PortalLang } from './svwbApi.js'

/**
 * `card` is the full art (~470KB), `list` the banner crop (~130KB).
 *
 * They take DIFFERENT hashes - `card_image_hash` and `card_banner_image_hash`
 * respectively - and swapping them returns 403. Grids should ask for `list`.
 */
export const CARD_IMAGE_VARIANTS = ['card', 'list'] as const
export type CardImageVariant = (typeof CARD_IMAGE_VARIANTS)[number]

/**
 * 600MB.
 *
 * Sized to what the app actually asks for, not to a round number. The builder's
 * pool grid shows FULL art (530x687, ~470KB), and one class's pool is ~175
 * cards - about 82MB. At the old 200MB ceiling, browsing a third class evicted
 * the first, so switching back re-downloaded a pool the user had already
 * fetched. 600MB holds roughly seven of them.
 *
 * This is a ceiling, not a reservation: nothing is stored until it is displayed,
 * and Settings shows the running total with a clear button next to it.
 */
export const DEFAULT_CACHE_LIMIT_BYTES = 600 * 1024 * 1024

/** Evicting down to exactly the cap would evict again on the very next write. */
const EVICT_TO_FRACTION = 0.85

const HASH_RE = /^[0-9a-f]{32}$/
const LANG_RE = /^[a-z]{2,4}$/

export type CardImageRequest = { variant: CardImageVariant; hash: string }

/**
 * Read `svwb-card://<variant>/<hash>` .
 *
 * Strict on purpose. This is the one place a renderer-supplied string becomes a
 * filesystem path and an outbound URL, so anything that is not exactly a known
 * variant and a 32-character hex hash is rejected rather than sanitised - there
 * is no legitimate input this turns away.
 */
export function parseCardImageUrl(rawUrl: string): CardImageRequest | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'svwb-card:') return null

  const variant = url.hostname
  if (!(CARD_IMAGE_VARIANTS as readonly string[]).includes(variant)) return null

  const hash = url.pathname
    .replace(/^\/+/, '')
    .replace(/\.png$/i, '')
    .toLowerCase()
  if (!HASH_RE.test(hash)) return null

  return { variant: variant as CardImageVariant, hash }
}

export function portalImageUrl(req: CardImageRequest, lang: PortalLang): string {
  return `${PORTAL_ORIGIN}/uploads/card_image/${lang}/${req.variant}/${req.hash}.png`
}

export function cacheFilePath(root: string, req: CardImageRequest, lang: PortalLang): string {
  if (!LANG_RE.test(lang)) throw new Error(`refusing to build a path for lang "${lang}"`)
  return path.join(root, lang, req.variant, `${req.hash}.png`)
}

/* ================================
 * Cache bookkeeping
 * ================================ */

type CachedFile = { path: string; size: number; mtimeMs: number }

async function walk(root: string): Promise<CachedFile[]> {
  const out: CachedFile[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.png')) continue
    // `parentPath` is where recursive readdir reports the containing directory.
    const full = path.join(entry.parentPath ?? root, entry.name)
    try {
      const stat = await fs.stat(full)
      out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // Raced with an eviction or a manual delete; it is a cache, so skip it.
    }
  }
  return out
}

export async function cardImageCacheStats(root: string): Promise<{ files: number; bytes: number }> {
  const files = await walk(root)
  return { files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) }
}

/**
 * Delete least-recently-used files until the cache is comfortably under the cap.
 *
 * mtime is the recency signal because `resolveCardImage` touches it on every
 * hit. That keeps the whole scheme stateless: no sidecar index can drift out of
 * sync with what is actually on disk.
 */
export async function evictCardImages(
  root: string,
  maxBytes = DEFAULT_CACHE_LIMIT_BYTES
): Promise<{ deleted: number; bytes: number }> {
  const files = await walk(root)
  let total = files.reduce((sum, f) => sum + f.size, 0)
  if (total <= maxBytes) return { deleted: 0, bytes: 0 }

  const target = maxBytes * EVICT_TO_FRACTION
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)

  let deleted = 0
  let freed = 0
  for (const file of files) {
    if (total <= target) break
    try {
      await fs.unlink(file.path)
      total -= file.size
      freed += file.size
      deleted++
    } catch {
      // Already gone, or locked by a reader. Either way, move on.
    }
  }
  return { deleted, bytes: freed }
}

export async function clearCardImageCache(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
}

/* ================================
 * Resolution
 * ================================ */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let injectedFetch: FetchLike | null = null

/** Tests supply their own transport; production resolves Electron's `net.fetch`. */
export function setCardImageFetchForTests(fn: FetchLike | null): void {
  injectedFetch = fn
  inFlight.clear()
}

async function imageFetch(url: string): Promise<Response> {
  if (injectedFetch) return injectedFetch(url)
  const { net } = await import('electron')
  return net.fetch(url)
}

/**
 * One download per URL at a time.
 *
 * A deck view mounts forty images at once and several of them can be the same
 * card art; without this, opening one deck would be forty concurrent requests
 * to Cygames for eight distinct files.
 */
const inFlight = new Map<string, Promise<string | null>>()

const IMAGE_TIMEOUT_MS = 15_000

export type ResolveOptions = {
  root: string
  lang: PortalLang
  maxBytes?: number
}

/**
 * Give back a path to the image on disk, downloading it first if need be.
 *
 * Returns null rather than throwing when the art cannot be had: a card with no
 * picture is a cosmetic problem, and the caller's job is to keep rendering.
 */
export async function resolveCardImage(
  req: CardImageRequest,
  options: ResolveOptions
): Promise<string | null> {
  const file = cacheFilePath(options.root, req, options.lang)

  try {
    await fs.access(file)
    // Touch so this counts as recently used. Failing to touch only costs
    // accuracy in eviction order, so it must not fail the read.
    const now = new Date()
    await fs.utimes(file, now, now).catch(() => {})
    return file
  } catch {
    // Not cached yet.
  }

  const url = portalImageUrl(req, options.lang)
  const existing = inFlight.get(url)
  if (existing) return existing

  const download = (async (): Promise<string | null> => {
    try {
      const res = await imageFetch(url)
      if (!res.ok) return null
      const body = Buffer.from(await res.arrayBuffer())
      if (body.byteLength === 0) return null

      await fs.mkdir(path.dirname(file), { recursive: true })
      // Write beside the target and rename, so a reader can never observe a
      // half-written PNG - the same pattern the capture path uses.
      const tmp = `${file}.${createHash('sha1').update(url).digest('hex').slice(0, 8)}.tmp`
      await fs.writeFile(tmp, body)
      await fs.rename(tmp, file)

      await evictCardImages(options.root, options.maxBytes ?? DEFAULT_CACHE_LIMIT_BYTES)
      return file
    } catch {
      return null
    } finally {
      inFlight.delete(url)
    }
  })()

  inFlight.set(url, download)

  // The timeout guards the caller, not the download: a stuck request must not
  // hold an <img> open forever, but letting it finish still populates the cache.
  return Promise.race([
    download,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), IMAGE_TIMEOUT_MS))
  ])
}
