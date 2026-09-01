/**
 * The class icon cache.
 *
 * The seven class emblems (plus neutral) as the game draws them, fetched from
 * the portal's own asset directory. It stands on exactly the reasoning that
 * `cardImages.ts` stands on - nothing is bundled, nothing is redistributed, the
 * user's own machine fetches into the user's own disk - and shares its kill
 * switch, so see that file's header and docs/deck-import-plan.md, "本專案散布的
 * 是什麼", rather than repeating it here.
 *
 * What is DIFFERENT from card art is what shapes this file:
 *
 * - The key space is closed. Eight names, listed below, so there is no hash to
 *   validate and no per-language split: a request either names one of the eight
 *   or it is rejected outright.
 * - It is tiny. All eight together are under 20KB, which is why there is no
 *   ceiling and no eviction here - the whole reason `cardImages` needs both is
 *   a card pool that runs to hundreds of megabytes.
 * - The filenames carry NO content hash, unlike `/uploads/card_image/…`. A card
 *   image URL is immutable, so it can be cached forever; `class_elf.svg` is the
 *   same URL before and after a redraw, so a permanent cache would pin a stale
 *   emblem for the life of the install. Hence the revalidation window below.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { PORTAL_ORIGIN } from './svwbApi.js'

/**
 * The eight emblems, named as the portal names its files.
 *
 * These are also exactly `classMap.ts`'s ids, which is what lets the renderer
 * ask for `svwb-card://class/<the id it already has>.svg` with no table in
 * between. `neutral` has no entry there - it is not a class a deck can be - but
 * the portal draws one and card pools use it, so it is fetchable.
 */
export const CLASS_ICON_NAMES = [
  'elf',
  'royal',
  'witch',
  'dragon',
  'nightmare',
  'bishop',
  'nemesis',
  'neutral'
] as const
export type ClassIconName = (typeof CLASS_ICON_NAMES)[number]

/** The `svwb-card://` host that means "an emblem, not card art". */
export const CLASS_ICON_HOST = 'class'

/**
 * How long a cached emblem is trusted before we ask the portal again.
 *
 * 30 days. The emblems have not changed since launch, and the cost of being a
 * month behind on one is cosmetic, so this is deliberately slack: eight
 * conditional-ish requests a month rather than eight on every launch. A failed
 * revalidation keeps serving the copy on disk - a stale emblem beats none.
 */
export const CLASS_ICON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 64KB.
 *
 * Not a cache budget - a sanity check. The largest emblem is 3.5KB, and the
 * thing this actually keeps out is the portal's 29KB HTML error document, which
 * is what a wrong path returns. Anything this size is not an emblem.
 */
const MAX_ICON_BYTES = 64 * 1024

const isKnown = (name: string): name is ClassIconName =>
  (CLASS_ICON_NAMES as readonly string[]).includes(name)

/**
 * Read `svwb-card://class/<name>.svg`.
 *
 * Strict for the same reason its card-art counterpart is: this is where a
 * renderer-supplied string becomes both a filesystem path and an outbound URL.
 * Membership of the closed set is the whole check - no escaping, no
 * normalisation, no sanitising - so `..` and friends never reach a path join.
 */
export function parseClassIconUrl(rawUrl: string): ClassIconName | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'svwb-card:') return null
  if (url.hostname !== CLASS_ICON_HOST) return null

  const name = url.pathname
    .replace(/^\/+/, '')
    .replace(/\.svg$/i, '')
    .toLowerCase()
  return isKnown(name) ? name : null
}

/**
 * Where the portal keeps them.
 *
 * Note the path is NOT content-hashed, unlike most of `/assets/` - the site's
 * build fingerprints its bundled images (`header_logo.CJIn198….png`) but serves
 * these from a plain directory. That is what makes a fixed URL possible at all,
 * and also what makes the revalidation window necessary.
 */
export function portalClassIconUrl(name: ClassIconName): string {
  return `${PORTAL_ORIGIN}/assets/images/common/common/class/class_${name}.svg`
}

