/**
 * The `svwb-card://` scheme.
 *
 * The renderer asks for `svwb-card://list/<hash>` and gets a picture. It never
 * learns the portal's URL, never makes an outbound request of its own, and
 * needs no loading state - "fetch it if we do not have it" happens down here,
 * behind what looks to the DOM like an ordinary image.
 *
 * Two kinds of picture come through it, told apart by the HOST: card art from
 * `/uploads/card_image/` and the class emblems from `/assets/`. They are
 * different caches with different rules (see `classIcons.ts`), deliberately
 * behind ONE scheme - one entry in the CSP, one kill switch, one clear button.
 * Cygames imagery is Cygames imagery, and it should not be possible to withdraw
 * half of it.
 *
 * That indirection is the point. Three things get to be main-process concerns
 * that would otherwise leak into components:
 *
 * - The kill switch. `settings.cardImages` off makes every request answer with
 *   a transparent pixel, so the feature can be withdrawn (see D-6) without a
 *   single component changing.
 * - The CSP. `img-src` lists `svwb-card:` instead of a remote origin, so the
 *   renderer stays unable to talk to the network directly.
 * - The language. Card art is per-language, and the setting lives in main.
 */
import { protocol } from 'electron'

import {
  parseCardImageUrl,
  resolveCardImage,
  DEFAULT_CACHE_LIMIT_BYTES
} from '../data/cardImages.js'
import { parseClassIconUrl, resolveClassIcon } from '../data/classIcons.js'
import { getCardImageCacheRoot, getClassIconCacheRoot } from '../paths.js'
import { store } from '../store.js'

export const CARD_IMAGE_SCHEME = 'svwb-card'

/**
 * A 1x1 fully transparent PNG.
 *
 * Served instead of an error whenever there is no picture to give - switched
 * off, unknown hash, portal unreachable. An <img> that 404s draws a broken-image
 * glyph and fires onerror; one that loads nothing visible just leaves the card's
 * text layout alone, which is the correct fallback for decoration.
 */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

const blank = (): Response =>
  new Response(TRANSPARENT_PNG, {
    status: 200,
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store' }
  })

/**
 * Must run BEFORE `app.whenReady()`.
 *
 * Registering the scheme as standard is what makes `svwb-card://list/<hash>`
 * parse with a host and a path; without it the URL is opaque and the handler
 * cannot tell the two image variants apart. `secure` keeps the images from
 * counting as mixed content in the renderer.
 */
export function registerCardImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CARD_IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
    }
  ])
}

/**
 * Read a cached file back, or a blank pixel if it went away under us.
 *
 * `immutable` is safe for card art because the filename IS the content hash, so
 * a changed image is a different URL. It is NOT safe for an emblem, whose URL
 * stays put across a redraw - that one gets a day, which is short next to the
 * 30-day revalidation window and long enough that a dropdown does not re-read
 * the disk on every mount.
 */
async function serve(file: string, contentType: string, cacheControl: string): Promise<Response> {
  try {
    const { readFile } = await import('node:fs/promises')
    const body = await readFile(file)
    return new Response(body, {
      status: 200,
      headers: { 'content-type': contentType, 'cache-control': cacheControl }
    })
  } catch {
    return blank()
  }
}

/** Must run AFTER `app.whenReady()`. */
export function registerCardImageProtocol(): void {
  protocol.handle(CARD_IMAGE_SCHEME, async (request) => {
    const settings = store.get('settings')
    if (!settings?.cardImages) return blank()

    // Emblems first: their host cannot collide with a card variant, so the
    // order is arbitrary, but it keeps the cheaper lookup in front.
    const iconName = parseClassIconUrl(request.url)
    if (iconName) {
      const file = await resolveClassIcon(iconName, { root: getClassIconCacheRoot() })
      if (!file) return blank()
      return serve(file, 'image/svg+xml', 'public, max-age=86400')
    }

    const req = parseCardImageUrl(request.url)
    if (!req) return blank()

    const file = await resolveCardImage(req, {
      root: getCardImageCacheRoot(),
      lang: settings.cardLang ?? 'cht',
      maxBytes: DEFAULT_CACHE_LIMIT_BYTES
    })
    if (!file) return blank()

    return serve(file, 'image/png', 'public, max-age=31536000, immutable')
  })
}
