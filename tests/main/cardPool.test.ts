/**
 * The card pool: reading the portal's pool response, and the sync/read IPC.
 *
 * The fixture is a real `/web/DeckBuilder/cards` response trimmed to 24 cards
 * (14 neutral, 10 witch), which is enough to exercise the thing that matters
 * most here: neutral cards and class cards come back together, and the reader
 * must keep each card's own class rather than the class that was queried.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerCardsIpc } from '../../src/main/ipc/cards'
import { registerDecksIpc } from '../../src/main/ipc/decks'
import { setPortalFetchForTests } from '../../src/main/data/svwbApi'
import { normalizeCardPoolResponse } from '../../src/shared/deckImport'
import { createMigratedTestDb, removeTestDb, testDb, type TestDb } from '../helpers/db'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    })
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

// electron-store resolves app.getPath at import time, which the electron mock
// above cannot provide. The pool code only reads the language out of it.
vi.mock('../../src/main/store', () => ({
  store: { get: vi.fn(() => ({ cardLang: 'cht' })) }
}))

const POOL = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/deck-import/witch-pool.json'), 'utf8')
)

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Res<T> = { ok: true; data: T } | { ok: false; error: string }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.handlers.get(channel)
  expect(handler, `Missing IPC handler: ${channel}`).toBeTypeOf('function')
  return (await handler!({}, ...args)) as T
}

const expectOk = <T>(res: Res<T>): T => {
  if (!res.ok) throw new Error(`expected ok, got error: ${res.error}`)
  return res.data
}

const WITCH = 3
const UNLIMITED = 2

let db: TestDb | undefined

beforeAll(async () => {
  db = await createMigratedTestDb()
})

afterAll(async () => {
  await removeTestDb(db)
  db = undefined
})

beforeEach(async () => {
  electronMock.handlers.clear()
  await testDb().deleteFrom('CardPool').execute()
  await testDb().deleteFrom('CardPoolSync').execute()
  await testDb().deleteFrom('DeckCard').execute()
  await testDb().deleteFrom('Card').execute()
  await testDb().deleteFrom('Deck').execute()
  registerCardsIpc()
  registerDecksIpc()
  setPortalFetchForTests(async () => jsonResponse(POOL))
})

afterEach(() => {
  setPortalFetchForTests(null)
})

describe('normalizeCardPoolResponse', () => {
  it('reads a real pool response', () => {
    const cards = normalizeCardPoolResponse(POOL.data)!
    expect(cards).not.toBeNull()
    expect(cards.length).toBe(POOL.data.sort_card_id_list.length)
  })

  it("keeps each card's own class, so neutrals stay neutral", () => {
    const cards = normalizeCardPoolResponse(POOL.data)!
    const classes = new Set(cards.map((c) => c.cardClass))
    // The request was for "neutral plus witch", and both must be identifiable.
    expect(classes.has(0)).toBe(true)
    expect(classes.has(WITCH)).toBe(true)
  })

  it("preserves the portal's display order as sortIndex", () => {
    const cards = normalizeCardPoolResponse(POOL.data)!
    expect(cards.map((c) => c.sortIndex)).toEqual(cards.map((_, i) => i))
    expect(cards[0].cardId).toBe(POOL.data.sort_card_id_list[0])
  })

  it('drops token cards, which cannot be put in a deck', () => {
    const data = JSON.parse(JSON.stringify(POOL.data))
    const victim = String(data.sort_card_id_list[0])
    data.card_details[victim].common.is_token = true

    const cards = normalizeCardPoolResponse(data)!
    expect(cards.some((c) => String(c.cardId) === victim)).toBe(false)
    expect(cards).toHaveLength(POOL.data.sort_card_id_list.length - 1)
  })

  it('falls back to card_details order when the sort list is missing', () => {
    const data = { ...POOL.data, sort_card_id_list: [] }
    const cards = normalizeCardPoolResponse(data)!
    expect(cards.length).toBe(Object.keys(POOL.data.card_details).length)
  })

  it('carries the copy limit through, so no rule table is needed', () => {
    const cards = normalizeCardPoolResponse(POOL.data)!
    expect(cards.every((c) => typeof c.deckEnabledNum === 'number')).toBe(true)
  })

  it('returns null when there is nothing readable', () => {
    expect(normalizeCardPoolResponse(null)).toBeNull()
    expect(normalizeCardPoolResponse({})).toBeNull()
    expect(normalizeCardPoolResponse({ card_details: {} })).toBeNull()
  })
})

describe('card pool IPC', () => {
  it('reads empty and unsynced before anything is fetched', async () => {
    const result = expectOk(
      await invoke<Res<{ cards: unknown[]; syncedAt: number | null }>>('cards:pool', {
        classId: WITCH,
        battleFormat: UNLIMITED
      })
    )
    // Null syncedAt is what lets the UI offer to fetch rather than claim the
    // pool is genuinely empty.
    expect(result.cards).toHaveLength(0)
    expect(result.syncedAt).toBeNull()
  })

  it('never goes to the network on a read', async () => {
    const calls = vi.fn()
    setPortalFetchForTests(async () => {
      calls()
      return jsonResponse(POOL)
    })
    await invoke('cards:pool', { classId: WITCH, battleFormat: UNLIMITED })
    expect(calls).not.toHaveBeenCalled()
  })

  it('syncs a class into Card, CardPool and CardPoolSync', async () => {
    const synced = expectOk(
      await invoke<Res<{ cardCount: number }>>('cards:syncPool', {
        classId: WITCH,
        battleFormat: UNLIMITED
      })
    )
    expect(synced.cardCount).toBe(POOL.data.sort_card_id_list.length)

    expect(await testDb().selectFrom('Card').selectAll().execute()).toHaveLength(synced.cardCount)
    expect(await testDb().selectFrom('CardPool').selectAll().execute()).toHaveLength(
      synced.cardCount
    )

    const sync = await testDb().selectFrom('CardPoolSync').selectAll().executeTakeFirstOrThrow()
    expect(sync).toMatchObject({
      classId: WITCH,
      battleFormat: UNLIMITED,
      lang: 'cht',
      cardCount: synced.cardCount
    })
  })

  it('reads back neutral plus the class, in portal order', async () => {
    await invoke('cards:syncPool', { classId: WITCH, battleFormat: UNLIMITED })

    const result = expectOk(
      await invoke<
        Res<{ cards: { cardId: number; cardClass: number | null; sortIndex: number }[] }>
      >('cards:pool', { classId: WITCH, battleFormat: UNLIMITED })
    )

    expect(result.cards.length).toBe(POOL.data.sort_card_id_list.length)
    expect(result.cards.every((c) => c.cardClass === 0 || c.cardClass === WITCH)).toBe(true)

    const indexes = result.cards.map((c) => c.sortIndex)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
  })

  it('does not leak one class pool into another', async () => {
    await invoke('cards:syncPool', { classId: WITCH, battleFormat: UNLIMITED })

    const elf = expectOk(
      await invoke<Res<{ cards: { cardClass: number | null }[]; syncedAt: number | null }>>(
        'cards:pool',
        { classId: 1, battleFormat: UNLIMITED }
      )
    )
    // Elf has never been synced, but the neutral cards fetched with witch are
    // legitimately hers too - what must NOT appear is a witch card.
    expect(elf.syncedAt).toBeNull()
    expect(elf.cards.every((c) => c.cardClass === 0)).toBe(true)
  })

  it('keeps formats apart', async () => {
    await invoke('cards:syncPool', { classId: WITCH, battleFormat: UNLIMITED })

    const rotation = expectOk(
      await invoke<Res<{ cards: unknown[] }>>('cards:pool', { classId: WITCH, battleFormat: 1 })
    )
    expect(rotation.cards).toHaveLength(0)
  })

  it('is idempotent - syncing twice does not duplicate rows', async () => {
    await invoke('cards:syncPool', { classId: WITCH, battleFormat: UNLIMITED })
    await invoke('cards:syncPool', { classId: WITCH, battleFormat: UNLIMITED })

    expect(await testDb().selectFrom('CardPool').selectAll().execute()).toHaveLength(
      POOL.data.sort_card_id_list.length
    )
    expect(await testDb().selectFrom('CardPoolSync').selectAll().execute()).toHaveLength(1)
  })

  it('rejects a class or format it does not know, without asking the portal', async () => {
    const calls = vi.fn()
    setPortalFetchForTests(async () => {
      calls()
      return jsonResponse(POOL)
    })

    for (const bad of [
      { classId: 99, battleFormat: UNLIMITED },
      { classId: 0, battleFormat: UNLIMITED },
      { classId: WITCH, battleFormat: 9 }
    ]) {
      const res = await invoke<Res<unknown>>('cards:syncPool', bad)
      expect(res.ok, JSON.stringify(bad)).toBe(false)
      if (!res.ok) expect(res.error).toContain('INVALID_INPUT')
    }
    expect(calls).not.toHaveBeenCalled()
  })

  it('reports a portal failure as a code the UI can word itself', async () => {
    setPortalFetchForTests(async () => {
      throw new Error('offline')
    })
    const res = await invoke<Res<unknown>>('cards:syncPool', {
      classId: WITCH,
      battleFormat: UNLIMITED
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('NETWORK')
  })

  it('lists what has been synced', async () => {
    await invoke('cards:syncPool', { classId: WITCH, battleFormat: UNLIMITED })
    const status = expectOk(await invoke<Res<{ classId: number }[]>>('cards:poolStatus'))
    expect(status).toHaveLength(1)
    expect(status[0].classId).toBe(WITCH)
  })
})

describe('decks:saveLocal', () => {
  async function poolCardIds(n: number): Promise<number[]> {
    await invoke('cards:syncPool', { classId: WITCH, battleFormat: UNLIMITED })
    const rows = await testDb()
      .selectFrom('Card')
      .select('cardId')
      .where('class', 'in', [0, WITCH])
      .orderBy('cardId', 'asc')
      .limit(n)
      .execute()
    return rows.map((r) => r.cardId)
  }

  it('saves an editor-built deck and marks it local', async () => {
    const ids = await poolCardIds(3)
    const deck = expectOk(
      await invoke<
        Res<{ id: number; class: string; sourceKind: string; sourceRef: string | null }>
      >('decks:saveLocal', {
        name: '巫師測試',
        classId: WITCH,
        battleFormat: UNLIMITED,
        cards: ids.map((cardId) => ({ cardId, count: 3 }))
      })
    )

    expect(deck.class).toBe('witch')
    // Built here, never round-tripped through the portal, so there is no hash.
    expect(deck.sourceKind).toBe('local')
    expect(deck.sourceRef).toBeNull()

    const cards = await testDb()
      .selectFrom('DeckCard')
      .selectAll()
      .where('deckId', '=', deck.id)
      .execute()
    expect(cards).toHaveLength(3)
    expect(cards.reduce((sum, c) => sum + c.count, 0)).toBe(9)
  })

  it('records a fingerprint so a later import can spot the same deck', async () => {
    const ids = await poolCardIds(2)
    const deck = expectOk(
      await invoke<Res<{ id: number; fingerprint: string | null }>>('decks:saveLocal', {
        name: 'fp',
        classId: WITCH,
        cards: ids.map((cardId) => ({ cardId, count: 1 }))
      })
    )
    expect(deck.fingerprint).toBe(ids.map((id) => `${id}:1`).join('|'))
  })

  it('replaces the card list when editing in place, rather than merging', async () => {
    const ids = await poolCardIds(4)
    const first = expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        name: 'edit me',
        classId: WITCH,
        cards: ids.slice(0, 3).map((cardId) => ({ cardId, count: 2 }))
      })
    )

    expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        deckId: first.id,
        name: 'edit me',
        classId: WITCH,
        cards: ids.slice(3).map((cardId) => ({ cardId, count: 1 }))
      })
    )

    const cards = await testDb().selectFrom('DeckCard').selectAll().execute()
    expect(cards).toHaveLength(1)
    expect(cards[0].cardId).toBe(ids[3])
    expect(await testDb().selectFrom('Deck').selectAll().execute()).toHaveLength(1)
  })

  it('reads a deck back whole, so the editor loads one query not two', async () => {
    const ids = await poolCardIds(3)
    const created = expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        name: '讀回',
        classId: WITCH,
        battleFormat: UNLIMITED,
        cards: ids.map((cardId) => ({ cardId, count: 2 }))
      })
    )

    const loaded = expectOk(
      await invoke<
        Res<{
          deck: { id: number; name: string; class: string; battleFormat: number | null }
          cards: { cardId: number; count: number; name: string }[]
        }>
      >('decks:get', { id: created.id })
    )

    expect(loaded.deck).toMatchObject({ id: created.id, name: '讀回', class: 'witch' })
    expect(loaded.deck.battleFormat).toBe(UNLIMITED)
    expect(loaded.cards).toHaveLength(3)
    expect(loaded.cards.every((c) => c.count === 2)).toBe(true)
    expect(loaded.cards.every((c) => !c.name.startsWith('#'))).toBe(true)
  })

  it('reports a deck that is not there', async () => {
    const res = await invoke<Res<unknown>>('decks:get', { id: 999999 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('NOT_FOUND')
  })

  it('refuses to change the class of a deck being edited', async () => {
    const ids = await poolCardIds(2)
    const created = expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        name: '不能換職業',
        classId: WITCH,
        cards: ids.map((cardId) => ({ cardId, count: 1 }))
      })
    )

    // A deck's class is what its recorded matches were played as. `class` is
    // only written on insert, so without this guard the save would keep the old
    // class and silently attach another class's cards to it.
    const res = await invoke<Res<unknown>>('decks:saveLocal', {
      deckId: created.id,
      name: '不能換職業',
      classId: 1,
      cards: ids.map((cardId) => ({ cardId, count: 1 }))
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('INVALID_INPUT')

    const row = await testDb()
      .selectFrom('Deck')
      .select('class')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()
    expect(row.class).toBe('witch')
  })

  it('still lists a card the pool no longer holds', async () => {
    const ids = await poolCardIds(2)
    const created = expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        name: '輪替出去',
        classId: WITCH,
        battleFormat: UNLIMITED,
        cards: ids.map((cardId) => ({ cardId, count: 3 }))
      })
    )

    // A card leaving the format: pool membership gone, deck untouched.
    await testDb().deleteFrom('CardPool').where('cardId', '=', ids[0]).execute()

    const loaded = expectOk(
      await invoke<Res<{ cards: { cardId: number }[] }>>('decks:get', { id: created.id })
    )
    // The editor loads from here, which is what stops a re-save from dropping it.
    expect(loaded.cards.map((c) => c.cardId)).toContain(ids[0])
  })

  it('refuses an empty deck and an unknown class', async () => {
    const empty = await invoke<Res<unknown>>('decks:saveLocal', {
      name: 'x',
      classId: WITCH,
      cards: []
    })
    expect(empty.ok).toBe(false)

    const badClass = await invoke<Res<unknown>>('decks:saveLocal', {
      name: 'x',
      classId: 99,
      cards: [{ cardId: 1, count: 1 }]
    })
    expect(badClass.ok).toBe(false)
    if (!badClass.ok) expect(badClass.error).toContain('INVALID_INPUT')
  })

  it('still enforces the name uniqueness rule decks:create uses', async () => {
    const ids = await poolCardIds(1)
    const cards = ids.map((cardId) => ({ cardId, count: 1 }))
    expectOk(await invoke<Res<unknown>>('decks:saveLocal', { name: '同名', classId: WITCH, cards }))
    const again = await invoke<Res<unknown>>('decks:saveLocal', {
      name: '同名',
      classId: WITCH,
      cards
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toBe('DUPLICATE_NAME')
  })
})
