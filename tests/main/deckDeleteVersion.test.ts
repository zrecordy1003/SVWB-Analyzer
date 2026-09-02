/**
 * Deck versioning, stage 2: discarding ONE version (docs/deck-versioning-plan.md).
 *
 * `decks:delete` acts on a whole family; `decks:deleteVersion` acts on a single
 * row and follows the same retire rule (hard-delete when unreferenced, archive
 * when referenced, clear isDefault on archive). The one twist under test: the
 * family's last unarchived version cannot be discarded on its own, because that
 * would either resurrect an archived old version as "current" or make the deck
 * vanish from the list - so it behaves exactly like deleting the family.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDecksIpc } from '../../src/main/ipc/decks'
import { createMigratedTestDb, insertMatch, removeTestDb, testDb, type TestDb } from '../helpers/db'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    })
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  clipboard: { readText: vi.fn(() => '') }
}))

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
const CARDS_V1 = [
  { cardId: 900001, count: 3 },
  { cardId: 900002, count: 3 }
]
const CARDS_V2 = [
  { cardId: 900001, count: 3 },
  { cardId: 900003, count: 3 }
]
const CARDS_V3 = [
  { cardId: 900001, count: 2 },
  { cardId: 900003, count: 3 },
  { cardId: 900004, count: 1 }
]

type SavedDeck = { id: number; familyId: number | null; isDefault: boolean }

async function saveLocal(input: Record<string, unknown>): Promise<SavedDeck> {
  return expectOk(
    await invoke<Res<SavedDeck>>('decks:saveLocal', {
      name: 'Aggro',
      classId: WITCH,
      cards: CARDS_V1,
      ...input
    })
  )
}

async function playMatch(deckId: number): Promise<number> {
  return insertMatch({
    result: true,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    my_deckId: deckId,
    playedAt: new Date()
  })
}

async function deckRows(): Promise<{ id: number; archivedAt: number | null; isDefault: number }[]> {
  return testDb()
    .selectFrom('Deck')
    .select(['id', 'archivedAt', 'isDefault'])
    .orderBy('id', 'asc')
    .execute()
}

type DeleteVersionResult = { deleted: number; archived: number; familyDeleted: boolean }
type Impact = { matches: number; versions: number; isLastActive: boolean }

/** v1 (played) -> v2 (played) -> v3 (unplayed, current). */
async function threeVersions(): Promise<{ v1: SavedDeck; v2: SavedDeck; v3: SavedDeck }> {
  const v1 = await saveLocal({ isDefault: true })
  await playMatch(v1.id)
  const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
  await playMatch(v2.id)
  const v3 = await saveLocal({ deckId: v2.id, cards: CARDS_V3 })
  return { v1, v2, v3 }
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
  await testDb().deleteFrom('MatchTag').execute()
  await testDb().deleteFrom('Match').execute()
  await testDb().deleteFrom('DeckCard').execute()
  await testDb().deleteFrom('Deck').execute()
  await testDb().deleteFrom('Card').execute()
  registerDecksIpc()
})

