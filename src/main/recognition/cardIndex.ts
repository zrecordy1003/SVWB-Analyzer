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
 * for classes they have never touched - and a class nobody plays can never be in
 * a hand. The class played most recently comes first, then deck cards within
 * each class, because those are the cards most likely to be in the next hand.
 *
 * # It finishes
 *
 * An earlier version stopped after 60 pictures per launch, which meant a pool
 * took three launches to become usable and the feature silently did nothing in
 * between. That is a worse failure than a long download: the user cannot tell it
 * from being broken. This now indexes everything that is missing, in batches, so
 * recognition improves as it goes rather than only at the end.
 *
 * # Why it is capped
 *
 * Every card not already cached is a download from Cygames' servers, and a first
 * run with seven default decks would be a couple of hundred of them at once.
 * [`MAX_DOWNLOADS_PER_RUN`] bounds that; whatever is left is picked up the next
 * time the app starts, and a card that is already cached never counts against it.
 */
import { sql } from 'kysely'

import { CLASS_NAME_TO_ID } from '../../shared/deckImport.js'
import type { ClassName } from '../../shared/domain.js'
import { getDb } from '../data/db/client.js'
import { DEFAULT_CACHE_LIMIT_BYTES, resolveCardImage } from '../data/cardImages.js'
import type { PortalLang } from '../data/svwbApi.js'
import { getCardImageCacheRoot } from '../paths.js'

/**
 * How many pictures are fetched at once.
 *
 * The portal is somebody else's server and this is a background chore, so the
 * requests are spread rather than fired all at once - but one at a time turns a
 * 175-card pool into minutes of waiting. Five is enough to make the wait a
 * minute or so without looking like a flood.
 */
export const FETCH_CONCURRENCY = 5

/**
 * How many cards are handed to the engine at a time.
 *
 * Batching rather than one big command at the end is what makes a long index
 * useful while it runs: each batch that lands is a set of cards the next match
 * can be matched against, and an app closed half way keeps what it already did.
 */
export const INDEX_BATCH = 25

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
  `.execute(getDb())

  // Order here rather than in SQL: the ranking is "which class did you play most
  // recently", which is a fact this side already has and SQL would need a CASE
  // ladder to express. Neutral cards rank with whichever class is first, since
  // they can turn up in any hand.
  const rank = new Map(classes.map((name, i) => [name, i]))
  return rows.rows
    .map((r) => ({
      cardId: Number(r.cardId),
      imageHash: r.imageHash,
      className: wanted.get(Number(r.classId)) ?? 'neutral',
      inDeck: Number(r.inDeck) === 1
    }))
    .sort(
      (a, b) =>
        (rank.get(a.className) ?? 0) - (rank.get(b.className) ?? 0) ||
        Number(b.inDeck) - Number(a.inDeck) ||
        a.cardId - b.cardId
    )
    .map(({ cardId, imageHash, className }) => ({ cardId, imageHash, className }))
}

/**
 * The classes worth spending downloads on, most recently played first.
 *
 * Both halves of the union matter. A class only ever played is one the user
 * plays without importing anything - the case this whole widening exists for -
 * and a class with only a deck is one they have prepared but not yet taken to a
 * match.
 *
 * The order is what makes a long index useful early: whatever was played last is
 * what is most likely to be played next, so its pool is the one worth having
 * first.
 */
async function playedClasses(): Promise<string[]> {
  const recent = await sql<{ name: string; lastPlayed: number }>`
    SELECT my_class AS name, max(playedAt) AS lastPlayed
      FROM Match
     WHERE my_class IS NOT NULL
     GROUP BY my_class
     ORDER BY lastPlayed DESC
  `.execute(getDb())

  const decks = await sql<{ name: string }>`
    SELECT DISTINCT class AS name FROM Deck WHERE class IS NOT NULL
  `.execute(getDb())

  const ordered: string[] = []
  for (const name of [...recent.rows.map((r) => r.name), ...decks.rows.map((r) => r.name)]) {
    if (name && !ordered.includes(name)) ordered.push(name)
  }
  return ordered
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
  options: { root?: string; concurrency?: number } = {}
): Promise<CardToIndex[]> {
  const root = options.root ?? getCardImageCacheRoot()
  const concurrency = Math.max(1, options.concurrency ?? FETCH_CONCURRENCY)
  const out: CardToIndex[] = []

  // A fixed pool of workers pulling from one cursor, rather than chunking: the
  // pictures differ in size and a slow one must not hold up the four beside it.
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= cards.length) return
      const card = cards[i]
      const file = await resolveCardImage(
        { variant: 'card', hash: card.imageHash },
        { root, lang, maxBytes: DEFAULT_CACHE_LIMIT_BYTES }
      )
      // A picture that cannot be had is skipped, not reported: it will be tried
      // again next run, and one missing illustration costs one unrecognised card
      // rather than an unrecognised hand.
      if (file) out.push({ cardId: card.cardId, path: file, class: card.className })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cards.length) }, worker))
  return out
}

/**
 * Fingerprint everything that is missing, in batches, and report the total.
 *
 * `send` is called once per batch with a command the engine acts on. It is not
 * awaited and cannot fail here - the engine answers with its own `cardsIndexed`
 * event - so what comes back is what this side managed to resolve, not what the
 * engine managed to store.
 */
export async function indexMissingCards(
  algoVersion: number,
  lang: PortalLang,
  send: (command: { command: 'indexCards'; cards: CardToIndex[] }) => void,
  options: { root?: string; concurrency?: number; batch?: number } = {}
): Promise<{ needed: number; sent: number }> {
  const needed = await cardsNeedingFingerprints(algoVersion)
  if (needed.length === 0) return { needed: 0, sent: 0 }

  const batchSize = Math.max(1, options.batch ?? INDEX_BATCH)
  let sent = 0
  for (let i = 0; i < needed.length; i += batchSize) {
    const cards = await resolveCardsToIndex(needed.slice(i, i + batchSize), lang, options)
    if (cards.length === 0) continue
    send({ command: 'indexCards', cards })
    sent += cards.length
  }
  return { needed: needed.length, sent }
}
