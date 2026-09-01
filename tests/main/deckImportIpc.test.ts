/**
 * The stateful half of deck import: the portal client's error handling, and the
 * IPC round trip from a pasted string to rows on disk.
 *
 * No socket is opened. The transport is injected, so what is under test is our
 * reading of the portal rather than the portal's availability.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDecksIpc } from '../../src/main/ipc/decks'
import {
  clearDeckCache,
  fetchDeck,
  setPortalFetchForTests,
  SvwbApiError
} from '../../src/main/data/svwbApi'
import type { DeckImportPreview, StoredDeckCard } from '../../src/shared/deckImport'
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

/** The same deck with one card swapped for another copy, so the fingerprints differ. */
function variantFixture(): unknown {
  const copy = JSON.parse(JSON.stringify(FIXTURE))
  const ids: number[] = copy.data.sort_card_id_list
  const [a, b] = [String(ids[0]), String(ids[1])]
  copy.data.deck_card_num[a] += 1
  copy.data.deck_card_num[b] -= 1
  if (copy.data.deck_card_num[b] === 0) delete copy.data.deck_card_num[b]
  return copy
}

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

let db: TestDb | undefined

// One database for the file, truncated between cases, rather than one per case.
// Tearing a WAL database down and rebuilding it twenty times in a row loses to
// Windows file locking (EBUSY on the -wal/-shm sidecars) long before it buys
// any isolation these tests need.
beforeAll(async () => {
  db = await createMigratedTestDb()
})

afterAll(async () => {
  await removeTestDb(db)
  db = undefined
})

beforeEach(async () => {
  electronMock.handlers.clear()
  clearDeckCache()
  await testDb().deleteFrom('DeckCard').execute()
  await testDb().deleteFrom('Card').execute()
  await testDb().deleteFrom('Deck').execute()
  registerDecksIpc()
})

afterEach(() => {
  setPortalFetchForTests(null)
})

describe('portal client', () => {
  it('sends the language as a Lang header, which is the only thing that works', async () => {
    const seen: RequestInit[] = []
    setPortalFetchForTests(async (_url, init) => {
      seen.push(init!)
      return jsonResponse(FIXTURE)
    })

    await fetchDeck({ kind: 'hash', value: HASH }, { lang: 'cht' })
    expect((seen[0].headers as Record<string, string>).Lang).toBe('cht')
  })

  it('posts a deck code and gets the same shape as a hash', async () => {
    const urls: string[] = []
    setPortalFetchForTests(async (url, init) => {
      urls.push(url)
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ deck_code: 'ufj1' })
      return jsonResponse(FIXTURE)
    })

    const preview = await fetchDeck({ kind: 'code', value: 'ufj1' })
    expect(urls[0]).toContain('/web/DeckCode/getDeck')
    expect(preview.totalCards).toBe(40)
  })

  it('reports result_code 10200 as not-found-or-expired', async () => {
    setPortalFetchForTests(async () =>
      jsonResponse({ data_headers: { result_code: 10200, csrf_token: '' } })
    )

    await expect(fetchDeck({ kind: 'code', value: 'ufj1' })).rejects.toMatchObject({
      code: 'NOT_FOUND_OR_EXPIRED'
    })
  })

  it('does not retry a not-found, because the answer will not change', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      return jsonResponse({ data_headers: { result_code: 10200 } })
    })

    await expect(fetchDeck({ kind: 'code', value: 'ufj1' })).rejects.toBeInstanceOf(SvwbApiError)
    expect(calls).toBe(1)
  })

  it('retries once on a network failure and succeeds', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      if (calls === 1) throw new Error('socket hang up')
      return jsonResponse(FIXTURE)
    })

    const preview = await fetchDeck({ kind: 'hash', value: HASH })
    expect(calls).toBe(2)
    expect(preview.totalCards).toBe(40)
  })

  it('gives up after the retry', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      throw new Error('offline')
    })

    await expect(fetchDeck({ kind: 'hash', value: HASH })).rejects.toMatchObject({
      code: 'NETWORK'
    })
    expect(calls).toBe(2)
  })

  it('classifies a non-JSON body as an unexpected shape, not a network error', async () => {
    setPortalFetchForTests(async () => new Response('<html>maintenance</html>', { status: 200 }))
    await expect(fetchDeck({ kind: 'hash', value: HASH })).rejects.toMatchObject({
      code: 'UNEXPECTED_SHAPE'
    })
  })

  it('treats a non-2xx as a network error', async () => {
    setPortalFetchForTests(async () => jsonResponse({}, 503))
    await expect(fetchDeck({ kind: 'hash', value: HASH })).rejects.toMatchObject({
      code: 'NETWORK'
    })
  })

  it('serves a repeated lookup from cache instead of asking again', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      return jsonResponse(FIXTURE)
    })

    await fetchDeck({ kind: 'hash', value: HASH })
    await fetchDeck({ kind: 'hash', value: HASH })
    expect(calls).toBe(1)
  })

  it('caches per language, so switching language does not serve stale names', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      return jsonResponse(FIXTURE)
    })

    await fetchDeck({ kind: 'hash', value: HASH }, { lang: 'cht' })
    await fetchDeck({ kind: 'hash', value: HASH }, { lang: 'ja' })
    expect(calls).toBe(2)
  })
})

