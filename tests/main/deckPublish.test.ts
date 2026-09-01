/**
 * Writing a deck back out: card list to hash to 4-character deck code.
 *
 * The payload shape and the credential handshake are both undocumented and both
 * fail quietly, so this file leans on the two traps rather than the happy path:
 *
 * - A wrong payload returns `result_code: 1` with an EMPTY hash. Anything that
 *   only checks the result code reports success and hands the user a dead link.
 * - A CSRF token without its matching `sid` cookie is rejected with `1021` -
 *   the same code a malformed payload gets.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDecksIpc } from '../../src/main/ipc/decks'
import {
  clearPortalSession,
  publishDeckCode,
  requestDeckHash,
  setPortalFetchForTests
} from '../../src/main/data/svwbApi'
import { buildDeckHashPayload, DECK_CODE_TTL_MS } from '../../src/shared/deckImport'
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

const FIXTURE = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/deck-import/nemesis-hash.json'), 'utf8')
)

const HASH =
  '1.7.cQnG.cQnG.cR2I.cR2I.di4E.dzA8.dzA8.eKrc.eKrc.eLN-.eLN-.eLN-.eLae.eLae.eLae.ejG6.ejG6.ejlM.ejlM.ejlM.ej--.ej--.ej--.ej_8.ej_8.ej_8.f5jk.f5jk.f5jk.f69s.f69s.f69s.fUq8.fUq8.fUq8.fslO.fslO.fslO.ftEe.ftEe'

const SID = 'sid=TESTSESSION'

type Res<T> = { ok: true; data: T } | { ok: false; error: string }

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  })

/**
 * A portal that behaves the way the real one does.
 *
 * Reads are open; writes need both halves of the credential; a bad payload
 * answers "success" with nothing in it; and - the one that actually bit -
 * **CSRF tokens are single-use and rotate on every response**. A fake that
 * accepted a fixed token passed happily while the real portal rejected the
 * second write of every sequence.
 */
function fakePortal(
  options: {
    onWrite?: (path: string, body: any, headers: Record<string, string>) => Response | null
  } = {}
) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  let issued = 0
  let liveToken: string | null = null

  const nextToken = (): string => {
    liveToken = `csrf-${++issued}`
    return liveToken
  }

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, headers, body })

    if (url.includes('/web/Login/status')) {
      return json(
        { data_headers: { result_code: 1, csrf_token: nextToken() } },
        { 'set-cookie': `${SID}; path=/; HttpOnly` }
      )
    }

    const hasCookie = (headers.Cookie ?? '').includes('sid=')
    const hasCsrf = liveToken !== null && headers['X-Csrf-Token'] === liveToken
    if (!hasCookie || !hasCsrf) {
      // Exactly what the portal does: 1021 for "bad request OR bad credentials
      // OR a token that was already spent".
      return json({ data_headers: { result_code: 1021, csrf_token: '' } })
    }

    const override = options.onWrite?.(url, body, headers)
    if (override) return override

    if (url.includes('/web/DeckBuilder/getDeckHash')) {
      return json({
        data_headers: { result_code: 1, csrf_token: nextToken() },
        data: { hash: HASH }
      })
    }
    if (url.includes('/web/DeckCode/publish')) {
      return json({
        data_headers: { result_code: 1, csrf_token: nextToken() },
        data: { deck_code: 'uj9k' }
      })
    }
    return json({ data_headers: { result_code: 1, csrf_token: nextToken() }, data: {} })
  }

  return { fetchImpl, calls }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.handlers.get(channel)
  expect(handler, `Missing IPC handler: ${channel}`).toBeTypeOf('function')
  return (await handler!({}, ...args)) as T
}

const expectOk = <T>(res: Res<T>): T => {
  if (!res.ok) throw new Error(`expected ok, got error: ${res.error}`)
  return res.data
}

const DECK = {
  classId: 7,
  battleFormat: 1,
  keyCardId: 10573310,
  cards: [
    { cardId: 10573310, count: 3 },
    { cardId: 10071120, count: 2 }
  ]
}

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
  clearPortalSession()
  await testDb().deleteFrom('DeckCard').execute()
  await testDb().deleteFrom('Deck').execute()
  registerDecksIpc()
})

afterEach(() => {
  setPortalFetchForTests(null)
  clearPortalSession()
})

