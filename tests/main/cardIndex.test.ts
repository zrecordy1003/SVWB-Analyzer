/**
 * Which cards the engine is told about, and how many pictures that costs.
 *
 * The engine cannot recognise a card it has no fingerprint for, and it cannot
 * make one without a picture. This is the half of that which decides what to
 * fetch - so the two things worth pinning are that it asks for the right cards
 * and that a cold cache cannot turn a launch into hundreds of downloads.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'

import { setCardImageFetchForTests } from '../../src/main/data/cardImages'
import {
  buildIndexCardsCommand,
  cardsNeedingFingerprints,
  resolveCardsToIndex
} from '../../src/main/recognition/cardIndex'
import { createMigratedTestDb, removeTestDb, testDb, type TestDb } from '../helpers/db'

let db: TestDb | undefined
let root: string
let fetched: string[]

const hashOf = (n: number): string => n.toString(16).padStart(32, '0')

beforeEach(async () => {
  db = await createMigratedTestDb()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-cardindex-'))
  fetched = []
  setCardImageFetchForTests(async (url: string) => {
    fetched.push(url)
    return new Response(Buffer.alloc(64, 7), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })
  })
})

afterEach(async () => {
  setCardImageFetchForTests(null)
  await removeTestDb(db)
  db = undefined
  await fs.rm(root, { recursive: true, force: true })
})

/** A deck of `count` cards, default or not, with card rows to match. */
async function seedCard(cardId: number, classId: number): Promise<void> {
  await testDb()
    .insertInto('Card')
    .values({
      cardId,
      name: `card ${cardId}`,
      class: classId,
      imageHash: hashOf(cardId),
      bannerHash: hashOf(cardId + 1),
      isToken: 0,
      lang: 'cht',
      updatedAt: Date.now()
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

async function seedDeck(opts: {
  isDefault: boolean
  cards: number[]
  klass?: string
  cardClass?: number
}): Promise<void> {
  const deck = await testDb()
    .insertInto('Deck')
    .values({
      name: `deck-${opts.klass ?? 'witch'}-${opts.cards[0] ?? 'empty'}`,
      class: opts.klass ?? 'witch',
      isDefault: opts.isDefault ? 1 : 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  for (const cardId of opts.cards) {
    await testDb().insertInto('DeckCard').values({ deckId: deck.id, cardId, count: 3 }).execute()
    await seedCard(cardId, opts.cardClass ?? 3)
  }
}

describe('choosing which cards to fingerprint', () => {
  /// The pool of a class the user plays, not that class's decks. A player who
  /// forgot to switch the default - or never imported anything - is the case
  /// this exists for, and deck-shaped candidate sets leave them with nothing.
  it('asks for the whole pool of a class the user plays', async () => {
    await seedDeck({ isDefault: true, cards: [1001], klass: 'witch', cardClass: 3 })
    // In the pool, of the same class, in no deck at all.
    await seedCard(1500, 3)
    // Neutral: playable by every class, so always a candidate.
    await seedCard(1600, 0)
    // Another class the user has never touched.
    await seedCard(1700, 4)

    const needed = await cardsNeedingFingerprints(1)
    expect(needed.map((c) => c.cardId).sort()).toEqual([1001, 1500, 1600])
    expect(needed.find((c) => c.cardId === 1600)?.className).toBe('neutral')
    expect(needed.find((c) => c.cardId === 1500)?.className).toBe('witch')
  })

  /// Deck cards first: within a class they are the cards most likely to be in
  /// the next hand, and the download budget runs out before the pool does.
  it('offers deck cards before the rest of the pool', async () => {
    await seedDeck({ isDefault: true, cards: [9001], klass: 'witch', cardClass: 3 })
    await seedCard(1, 3)

    const needed = await cardsNeedingFingerprints(1)
    expect(needed[0].cardId).toBe(9001)
  })

  /// A class the user has a deck for but has never played still counts: they
  /// built it to play it.
  it('counts a class the user has only built a deck for', async () => {
    await seedDeck({ isDefault: false, cards: [], klass: 'dragon', cardClass: 4 })
    await seedCard(2500, 4)

    expect((await cardsNeedingFingerprints(1)).map((c) => c.cardId)).toEqual([2500])
  })

  /// A card already indexed at this version costs nothing to skip and a
  /// download to redo, so the query must exclude it - and must NOT exclude one
  /// indexed at another version, which is what an algorithm change looks like.
  it('skips what is already indexed, at this version only', async () => {
    await seedDeck({ isDefault: true, cards: [1001, 1002], klass: 'witch', cardClass: 3 })
    await sql`
      INSERT INTO CardArtSample (cardId, source, algoVersion, seenAt, vector)
      VALUES (1001, 'portal', 1, ${Date.now()}, ${Buffer.alloc(4)})
    `.execute(testDb())

    expect((await cardsNeedingFingerprints(1)).map((c) => c.cardId)).toEqual([1002])
    expect((await cardsNeedingFingerprints(2)).map((c) => c.cardId).sort()).toEqual([1001, 1002])
  })

  /// A deck with no card list - the "just a label" decks that predate deck
  /// import - contributes nothing, because there is nothing to contribute.
  it('has nothing to say when the user plays nothing', async () => {
    // A pool card of a class with no deck and no match.
    await seedCard(3001, 7)
    expect(await cardsNeedingFingerprints(1)).toEqual([])
    expect(await buildIndexCardsCommand(1, 'cht', { root })).toBeNull()
  })
})

describe('fetching the pictures', () => {
  it('stops downloading at the cap, and resumes next time', async () => {
    const cards = [1, 2, 3, 4, 5].map((n) => ({
      cardId: n,
      imageHash: hashOf(n),
      className: 'witch'
    }))

    const first = await resolveCardsToIndex(cards, 'cht', { root, maxDownloads: 2 })
    expect(first).toHaveLength(2)
    expect(fetched).toHaveLength(2)

    // The two already on disk are free, so the cap buys two more.
    const second = await resolveCardsToIndex(cards, 'cht', { root, maxDownloads: 2 })
    expect(second).toHaveLength(4)
    expect(fetched).toHaveLength(4)
  })

  it('builds a command the engine can act on', async () => {
    await seedDeck({ isDefault: true, cards: [1001], klass: 'witch', cardClass: 3 })
    const command = await buildIndexCardsCommand(1, 'cht', { root })

    expect(command?.command).toBe('indexCards')
    expect(command?.cards).toHaveLength(1)
    expect(command?.cards[0].cardId).toBe(1001)
    expect(command?.cards[0].class).toBe('witch')
    // A real path on this machine, because the engine opens it by name.
    await expect(fs.access(command!.cards[0].path)).resolves.toBeUndefined()
  })
})
