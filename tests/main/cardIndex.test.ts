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
async function seedDeck(opts: { isDefault: boolean; cards: number[] }): Promise<void> {
  const deck = await testDb()
    .insertInto('Deck')
    .values({
      name: `deck-${opts.cards[0]}`,
      class: 'witch',
      isDefault: opts.isDefault ? 1 : 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  for (const cardId of opts.cards) {
    await testDb().insertInto('DeckCard').values({ deckId: deck.id, cardId, count: 3 }).execute()
    await testDb()
      .insertInto('Card')
      .values({
        cardId,
        name: `card ${cardId}`,
        imageHash: hashOf(cardId),
        bannerHash: hashOf(cardId + 1),
        isToken: 0,
        lang: 'cht',
        updatedAt: Date.now()
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
}

describe('choosing which cards to fingerprint', () => {
  it('asks for the default decks and nothing else', async () => {
    await seedDeck({ isDefault: true, cards: [1001, 1002] })
    await seedDeck({ isDefault: false, cards: [2001] })

    const needed = await cardsNeedingFingerprints(1)
    expect(needed.map((c) => c.cardId).sort()).toEqual([1001, 1002])
  })

  /// A card already indexed at this version costs nothing to skip and a
  /// download to redo, so the query must exclude it - and must NOT exclude one
  /// indexed at another version, which is what an algorithm change looks like.
  it('skips what is already indexed, at this version only', async () => {
    await seedDeck({ isDefault: true, cards: [1001, 1002] })
    await sql`
      INSERT INTO CardArtSample (cardId, source, algoVersion, seenAt, vector)
      VALUES (1001, 'portal', 1, ${Date.now()}, ${Buffer.alloc(4)})
    `.execute(testDb())

    expect((await cardsNeedingFingerprints(1)).map((c) => c.cardId)).toEqual([1002])
    expect((await cardsNeedingFingerprints(2)).map((c) => c.cardId).sort()).toEqual([1001, 1002])
  })

  it('has nothing to say when no deck is the default', async () => {
    await seedDeck({ isDefault: false, cards: [2001] })
    expect(await cardsNeedingFingerprints(1)).toEqual([])
    expect(await buildIndexCardsCommand(1, 'cht', { root })).toBeNull()
  })
})

describe('fetching the pictures', () => {
  it('stops downloading at the cap, and resumes next time', async () => {
    const cards = [1, 2, 3, 4, 5].map((n) => ({ cardId: n, imageHash: hashOf(n) }))

    const first = await resolveCardsToIndex(cards, 'cht', { root, maxDownloads: 2 })
    expect(first).toHaveLength(2)
    expect(fetched).toHaveLength(2)

    // The two already on disk are free, so the cap buys two more.
    const second = await resolveCardsToIndex(cards, 'cht', { root, maxDownloads: 2 })
    expect(second).toHaveLength(4)
    expect(fetched).toHaveLength(4)
  })

  it('builds a command the engine can act on', async () => {
    await seedDeck({ isDefault: true, cards: [1001] })
    const command = await buildIndexCardsCommand(1, 'cht', { root })

    expect(command?.command).toBe('indexCards')
    expect(command?.cards).toHaveLength(1)
    expect(command?.cards[0].cardId).toBe(1001)
    // A real path on this machine, because the engine opens it by name.
    await expect(fs.access(command!.cards[0].path)).resolves.toBeUndefined()
  })
})