describe('buildDeckHashPayload', () => {
  it('emits flat numbered pairs, not an array', () => {
    const payload = buildDeckHashPayload(DECK)
    // Arrays, CSV and form encoding were all rejected by the portal; this shape
    // is the only one it accepts and it is documented nowhere.
    expect(payload.card_id1).toBe(10071120)
    expect(payload.card_num1).toBe(2)
    expect(payload.card_id2).toBe(10573310)
    expect(payload.card_num2).toBe(3)
    expect(payload.card_id3).toBeUndefined()
  })

  it('carries the fields the portal requires alongside the cards', () => {
    expect(buildDeckHashPayload(DECK)).toMatchObject({
      name: '',
      is_published: 1,
      status: 1,
      deck_id: null,
      class_id: 7,
      battle_format: 1,
      key_card_id: 10573310
    })
  })

  it('is stable regardless of card order, so the round trip is testable', () => {
    const reversed = { ...DECK, cards: [...DECK.cards].reverse() }
    expect(buildDeckHashPayload(reversed)).toEqual(buildDeckHashPayload(DECK))
  })

  it('rebuilds the real deck as one pair per distinct card', () => {
    const d = FIXTURE.data
    const cards = d.sort_card_id_list.map((id: number) => ({
      cardId: id,
      count: d.deck_card_num[String(id)]
    }))
    const payload = buildDeckHashPayload({
      classId: d.class_id,
      battleFormat: d.battle_format,
      keyCardId: d.sort_card_id_list[0],
      cards
    })

    const pairs = Object.keys(payload).filter((k) => k.startsWith('card_id')).length
    expect(pairs).toBe(cards.length)
    const total = cards.reduce((sum: number, c: { count: number }) => sum + c.count, 0)
    expect(total).toBe(40)
  })

  it('drops cards with no copies rather than sending a zero', () => {
    const payload = buildDeckHashPayload({
      ...DECK,
      cards: [...DECK.cards, { cardId: 999, count: 0 }]
    })
    expect(Object.keys(payload).filter((k) => k.startsWith('card_id'))).toHaveLength(2)
  })
})

describe('the write handshake', () => {
  it('seeds a session from Login/status and sends both halves', async () => {
    const portal = fakePortal()
    setPortalFetchForTests(portal.fetchImpl)

    expect(await requestDeckHash(DECK)).toBe(HASH)

    const seed = portal.calls[0]
    expect(seed.url).toContain('/web/Login/status')

    const write = portal.calls[1]
    expect(write.headers['X-Csrf-Token']).toBe('csrf-1')
    expect(write.headers.Cookie).toContain('sid=')
    expect(write.headers['X-Requested-With']).toBe('XMLHttpRequest')
  })

  it('reuses the session across calls instead of re-seeding every time', async () => {
    const portal = fakePortal()
    setPortalFetchForTests(portal.fetchImpl)

    await requestDeckHash(DECK)
    await publishDeckCode(HASH)

    const seeds = portal.calls.filter((c) => c.url.includes('/web/Login/status'))
    expect(seeds).toHaveLength(1)
  })

  it('uses the rotated token for the second write, without re-seeding', async () => {
    const portal = fakePortal()
    setPortalFetchForTests(portal.fetchImpl)

    // The real flow: encode, then publish. Tokens are single-use, so the second
    // write must send the one the first response returned. Reusing the seed
    // token gets 1021 and the whole thing limps along on retries - which is
    // what happened before `rememberToken`.
    await requestDeckHash(DECK)
    await publishDeckCode(HASH)

    const writes = portal.calls.filter((c) => !c.url.includes('/web/Login/status'))
    expect(writes).toHaveLength(2)
    expect(writes[0].headers['X-Csrf-Token']).toBe('csrf-1')
    expect(writes[1].headers['X-Csrf-Token']).toBe('csrf-2')
    expect(portal.calls.filter((c) => c.url.includes('/web/Login/status'))).toHaveLength(1)
  })

  it('re-seeds once and succeeds when the token is stale', async () => {
    let rejectedOnce = false
    const portal = fakePortal({
      onWrite: (url) => {
        if (url.includes('getDeckHash') && !rejectedOnce) {
          rejectedOnce = true
          return json({ data_headers: { result_code: 1021, csrf_token: '' } })
        }
        return null
      }
    })
    setPortalFetchForTests(portal.fetchImpl)

    expect(await requestDeckHash(DECK)).toBe(HASH)
    expect(portal.calls.filter((c) => c.url.includes('/web/Login/status'))).toHaveLength(2)
  })

  it('gives up after the retry rather than looping', async () => {
    const portal = fakePortal({
      onWrite: () => json({ data_headers: { result_code: 1021, csrf_token: '' } })
    })
    setPortalFetchForTests(portal.fetchImpl)

    await expect(requestDeckHash(DECK)).rejects.toMatchObject({ code: 'UNEXPECTED_SHAPE' })
    expect(portal.calls.filter((c) => c.url.includes('getDeckHash'))).toHaveLength(2)
  })
})

