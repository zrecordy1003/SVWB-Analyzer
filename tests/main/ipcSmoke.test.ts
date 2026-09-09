import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDecksIpc } from '../../src/main/ipc/decks'
import { registerMatchesIpc } from '../../src/main/ipc/matches'
import { registerTagsIpc } from '../../src/main/ipc/tags'
import { createMigratedTestDb, insertMatch, removeTestDb, type TestDb } from '../helpers/db'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

let testDb: TestDb | undefined

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.handlers.get(channel)
  expect(handler, `Missing IPC handler: ${channel}`).toBeTypeOf('function')
  return (await handler!({}, ...args)) as T
}

describe('IPC smoke flow', () => {
  beforeEach(async () => {
    electronMock.handlers.clear()
    testDb = await createMigratedTestDb()
    registerDecksIpc()
    registerTagsIpc()
    registerMatchesIpc()
  })

  afterEach(async () => {
    await removeTestDb(testDb)
    testDb = undefined
  })

  it('creates reference data and returns paged matches with tags and deck stats', async () => {
    const category = await invoke<any>('deckCategories:create', { name: 'Smoke Category' })
    expect(category.ok).toBe(true)

    const deck = await invoke<any>('decks:create', {
      name: 'Smoke Deck',
      class: 'elf',
      categoryId: category.data.id,
      isDefault: true
    })
    expect(deck.ok).toBe(true)

    const duplicate = await invoke<any>('decks:create', {
      name: 'smoke deck',
      class: 'elf',
      categoryId: category.data.id
    })
    expect(duplicate).toMatchObject({ ok: false, error: 'DUPLICATE_NAME' })

    const tag = await invoke<any>('tags:create', ' ladder ')
    const playedAt = new Date('2026-05-20T12:00:00Z')
    const match = {
      id: await insertMatch({
        result: true,
        play_order: 'first',
        my_class: 'elf',
        oppo_class: 'royal',
        mode: 'ranked',
        my_deckId: deck.data.id,
        playedAt,
        endedAt: new Date('2026-05-20T12:05:00Z')
      })
    }

    await invoke('matches:setTags', match.id, ['ladder'])

    const count = await invoke<number>('matches:count', { rangeKey: 'all', tagIds: [tag.id] })
    expect(count).toBe(1)

    const page = await invoke<any[]>('matches:getPage', {
      pageIndex: 0,
      pageSize: 10,
      rangeKey: 'all',
      tagIds: [tag.id]
    })
    expect(page).toHaveLength(1)
    expect(page[0]).toMatchObject({
      id: match.id,
      my_deck: { id: deck.data.id, name: 'Smoke Deck' },
      tags: [{ tag: { id: tag.id, name: 'ladder' } }]
    })

    const list = await invoke<{ rows: any[]; total: number }>('matches:queryList', {
      pageIndex: 0,
      pageSize: 10,
      rangeKey: 'all',
      tagIds: [tag.id]
    })
    expect(list).toMatchObject({ total: 1 })
    expect(list.rows[0]).toMatchObject({
      id: match.id,
      my_deck: { id: deck.data.id, name: 'Smoke Deck' },
      tagCount: 1,
      tags: [{ id: tag.id, name: 'ladder' }]
    })

    const extras = await invoke<{ note: string | null; tags: { id: number; name: string }[] }>(
      'matches:getExtras',
      match.id
    )
    expect(extras).toEqual({ note: null, tags: [{ id: tag.id, name: 'ladder' }] })

    const secondMatch = {
      id: await insertMatch({
        result: false,
        play_order: 'second',
        my_class: 'witch',
        oppo_class: 'dragon',
        mode: 'ranked',
        playedAt
      })
    }
    const firstCursorPage = await invoke<{
      rows: any[]
      total: number | null
      hasMore: boolean
      nextCursor: { playedAt: string; id: number } | null
    }>('matches:queryList', { pageSize: 1, rangeKey: 'all' })
    expect(firstCursorPage).toMatchObject({
      total: 2,
      hasMore: true,
      rows: [{ id: secondMatch.id }]
    })
    expect(firstCursorPage.nextCursor).toEqual({
      playedAt: playedAt.toISOString(),
      id: secondMatch.id
    })

    const secondCursorPage = await invoke<{
      rows: any[]
      total: number | null
      hasMore: boolean
      nextCursor: { playedAt: string; id: number } | null
    }>('matches:queryList', {
      pageSize: 1,
      rangeKey: 'all',
      cursor: firstCursorPage.nextCursor
    })
    expect(secondCursorPage).toMatchObject({
      total: null,
      hasMore: false,
      nextCursor: null,
      rows: [{ id: match.id }]
    })

    const stats = await invoke<any>('decks:stats', {
      deckIds: [deck.data.id],
      rangeKey: 'all'
    })
    expect(stats).toMatchObject({
      ok: true,
      data: [{ deckId: deck.data.id, total: 1, wins: 1, winRate: 100 }]
    })
  })

  /**
   * The provenance summary against a real database, not a hand-built fixture.
   *
   * The counting itself is covered by `provenanceStats.test.ts`; what this adds
   * is that an edit through the real IPC path leaves the row in the shape that
   * summary expects - the two are written in different files and nothing else
   * checks that they agree.
   */
  it('summarises where match data came from, and what was corrected by hand', async () => {
    const playedAt = new Date('2026-05-20T12:00:00Z')

    const flagged = await insertMatch({
      result: false,
      play_order: 'second',
      my_class: 'witch',
      oppo_class: 'dragon',
      mode: 'weekendPlaza',
      playedAt,
      recog_flags: ['weak-mode-accepted']
    })
    // A clean engine-written match, and one from before provenance existed.
    await insertMatch({
      result: true,
      play_order: 'first',
      my_class: 'elf',
      oppo_class: 'royal',
      mode: 'ranked',
      playedAt
    })
    await insertMatch({
      result: true,
      play_order: 'first',
      my_class: 'elf',
      oppo_class: 'royal',
      mode: 'ranked',
      playedAt,
      source: null
    })

    const before = await invoke<any>('matches:provenanceStats')
    expect(before.bySource).toEqual({ engine: 2, manual: 0, unknown: 1 })
    expect(before.flagged['weak-mode-accepted']).toEqual({ matches: 1, corrected: 0 })

    const current = await invoke<any>('matches:getById', flagged)
    await invoke('matches:updateWithExtras', {
      id: flagged,
      prevUpdatedAt: current.updatedAt,
      mode: 'ranked',
      note: 'plaza 誤判'
    })

    const after = await invoke<any>('matches:provenanceStats')
    expect(after.flagged['weak-mode-accepted']).toEqual({ matches: 1, corrected: 1 })
    // One engine row was flagged, so the comparison group is the other one.
    expect(after.unflagged).toEqual({ matches: 1, corrected: 0 })
    expect(after.editedByField).toEqual({ mode: 1, note: 1 })
    expect(after.transitions).toEqual([
      { field: 'mode', from: 'weekendPlaza', to: 'ranked', count: 1 }
    ])
  })

  /**
   * The opponent's nameplate reaches the renderer as the bytes the engine wrote.
   *
   * It is a PNG the UI renders directly, so any mangling on the way out - a
   * column dropped by an explicit `select`, a mapper that rebuilds the row field
   * by field, a BLOB coerced to text - would surface months later as a broken
   * image and nowhere else. Nothing inside the engine reads this column back, so
   * this path is the only reader there is.
   *
   * What this does NOT cover: Electron's own serialisation. `invoke` here calls
   * the handler directly, so the structured clone that carries a `Buffer` across
   * the real IPC boundary is not exercised. This covers the half that can
   * silently drop the column; the other half has no seam to test it at.
   */
  it('hands the opponent nameplate to the renderer byte for byte', async () => {
    // Both extremes and a NUL, because a TEXT column would truncate at the NUL
    // and an encoding round trip would rewrite the high byte.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f])

    const withPlate = await insertMatch({
      result: true,
      play_order: 'first',
      my_class: 'elf',
      oppo_class: 'royal',
      mode: 'ranked',
      playedAt: new Date('2026-05-20T12:00:00Z'),
      oppo_name_crop: png
    })
    // A CPU opponent has no name. NULL and not an empty blob: the UI shows
    // nothing for one and a zero-width image for the other.
    const withoutPlate = await insertMatch({
      result: false,
      play_order: 'second',
      my_class: 'elf',
      oppo_class: 'royal',
      mode: 'cpu',
      playedAt: new Date('2026-05-20T12:10:00Z')
    })

    const byId = await invoke<any>('matches:getById', withPlate)
    expect(byId.oppo_name_crop).toBeInstanceOf(Uint8Array)
    expect(Array.from<number>(byId.oppo_name_crop)).toEqual(Array.from(png))

    // Through the paged query as well: it is a different query from `getById`
    // and it is the one the match list actually calls.
    const page = await invoke<any>('matches:getPage', { rangeKey: 'all', limit: 10 })
    const rows: any[] = page.rows ?? page
    const paged = rows.find((row) => row.id === withPlate)
    expect(Array.from<number>(paged.oppo_name_crop)).toEqual(Array.from(png))
    expect(rows.find((row) => row.id === withoutPlate).oppo_name_crop).toBeNull()
  })
})