describe('decks:deleteVersion', () => {
  it('hard-deletes an unplayed old version and leaves the rest of the family alone', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 }) // unplayed
    await playMatch(v2.id)
    const v3 = await saveLocal({ deckId: v2.id, cards: CARDS_V3 }) // unplayed, current
    // Make v2 the unplayed one by moving its only match off it.
    await testDb()
      .updateTable('Match')
      .set({ my_deckId: v3.id })
      .where('my_deckId', '=', v2.id)
      .execute()

    const res = expectOk(
      await invoke<Res<DeleteVersionResult>>('decks:deleteVersion', { id: v2.id })
    )
    expect(res).toMatchObject({ deleted: 1, archived: 0, familyDeleted: false })

    const rows = await deckRows()
    expect(rows.map((r) => r.id)).toEqual([v1.id, v3.id])
    expect(rows.every((r) => r.archivedAt === null)).toBe(true)
    // Its card list went with it (FK cascade), the others' did not.
    const cards = await testDb().selectFrom('DeckCard').select('deckId').execute()
    expect(new Set(cards.map((c) => c.deckId))).toEqual(new Set([v1.id, v3.id]))
  })

  it('archives a played old version, keeps its matches, and the current version stays current', async () => {
    const { v1, v3 } = await threeVersions()

    const res = expectOk(
      await invoke<Res<DeleteVersionResult>>('decks:deleteVersion', { id: v1.id })
    )
    expect(res).toMatchObject({ deleted: 0, archived: 1, familyDeleted: false })

    const rows = await deckRows()
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.id === v1.id)?.archivedAt).not.toBeNull()
    const match = await testDb()
      .selectFrom('Match')
      .select('my_deckId')
      .where('my_deckId', '=', v1.id)
      .executeTakeFirst()
    expect(match?.my_deckId).toBe(v1.id)

    // The list still shows v3 - discarding an old version must not touch it.
    const listed = expectOk(await invoke<Res<{ id: number }[]>>('decks:all'))
    expect(listed.map((d) => d.id)).toEqual([v3.id])
    // All versions are still visible on request, archived one included.
    const all = expectOk(await invoke<Res<{ id: number }[]>>('decks:all', { scope: 'all' }))
    expect(all).toHaveLength(3)
  })

  it('clears isDefault when it archives the version that held it', async () => {
    const v1 = await saveLocal({ isDefault: true })
    await playMatch(v1.id)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
    // The fork carried isDefault to v2; hand it back to v1 to exercise the clear.
    expectOk(await invoke<Res<unknown>>('decks:setDefaultForClass', { deckId: v1.id }))

    expectOk(await invoke<Res<DeleteVersionResult>>('decks:deleteVersion', { id: v1.id }))

    const engineSees = await testDb()
      .selectFrom('Deck')
      .select('id')
      .where('class', '=', 'witch')
      .where('isDefault', '=', 1)
      .execute()
    expect(engineSees).toHaveLength(0)
    expect((await deckRows()).find((r) => r.id === v2.id)?.archivedAt).toBeNull()
  })

  it('treats the last unarchived version as the whole deck: same result as decks:delete', async () => {
    const { v1, v2, v3 } = await threeVersions()
    // Archive v1 first so the family is [archived v1, active v2, active v3].
    expectOk(await invoke<Res<unknown>>('decks:deleteVersion', { id: v1.id }))
    // Discarding v3 (unplayed) is a plain single-row delete: v2 is still active.
    const first = expectOk(
      await invoke<Res<DeleteVersionResult>>('decks:deleteVersion', { id: v3.id })
    )
    expect(first).toMatchObject({ deleted: 1, archived: 0, familyDeleted: false })
    expect(expectOk(await invoke<Res<{ id: number }[]>>('decks:all')).map((d) => d.id)).toEqual([
      v2.id
    ])

    // Now v2 is the last active version. Discarding it sweeps the family.
    const last = expectOk(
      await invoke<Res<DeleteVersionResult>>('decks:deleteVersion', { id: v2.id })
    )
    expect(last.familyDeleted).toBe(true)
    // v1 was already archived and is still referenced -> archived again (counted);
    // v2 is referenced -> archived.
    expect(last).toMatchObject({ deleted: 0, archived: 2 })

    const rows = await deckRows()
    expect(rows.map((r) => r.id)).toEqual([v1.id, v2.id])
    expect(rows.every((r) => r.archivedAt !== null)).toBe(true)
    // Nothing resurfaces in the list - the point of sweeping the family.
    expect(expectOk(await invoke<Res<{ id: number }[]>>('decks:all'))).toHaveLength(0)
  })

  it('rejects an unknown id', async () => {
    const res = await invoke<Res<unknown>>('decks:deleteVersion', { id: 999999 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('NOT_FOUND:Deck')
  })
})

describe('decks:versionImpact', () => {
  it('reports the match count of that one version and whether it is the last active one', async () => {
    const { v1, v2, v3 } = await threeVersions()
    await playMatch(v1.id)

    expect(expectOk(await invoke<Res<Impact>>('decks:versionImpact', { id: v1.id }))).toEqual({
      matches: 2,
      versions: 3,
      isLastActive: false
    })
    expect(expectOk(await invoke<Res<Impact>>('decks:versionImpact', { id: v2.id }))).toEqual({
      matches: 1,
      versions: 3,
      isLastActive: false
    })
    expect(expectOk(await invoke<Res<Impact>>('decks:versionImpact', { id: v3.id }))).toEqual({
      matches: 0,
      versions: 3,
      isLastActive: false
    })
  })

  it('flags the only unarchived version as last-active', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
    expectOk(await invoke<Res<unknown>>('decks:deleteVersion', { id: v1.id })) // archives v1

    const impact = expectOk(await invoke<Res<Impact>>('decks:versionImpact', { id: v2.id }))
    expect(impact).toEqual({ matches: 0, versions: 2, isLastActive: true })
    // An already-archived version is never "last active".
    const archived = expectOk(await invoke<Res<Impact>>('decks:versionImpact', { id: v1.id }))
    expect(archived.isLastActive).toBe(false)
  })
})
