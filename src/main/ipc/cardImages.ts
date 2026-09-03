/**
 * Card image cache management.
 *
 * Small on purpose: the cache needs no read API, because reads go through the
 * `svwb-card://` protocol rather than IPC. What the UI does need is to be able
 * to say how much disk this is costing, and to take it all back.
 */
import { cardImageCacheStats, clearCardImageCache } from '../data/cardImages.js'
import { classIconCacheStats, clearClassIconCache } from '../data/classIcons.js'
import { clearDeckCache } from '../data/svwbApi.js'
import { getCardImageCacheRoot, getClassIconCacheRoot } from '../paths.js'
import { handleIpc } from './typed.js'

export function registerCardImagesIpc(): void {
  handleIpc('cardImages:stats', async () => {
    try {
      // The emblems are counted in even though they are under 20KB against a
      // cache measured in hundreds of megabytes. Not for the number: this is
      // the one place the app reports what it has fetched from Cygames, and a
      // total that quietly omits part of it would be the wrong kind of tidy.
      const [cards, icons] = await Promise.all([
        cardImageCacheStats(getCardImageCacheRoot()),
        classIconCacheStats(getClassIconCacheRoot())
      ])
      return { files: cards.files + icons.files, bytes: cards.bytes + icons.bytes }
    } catch {
      return { files: 0, bytes: 0 }
    }
  })

  handleIpc('cardImages:clear', async () => {
    try {
      await clearCardImageCache(getCardImageCacheRoot())
      await clearClassIconCache(getClassIconCacheRoot())
      // The deck preview cache holds card NAMES for the same language, and the
      // user reaching for "clear" generally means "forget what you fetched".
      clearDeckCache()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })
}
