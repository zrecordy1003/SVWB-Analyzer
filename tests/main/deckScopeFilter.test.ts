/**
 * `myDeckIds` after deck versioning (see `main/ipc/deckScope.ts`).
 *
 * The pickers hand the filter the CURRENT version's id. Before this, the match
 * list and the analyzer compared that id row by row, so every game played on a
 * version before the fork silently fell out of "only this deck". The default
 * scope now expands each id to its family; `'deck'` keeps the exact-row meaning
 * for the analyzer's single-version mode.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerDecksIpc } from '../../src/main/ipc/decks'
import { registerMatchesIpc } from '../../src/main/ipc/matches'
import { getRankedWinrateByOpponent } from '../../src/main/ipc/helper'
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
const CARDS_V1 = [{ cardId: 900001, count: 3 }]
const CARDS_V2 = [{ cardId: 900002, count: 3 }]

async function saveLocal(input: Record<string, unknown>): Promise<{ id: number }> {
  return expectOk(
    await invoke<Res<{ id: number }>>('decks:saveLocal', {
      name: 'Aggro',
      classId: WITCH,
      cards: CARDS_V1,
      ...input
    })
  )
}

async function playMatch(deckId: number, win: boolean, oppo = 'dragon'): Promise<number> {
  return insertMatch({
    result: win,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: oppo,
    mode: 'ranked',
    my_deckId: deckId,
    playedAt: new Date('2026-05-10T12:00:00Z')
  })
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
  registerDecksIpc()
  registerMatchesIpc()
})

/** v1 with two games, v2 (current) with one; plus an unrelated deck with one. */
async function seed(): Promise<{ v1: number; v2: number; other: number }> {
  const v1 = await saveLocal({})
  await playMatch(v1.id, true)
  await playMatch(v1.id, false)
  const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
  await playMatch(v2.id, true)
  const other = await saveLocal({ name: 'Other', cards: [{ cardId: 900009, count: 3 }] })
  await playMatch(other.id, true)
  return { v1: v1.id, v2: v2.id, other: other.id }
}

describe('match list filters', () => {
  it('expands the current version id to the whole family by default', async () => {
    const { v2 } = await seed()
    const n = await invoke<number>('matches:count', { rangeKey: 'all', myDeckIds: [v2] })
    expect(n).toBe(3)

    const page = await invoke<{ rows: { my_deckId: number }[]; total: number }>(
      'matches:queryList',
      { rangeKey: 'all', myDeckIds: [v2], pageSize: 10 }
    )
    expect(page.total).toBe(3)
    expect(page.rows).toHaveLength(3)
  })

  it('also expands when handed an OLD version id', async () => {
    const { v1 } = await seed()
    expect(await invoke<number>('matches:count', { rangeKey: 'all', myDeckIds: [v1] })).toBe(3)
  })

  it("scope 'deck' keeps the exact-row meaning", async () => {
    const { v1, v2 } = await seed()
    expect(
      await invoke<number>('matches:count', {
        rangeKey: 'all',
        myDeckIds: [v2],
        myDeckScope: 'deck'
      })
    ).toBe(1)
    expect(
      await invoke<number>('matches:count', {
        rangeKey: 'all',
        myDeckIds: [v1],
        myDeckScope: 'deck'
      })
    ).toBe(2)
  })

  it('does not leak other families in', async () => {
    const { v2, other } = await seed()
    expect(await invoke<number>('matches:count', { rangeKey: 'all', myDeckIds: [v2] })).toBe(3)
    expect(await invoke<number>('matches:count', { rangeKey: 'all', myDeckIds: [other] })).toBe(1)
    expect(await invoke<number>('matches:count', { rangeKey: 'all', myDeckIds: [v2, other] })).toBe(
      4
    )
  })

  it('still counts games on a version that has since been archived', async () => {
    const { v1, v2 } = await seed()
    expectOk(await invoke<Res<unknown>>('decks:deleteVersion', { id: v1 }))
    expect(await invoke<number>('matches:count', { rangeKey: 'all', myDeckIds: [v2] })).toBe(3)
  })
})

describe('getRankedWinrateByOpponent', () => {
  it('counts the whole family for the current version id by default', async () => {
    const { v2 } = await seed()
    const stats = await getRankedWinrateByOpponent({
      myClass: 'witch' as never,
      rangeKey: 'all',
      myDeckIds: [v2]
    })
    expect(stats.overall.all).toEqual({ wins: 2, total: 3, winRate: 66.7 })
    // The chip still names the deck that was actually picked.
    expect(stats.myDecks?.map((d) => d.id)).toEqual([v2])
  })

  it("scope 'deck' isolates one version", async () => {
    const { v1, v2 } = await seed()
    const only1 = await getRankedWinrateByOpponent({
      myClass: 'witch' as never,
      rangeKey: 'all',
      myDeckIds: [v1],
      myDeckScope: 'deck'
    })
    expect(only1.overall.all).toEqual({ wins: 1, total: 2, winRate: 50 })
    const only2 = await getRankedWinrateByOpponent({
      myClass: 'witch' as never,
      rangeKey: 'all',
      myDeckIds: [v2],
      myDeckScope: 'deck'
    })
    expect(only2.overall.all).toEqual({ wins: 1, total: 1, winRate: 100 })
  })

  it('applies the same expansion inside the "most recent N" sub-select', async () => {
    const { v2 } = await seed()
    const stats = await getRankedWinrateByOpponent({
      myClass: 'witch' as never,
      rangeKey: 'all',
      myDeckIds: [v2],
      limit: 2
    })
    expect(stats.overall.all.total).toBe(2)
  })
})
