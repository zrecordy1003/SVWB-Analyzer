import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDecksIpc } from '../../src/main/ipc/decks'
import { registerMatchesIpc } from '../../src/main/ipc/matches'
import { registerTagsIpc } from '../../src/main/ipc/tags'
import { getPrisma } from '../../src/main/db/prismaClient'
import { createMigratedTestDb, removeTestDb, type TestDb } from '../helpers/db'

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
    const match = await getPrisma().match.create({
      data: {
        result: true,
        play_order: 'first',
        my_class: 'elf',
        oppo_class: 'royal',
        mode: 'ranked',
        my_deckId: deck.data.id,
        year: playedAt.getUTCFullYear(),
        month: playedAt.getUTCMonth() + 1,
        day: playedAt.getUTCDate(),
        playedAt,
        endedAt: new Date('2026-05-20T12:05:00Z')
      }
    })

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

    const stats = await invoke<any>('decks:stats', {
      deckIds: [deck.data.id],
      rangeKey: 'all'
    })
    expect(stats).toMatchObject({
      ok: true,
      data: [{ deckId: deck.data.id, total: 1, wins: 1, winRate: 100 }]
    })
  })
})
