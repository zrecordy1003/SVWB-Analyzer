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
 * **The pool of every class the user actually plays**, not the cards of their
 * decks. Two earlier versions of this picked the default deck's cards, then
 * every deck's cards, and both failed the same way: recognition only worked if
 * the player had imported the exact deck they were playing. Forgetting to switch
 * the default, or never importing at all, produced an opening hand of four nulls
 * that looks identical to recognition being broken.
 *
 * Widening to the pool does not cost accuracy - measured, a 63-card set and a
 * 175-card class pool give identical scores for the right card and at most 0.05
 * less margin - and it turns the common case from "nothing named" into
 * "everything named". See `docs/opening-hand-plan.md`.
 *
 * Which classes: the ones the user has actually played or built a deck for. A
 * pool is ~92MB of pictures, so indexing all seven would be most of a gigabyte
 * for classes they have never touched. Deck cards are fetched first within each
 * class, because those are the cards most likely to be in the next hand.
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

import { CLASS_NAME_TO_ID } from '../../shared/deckImport.js'
import type { ClassName } from '../../shared/domain.js'
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

export type CardToIndex = { cardId: number; path: string; class: string }

/** A card whose picture is known but whose fingerprint is not. */
export type CardNeedingFingerprint = {
  cardId: number
  imageHash: string
  /** The engine's class vocabulary, or `'neutral'`. */
  className: string
}

/** The portal's id for cards every class can play. */
const NEUTRAL_CLASS_ID = 0

/**
 * Every card of every deck that has no fingerprint at `algoVersion` yet.
 *
 * `imageHash` is required rather than optional: a `Card` row without one has
 * never been fetched from the portal and there is no picture to point at. That
 * is a gap in the card cache, not something this can fix.
 */
export async function cardsNeedingFingerprints(
  algoVersion: number
): Promise<CardNeedingFingerprint[]> {
  const classes = await playedClasses()
  if (classes.length === 0) return []

  // `Card.class` is the PORTAL's numeric id, whose order differs from this app's
  // class names - `CLASS_ID_TO_NAME` is the one place that knows the difference.
  // Translating here rather than in SQL keeps it that way.
  const wanted = new Map<number, string>([[NEUTRAL_CLASS_ID, 'neutral']])
  for (const name of classes) {
    const id = CLASS_NAME_TO_ID[name as ClassName]
    if (id != null) wanted.set(id, name)
  }

  const rows = await sql<{
    cardId: number
    imageHash: string
    classId: number
    inDeck: number
  }>`
    SELECT c.cardId AS cardId,
           c.imageHash AS imageHash,
           c.class AS classId,
           EXISTS (SELECT 1 FROM DeckCard dc WHERE dc.cardId = c.cardId) AS inDeck
      FROM Card c
     WHERE c.imageHash IS NOT NULL
       AND c.class IN (${sql.join([...wanted.keys()])})
       AND NOT EXISTS (
             SELECT 1 FROM CardArtSample s
              WHERE s.cardId = c.cardId
                AND s.source = 'portal'
                AND s.algoVersion = ${algoVersion}
           )
     ORDER BY inDeck DESC, c.cardId
  `.execute(getDb())

  return rows.rows.map((r) => ({
    cardId: Number(r.cardId),
    imageHash: r.imageHash,
    className: wanted.get(Number(r.classId)) ?? 'neutral'
  }))
}

/**
 * The classes worth spending downloads on: played, or built a deck for.
 *
 * Both halves matter. A class only ever played is one the user plays without
 * importing anything - the case this whole widening exists for - and a class
 * with only a deck is one they have prepared but not yet taken to a match.
 */
async function playedClasses(): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT DISTINCT my_class AS name FROM Match WHERE my_class IS NOT NULL
    UNION
    SELECT DISTINCT class AS name FROM Deck WHERE class IS NOT NULL
  `.execute(getDb())
  return rows.rows.map((r) => r.name).filter(Boolean)
}

/**
 * Resolve pictures for the cards that still need one, newest cache first.
 *
 * A card whose picture cannot be had is skipped rather than reported: it will be
 * tried again next run, and one missing illustration costs one unrecognised card
 * rather than an unrecognised hand.
 */
export async function resolveCardsToIndex(
  cards: CardNeedingFingerprint[],
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
    out.push({ cardId: card.cardId, path: file, class: card.className })
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