describe('the empty-hash trap', () => {
  it('treats result_code 1 with an empty hash as a failure', async () => {
    const portal = fakePortal({
      onWrite: (url) =>
        url.includes('getDeckHash')
          ? // This is precisely what a wrong payload shape returns. Checking the
            // result code alone would call this a success.
            json({ data_headers: { result_code: 1 }, data: { hash: '' } })
          : null
    })
    setPortalFetchForTests(portal.fetchImpl)

    await expect(requestDeckHash(DECK)).rejects.toMatchObject({ code: 'UNEXPECTED_SHAPE' })
  })

  it('treats an empty deck code the same way', async () => {
    const portal = fakePortal({
      onWrite: (url) =>
        url.includes('DeckCode/publish')
          ? json({ data_headers: { result_code: 1 }, data: { deck_code: '' } })
          : null
    })
    setPortalFetchForTests(portal.fetchImpl)

    await expect(publishDeckCode(HASH)).rejects.toMatchObject({ code: 'UNEXPECTED_SHAPE' })
  })
})

describe('decks:publishCode', () => {
  async function seedDeck(overrides: Record<string, unknown> = {}): Promise<number> {
    const now = Date.now()
    const deck = await testDb()
      .insertInto('Deck')
      .values({
        name: '測試',
        class: 'nemesis',
        isDefault: 0,
        categoryId: null,
        battleFormat: 1,
        keyCardId: 10573310,
        createdAt: now,
        updatedAt: now,
        ...overrides
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await testDb()
      .insertInto('DeckCard')
      .values(DECK.cards.map((c) => ({ deckId: deck.id, cardId: c.cardId, count: c.count })))
      .execute()

    return deck.id
  }

  it('publishes a code and a share link', async () => {
    setPortalFetchForTests(fakePortal().fetchImpl)
    const deckId = await seedDeck()

    const result = expectOk(
      await invoke<Res<{ hash: string; deckCode: string; shareUrl: string; ttlMs: number }>>(
        'decks:publishCode',
        { deckId }
      )
    )

    expect(result.deckCode).toBe('uj9k')
    expect(result.hash).toBe(HASH)
    expect(result.shareUrl).toContain(encodeURIComponent(HASH))
    expect(result.ttlMs).toBe(DECK_CODE_TTL_MS)
  })

  it('stores the hash on the deck, which is how a local deck gains a lasting id', async () => {
    setPortalFetchForTests(fakePortal().fetchImpl)
    // A deck built in the editor has never been to the portal, so it starts
    // with no sourceRef at all.
    const deckId = await seedDeck({ sourceKind: 'local', sourceRef: null })

    await invoke('decks:publishCode', { deckId })

    const row = await testDb()
      .selectFrom('Deck')
      .select('sourceRef')
      .where('id', '=', deckId)
      .executeTakeFirstOrThrow()
    expect(row.sourceRef).toBe(HASH)
  })

  it('falls back to Unlimited for a deck with no recorded format', async () => {
    const portal = fakePortal()
    setPortalFetchForTests(portal.fetchImpl)
    // Decks created by hand, before formats were stored, must still publish.
    const deckId = await seedDeck({ battleFormat: null, keyCardId: null })

    expectOk(await invoke<Res<unknown>>('decks:publishCode', { deckId }))

    const write = portal.calls.find((c) => c.url.includes('getDeckHash'))!
    expect(write.body.battle_format).toBe(2)
    // Lowest card id, because the fallback reads the list in a stable order.
    expect(write.body.key_card_id).toBe(Math.min(...DECK.cards.map((c) => c.cardId)))
  })

  it('refuses a deck with no cards, without asking the portal', async () => {
    const portal = fakePortal()
    setPortalFetchForTests(portal.fetchImpl)

    const now = Date.now()
    const empty = await testDb()
      .insertInto('Deck')
      .values({ name: '空', class: 'elf', isDefault: 0, createdAt: now, updatedAt: now })
      .returning('id')
      .executeTakeFirstOrThrow()

    const res = await invoke<Res<unknown>>('decks:publishCode', { deckId: empty.id })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('INVALID_INPUT')
    expect(portal.calls).toHaveLength(0)
  })

  it('reports a missing deck', async () => {
    setPortalFetchForTests(fakePortal().fetchImpl)
    const res = await invoke<Res<unknown>>('decks:publishCode', { deckId: 999999 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('NOT_FOUND')
  })

  it('surfaces a portal failure as a code the UI can word itself', async () => {
    setPortalFetchForTests(async () => {
      throw new Error('offline')
    })
    const deckId = await seedDeck()

    const res = await invoke<Res<unknown>>('decks:publishCode', { deckId })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('NETWORK')
  })

  it('renews a code from its hash without touching the deck again', async () => {
    const portal = fakePortal()
    setPortalFetchForTests(portal.fetchImpl)

    const result = expectOk(
      await invoke<Res<{ deckCode: string }>>('decks:renewCode', { hash: HASH })
    )
    expect(result.deckCode).toBe('uj9k')
    // Renewal republishes the same hash; it must not re-encode the card list.
    expect(portal.calls.some((c) => c.url.includes('getDeckHash'))).toBe(false)
  })
})