describe('deck import IPC', () => {
  beforeEach(() => {
    setPortalFetchForTests(async () => jsonResponse(FIXTURE))
  })

  it('rejects a string that is not a code, hash or link without going to the network', async () => {
    const calls = vi.fn()
    setPortalFetchForTests(async () => {
      calls()
      return jsonResponse(FIXTURE)
    })

    const res = await invoke<Res<unknown>>('decks:importPreview', { text: 'not a deck' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('INVALID_INPUT')
    expect(calls).not.toHaveBeenCalled()
  })

  it('surfaces the error code, not a sentence, so the UI can pick its own wording', async () => {
    setPortalFetchForTests(async () => jsonResponse({ data_headers: { result_code: 10200 } }))

    const res = await invoke<Res<unknown>>('decks:importPreview', { text: 'ufj1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('NOT_FOUND_OR_EXPIRED')
  })

  it('previews without writing anything', async () => {
    const { preview, duplicateDeckId } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview; duplicateDeckId: number | null }>>(
        'decks:importPreview',
        { text: HASH }
      )
    )

    expect(preview.className).toBe('nemesis')
    expect(preview.totalCards).toBe(40)
    expect(duplicateDeckId).toBeNull()

    const decks = await testDb().selectFrom('Deck').selectAll().execute()
    expect(decks).toHaveLength(0)
  })

  it('commits a preview into Deck, DeckCard and Card', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview; duplicateDeckId: number | null }>>(
        'decks:importPreview',
        { text: HASH }
      )
    )
    const deck = expectOk(
      await invoke<Res<{ id: number; name: string; class: string }>>('decks:import', {
        preview,
        name: '復仇者測試'
      })
    )

    expect(deck.class).toBe('nemesis')

    const cards = await testDb()
      .selectFrom('DeckCard')
      .selectAll()
      .where('deckId', '=', deck.id)
      .execute()
    expect(cards).toHaveLength(16)
    expect(cards.reduce((sum, c) => sum + c.count, 0)).toBe(40)

    const master = await testDb().selectFrom('Card').selectAll().execute()
    expect(master).toHaveLength(16)
    expect(master.every((c) => c.lang === 'cht')).toBe(true)
    // The two image hashes address different paths and are not interchangeable;
    // storing one in the other's column would 403 at display time.
    expect(master.every((c) => c.imageHash !== c.bannerHash)).toBe(true)
  })

  it('stores the raw payload but never hands it to the renderer', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview; duplicateDeckId: number | null }>>(
        'decks:importPreview',
        { text: HASH }
      )
    )
    const deck = expectOk(
      await invoke<Res<Record<string, unknown>>>('decks:import', { preview, name: 'raw' })
    )

    expect(deck).not.toHaveProperty('rawJson')
    const row = await testDb()
      .selectFrom('Deck')
      .select('rawJson')
      .where('id', '=', deck.id as number)
      .executeTakeFirstOrThrow()
    expect(row.rawJson).toBeTruthy()
    expect(JSON.parse(row.rawJson!)).toHaveProperty('deck_card_num')
  })

  it('records the hash as the source ref, and nothing at all for a code', async () => {
    const fromHash = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    const a = expectOk(
      await invoke<Res<{ sourceKind: string; sourceRef: string | null }>>('decks:import', {
        preview: fromHash.preview,
        name: 'from hash'
      })
    )
    expect(a.sourceKind).toBe('hash')
    expect(a.sourceRef).toBe(HASH)

    // A different deck, or the content check below would fire first and this
    // would be testing duplicate handling instead of provenance.
    setPortalFetchForTests(async () => jsonResponse(variantFixture()))
    const fromCode = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: 'ufj1' })
    )
    const b = expectOk(
      await invoke<Res<{ sourceKind: string; sourceRef: string | null }>>('decks:import', {
        preview: fromCode.preview,
        name: 'from code'
      })
    )
    // A code is dead three minutes after issue and then reused, so keeping one
    // would be recording a pointer to somebody else's deck.
    expect(b.sourceKind).toBe('code')
    expect(b.sourceRef).toBeNull()
  })

  it('detects a duplicate by contents and names the deck it clashed with', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    const first = expectOk(
      await invoke<Res<{ id: number }>>('decks:import', { preview, name: 'first' })
    )

    const flagged = expectOk(
      await invoke<Res<{ duplicateDeckId: number | null }>>('decks:importPreview', { text: HASH })
    )
    expect(flagged.duplicateDeckId).toBe(first.id)

    const res = await invoke<Res<unknown>>('decks:import', { preview, name: 'second' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe(`DUPLICATE_CONTENT:${first.id}`)
  })

  it('updates the existing deck in place when the user chooses to replace', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    const first = expectOk(
      await invoke<Res<{ id: number }>>('decks:import', { preview, name: 'original' })
    )

    const replaced = expectOk(
      await invoke<Res<{ id: number; name: string }>>('decks:import', {
        preview,
        name: 'renamed',
        replaceDeckId: first.id
      })
    )

    expect(replaced.id).toBe(first.id)
    expect(replaced.name).toBe('renamed')

    const decks = await testDb().selectFrom('Deck').selectAll().execute()
    expect(decks).toHaveLength(1)
    // The old card rows must be gone rather than merged with the new ones.
    const cards = await testDb().selectFrom('DeckCard').selectAll().execute()
    expect(cards).toHaveLength(16)
  })

  it('reads a deck list back sorted by cost', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    const deck = expectOk(
      await invoke<Res<{ id: number }>>('decks:import', { preview, name: 'readback' })
    )

    const cards = expectOk(await invoke<Res<StoredDeckCard[]>>('decks:cards', { deckId: deck.id }))
    expect(cards).toHaveLength(16)
    expect(cards.reduce((sum, c) => sum + c.count, 0)).toBe(40)

    const costs = cards.map((c) => c.cost ?? 99)
    expect([...costs].sort((a, b) => a - b)).toEqual(costs)
    expect(cards.every((c) => c.name && !c.name.startsWith('#'))).toBe(true)
  })

  it('degrades to bare ids when the card cache is missing rows', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    const deck = expectOk(
      await invoke<Res<{ id: number }>>('decks:import', { preview, name: 'degraded' })
    )

    // The Card table is a cache of somebody else's data. Losing it must cost
    // detail, not the deck list.
    await testDb().deleteFrom('Card').execute()

    const cards = expectOk(await invoke<Res<StoredDeckCard[]>>('decks:cards', { deckId: deck.id }))
    expect(cards).toHaveLength(16)
    expect(cards.every((c) => c.name.startsWith('#'))).toBe(true)
    expect(cards.reduce((sum, c) => sum + c.count, 0)).toBe(40)
  })

  it('lists a deck with what it is made of, and the card that represents it', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    expectOk(await invoke<Res<unknown>>('decks:import', { preview, name: '牌面' }))

    const [deck] = expectOk(
      await invoke<
        Res<
          {
            composition: { follower: number; spell: number; amulet: number } | null
            heroBannerHash: string | null
          }[]
        >
      >('decks:all')
    )

    // The portal's own totals for this deck.
    expect(deck.composition).toEqual({ follower: 32, spell: 6, amulet: 2 })

    // 統世之王‧巴力巴布 - cost 9, the most expensive legendary in the deck, and
    // the card a player would name if asked what this deck is.
    expect(deck.heroBannerHash).toBe('5dfc508e62a345d38ce91a56e08f55df')
  })

  it('falls down the rarity ladder rather than leaving a deck with no art', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    expectOk(await invoke<Res<{ id: number }>>('decks:import', { preview, name: 'budget' }))

    // A deck with no legendaries in it. The one gold card is now the rarest
    // thing there, so it has to be the face - the tile must not come back
    // blank just because nothing in the deck is rarity 4.
    const gold = preview.cards[3]!
    await testDb().updateTable('Card').set({ rarity: 1 }).execute()
    await testDb()
      .updateTable('Card')
      .set({ rarity: 3 })
      .where('cardId', '=', gold.cardId)
      .execute()

    const [after] = expectOk(await invoke<Res<{ heroBannerHash: string | null }[]>>('decks:all'))
    expect(after.heroBannerHash).not.toBeNull()
    expect(after.heroBannerHash).toBe(gold.bannerHash)
  })

  it('leaves composition null for a deck with no card list', async () => {
    // Created by hand: three zeroes would claim the deck is empty, when the
    // truth is that we have no card list for it at all.
    expectOk(await invoke<Res<unknown>>('decks:create', { name: '手動', class: 'elf' }))

    const [deck] = expectOk(
      await invoke<Res<{ composition: unknown; heroBannerHash: string | null }[]>>('decks:all')
    )
    expect(deck.composition).toBeNull()
    expect(deck.heroBannerHash).toBeNull()
  })

  it('deletes the card list with its deck', async () => {
    const { preview } = expectOk(
      await invoke<Res<{ preview: DeckImportPreview }>>('decks:importPreview', { text: HASH })
    )
    const deck = expectOk(
      await invoke<Res<{ id: number }>>('decks:import', { preview, name: 'doomed' })
    )

    expectOk(await invoke<Res<unknown>>('decks:delete', { id: deck.id }))
    const cards = await testDb().selectFrom('DeckCard').selectAll().execute()
    expect(cards).toHaveLength(0)
  })
})