export function classIconFilePath(root: string, name: ClassIconName): string {
  // `name` came through `isKnown`, so this cannot be anything but a bare
  // filename in `root`. Asserted rather than trusted, because the cost of being
  // wrong here is an arbitrary write.
  if (!isKnown(name)) throw new Error(`refusing to build a path for class "${name}"`)
  return path.join(root, `class_${name}.svg`)
}

/* ================================
 * Cache bookkeeping
 * ================================ */

export async function classIconCacheStats(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const name of CLASS_ICON_NAMES) {
    try {
      const stat = await fs.stat(classIconFilePath(root, name))
      files++
      bytes += stat.size
    } catch {
      // Not fetched yet, which is the normal state for `neutral`.
    }
  }
  return { files, bytes }
}

export async function clearClassIconCache(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
}

/* ================================
 * Resolution
 * ================================ */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let injectedFetch: FetchLike | null = null

/** Tests supply their own transport; production resolves Electron's `net.fetch`. */
export function setClassIconFetchForTests(fn: FetchLike | null): void {
  injectedFetch = fn
  inFlight.clear()
}

async function iconFetch(url: string): Promise<Response> {
  if (injectedFetch) return injectedFetch(url)
  const { net } = await import('electron')
  return net.fetch(url)
}

/**
 * One download per emblem at a time. A class dropdown mounts all seven at once,
 * and a filter bar plus a deck list can mount the same one several times over.
 */
const inFlight = new Map<ClassIconName, Promise<string | null>>()

const ICON_TIMEOUT_MS = 10_000

export type ResolveClassIconOptions = {
  root: string
  /** Overridden by tests; production takes `CLASS_ICON_MAX_AGE_MS`. */
  maxAgeMs?: number
}

/** An emblem, or an HTML error page wearing a 200. */
const looksLikeSvg = (body: Buffer): boolean => {
  const head = body.subarray(0, 256).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<svg') || head.startsWith('<?xml')
}

async function download(name: ClassIconName, file: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ICON_TIMEOUT_MS)
  try {
    const res = await iconFetch(portalClassIconUrl(name))
    if (!res.ok) return null
    const body = Buffer.from(await res.arrayBuffer())
    if (body.byteLength === 0 || body.byteLength > MAX_ICON_BYTES) return null
    if (!looksLikeSvg(body)) return null

    await fs.mkdir(path.dirname(file), { recursive: true })
    // Write beside the target and rename, so a reader can never observe half an
    // SVG - the same pattern the card cache and the capture path use.
    const tmp = `${file}.${name}.tmp`
    await fs.writeFile(tmp, body)
    await fs.rename(tmp, file)
    return file
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Give back a path to the emblem on disk, fetching it first if need be.
 *
 * Returns null only when there is nothing at all to show. A stale copy that
 * could not be revalidated is returned as-is: the caller's job is to keep
 * rendering, and an emblem a month old is indistinguishable from a fresh one in
 * every case that has actually happened.
 *
 * Unlike `resolveCardImage`, this never touches mtime on a hit. There is no
 * eviction to order, and mtime is the age signal - touching it on read would
 * mean an emblem in daily use is never revalidated.
 */
export async function resolveClassIcon(
  name: ClassIconName,
  options: ResolveClassIconOptions
): Promise<string | null> {
  const file = classIconFilePath(options.root, name)
  const maxAgeMs = options.maxAgeMs ?? CLASS_ICON_MAX_AGE_MS

  let cached = false
  let stale = false
  try {
    const stat = await fs.stat(file)
    cached = stat.size > 0
    stale = Date.now() - stat.mtimeMs > maxAgeMs
  } catch {
    // Not cached yet.
  }
  if (cached && !stale) return file

  const existing = inFlight.get(name)
  if (existing) return existing

  const pending = (async (): Promise<string | null> => {
    try {
      const fetched = await download(name, file)
      // Falling back to the stale copy is the point of separating these two:
      // a revalidation that fails must not blank an emblem the user can see.
      return fetched ?? (cached ? file : null)
    } finally {
      inFlight.delete(name)
    }
  })()

  inFlight.set(name, pending)

  if (cached) {
    // Already have something displayable, so do not make the <img> wait on a
    // revalidation it does not need. The fetch runs on to completion and the
    // next mount gets the fresh copy.
    return file
  }
  return Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ICON_TIMEOUT_MS))
  ])
}
