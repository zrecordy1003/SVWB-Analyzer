/**
 * Tell the engine which cards it might see, and where their pictures are.
 *
 * The engine matches the mulligan panel against fingerprints of the official
 * card art (`tools/engine/src/fingerprint.rs`). It cannot fetch those images
 * itself and should not: the hashes live in the `Card` table, the cache layout
 * and its eviction policy live in `cardImages.ts`, and the download is a network
 * call this app makes on the user's behalf. So the split is
 *
 *   host    which cards, and a path to each one's picture
 *   engine  the reduction, because a fingerprint computed by any other pipeline
 *           cannot be compared with one taken off a frame
 *
 * # Which cards
 *
 * The cards of the DEFAULT decks, because that is the same guess the engine
 * makes when it opens a match row: `insert_match` pre-fills `my_deckId` from the
 * default deck of the class being played. Indexing anything else would be
 * fetching pictures for cards no match will be matched against.
 *
 * # Why it is capped
 *
 * Every card not already cached is a download from Cygames' servers, and a first
 * run with seven default decks would be a couple of hundred of them at once.
 * [`MAX_DOWNLOADS_PER_RUN`] bounds that; whatever is left is picked up the next
 * time the app starts, and a card that is already cached never counts against it.
 */
import fs from 'node:fs/promises'

import { sql } from 'kysely'

import { getDb } from '../data/db/client.js'
import { DEFAULT_CACHE_LIMIT_BYTES, cacheFilePath, resolveCardImage } from '../data/cardImages.js'
import type { PortalLang } from '../data/svwbApi.js'
import { getCardImageCacheRoot } from '../paths.js'

/**
 * How many pictures one run may fetch that are not already on disk.
 *
 * A deck is ~30 unique cards, so this is roughly two decks' worth of cold cache
 * per launch. Deliberately not "all of them": the point is that a new install
 * warms up over a few sessions instead of pulling 100MB while the user is
 * trying to play.
 */
export const MAX_DOWNLOADS_PER_RUN = 60

export type CardToIndex = { cardId: number; path: string }

/**
 * Every default-deck card that has no fingerprint at `algoVersion` yet.
 *
 * `imageHash` is required rather than optional: a `Card` row without one has
 * never been fetched from the portal and there is no picture to point at. That
 * is a gap in the card cache, not something this can fix.
 */
export async function cardsNeedingFingerprints(
  algoVersion: number
): Promise<{ cardId: number; imageHash: string }[]> {
  const rows = await sql<{ cardId: number; imageHash: string }>`
    SELECT DISTINCT c.cardId AS cardId, c.imageHash AS imageHash
      FROM DeckCard dc
      JOIN Deck d ON d.id = dc.deckId
      JOIN Card c ON c.cardId = dc.cardId
     WHERE d.isDefault = 1
       AND c.imageHash IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM CardArtSample s
              WHERE s.cardId = c.cardId
                AND s.source = 'portal'
                AND s.algoVersion = ${algoVersion}
           )
  `.execute(getDb())
  return rows.rows
}

/**
 * Resolve pictures for the cards that still need one, newest cache first.
 *
 * A card whose picture cannot be had is skipped rather than reported: it will be
 * tried again next run, and one missing illustration costs one unrecognised card
 * rather than an unrecognised hand.
 */
export async function resolveCardsToIndex(
  cards: { cardId: number; imageHash: string }[],
  lang: PortalLang,
  options: { root?: string; maxDownloads?: number } = {}
): Promise<CardToIndex[]> {
  const root = options.root ?? getCardImageCacheRoot()
  const maxDownloads = options.maxDownloads ?? MAX_DOWNLOADS_PER_RUN
  const out: CardToIndex[] = []
  let downloads = 0

  for (const card of cards) {
    const req = { variant: 'card', hash: card.imageHash } as const
    // Looking first is the only way to tell a cache hit from a download, and the
    // cap is about downloads: a card already on disk costs nothing and must not
    // use up the budget.
    const cached = await fileExists(cacheFilePath(root, req, lang))
    if (!cached && downloads >= maxDownloads) continue

    const file = await resolveCardImage(req, {
      root,
      lang,
      maxBytes: DEFAULT_CACHE_LIMIT_BYTES
    })
    if (!file) continue
    if (!cached) downloads++
    out.push({ cardId: card.cardId, path: file })
  }
  return out
}

/**
 * Work out what needs indexing and hand it to the engine.
 *
 * Returns the command to send, or `null` when there is nothing to do - which is
 * the normal case on every run after the first.
 */
export async function buildIndexCardsCommand(
  algoVersion: number,
  lang: PortalLang,
  options: { root?: string; maxDownloads?: number } = {}
): Promise<{ command: 'indexCards'; cards: CardToIndex[] } | null> {
  const needed = await cardsNeedingFingerprints(algoVersion)
  if (needed.length === 0) return null

  const cards = await resolveCardsToIndex(needed, lang, options)
  if (cards.length === 0) return null

  return { command: 'indexCards', cards }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
