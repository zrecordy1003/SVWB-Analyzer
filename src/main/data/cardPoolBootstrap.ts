/**
 * Filling the card pool on first launch, so nothing in the app is ever empty
 * waiting for the user to press a button they did not know about.
 *
 * Runs in the background after startup and only fetches slices we do not hold:
 * the second launch does nothing at all, and a launch after a language change
 * fetches only that language. It is never awaited by startup - a slow or absent
 * connection must not delay the window appearing.
 *
 * # The cost, stated plainly
 *
 * A slice is one class in one format, about 560KB. Seven classes across the two
 * playable formats is 14 requests, roughly 7-8MB, ONCE. Requests are serialised
 * with a gap rather than fired together: this is somebody else's server, and a
 * fan tool has no business opening fourteen parallel connections to it.
 *
 * Both formats are fetched even though their card sets are currently identical,
 * because they diverge as sets rotate out and `is_include_rotation` does not
 * reconstruct the rotation pool (see `cardPool.ts`).
 */
import type { Kysely } from 'kysely'

import type { Database } from './db/client.js'
import { missingCardPoolSlices, syncCardPoolSlice, type CardPoolSlice } from './cardPool.js'
import { SvwbApiError, type PortalLang } from './svwbApi.js'
import { broadcast } from '../utils/broadcast.js'

/** The classes the game has; 0 (neutral) comes back with every request. */
const CLASS_IDS = [1, 2, 3, 4, 5, 6, 7] as const
/** Only the two formats the builder offers. Infinity and Starter are not worth 7MB. */
const FORMATS = [2, 1] as const

/** Long enough not to look like a scraper, short enough to finish while the app warms up. */
const GAP_MS = 400

/** Two consecutive failures means the network is not there; stop and try next launch. */
const MAX_CONSECUTIVE_FAILURES = 2

export type CardPoolBootstrapProgress = {
  done: number
  total: number
  /** Set when the run stopped early; the UI can stay quiet about it. */
  stopped?: boolean
}

let running = false

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetch every slice we are missing, in the background.
 *
 * Failures are deliberately quiet. There is nothing the user can do about a
 * flaky connection at launch, the app works without the pool (imported decks
 * carry their own card details), and the next launch will simply try again.
 */
export async function bootstrapCardPool(
  db: Kysely<Database>,
  lang: PortalLang,
  // The gap is a courtesy to somebody else's server, not a correctness
  // requirement, so tests turn it off rather than waiting out fourteen of them.
  options: { gapMs?: number } = {}
): Promise<CardPoolBootstrapProgress> {
  const gapMs = options.gapMs ?? GAP_MS
  if (running) return { done: 0, total: 0, stopped: true }
  running = true

  try {
    const wanted: CardPoolSlice[] = FORMATS.flatMap((battleFormat) =>
      CLASS_IDS.map((classId) => ({ classId, battleFormat }))
    )
    const missing = await missingCardPoolSlices(db, wanted, lang)
    if (missing.length === 0) return { done: 0, total: 0 }

    broadcast('cards:poolBootstrap', { done: 0, total: missing.length })

    let done = 0
    let consecutiveFailures = 0

    for (const slice of missing) {
      try {
        await syncCardPoolSlice(db, slice, lang)
        consecutiveFailures = 0
      } catch (e) {
        consecutiveFailures++
        // A shape change is worth stopping for too: fourteen identical failures
        // help nobody.
        const fatal =
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ||
          (e instanceof SvwbApiError && e.code === 'UNEXPECTED_SHAPE')
        if (fatal) {
          broadcast('cards:poolBootstrap', { done, total: missing.length, stopped: true })
          return { done, total: missing.length, stopped: true }
        }
      }

      done++
      broadcast('cards:poolBootstrap', { done, total: missing.length })
      if (done < missing.length && gapMs > 0) await sleep(gapMs)
    }

    return { done, total: missing.length }
  } finally {
    running = false
  }
}
