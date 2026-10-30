/**
 * Clearing recorded data from Settings.
 *
 * Against real migrated databases, because what matters is what the schema does
 * with a DELETE: the cascades, the SET NULLs, and - for the user who has sync on -
 * the triggers that turn each deletion into one for their other devices.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { clearData, countClearable } from '../../src/main/ipc/dataClear'
import {
  Cloud,
  addDeck,
  addMatch,
  addTag,
  createMachine,
  dump,
  outboxSize,
  tagMatch,
  type Machine
} from '../helpers/syncMachine'
import { createMigratedTestDb, removeTestDb, testDb, type TestDb } from '../helpers/db'
import { registerDataClearIpc } from '../../src/main/ipc/dataClear'

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

const machines: Machine[] = []
async function machine(name: string): Promise<Machine> {
  const m = await createMachine(name)
  machines.push(m)
  return m
}
afterEach(async () => {
  for (const m of machines.splice(0)) await m.close()
})

const ALL = { matches: true, decks: true, tags: true, categories: true }
const NONE = { matches: false, decks: false, tags: false, categories: false }

/** Some of everything, wired together the way real data is. */
async function populate(m: Machine): Promise<void> {
  const deck = await addDeck(m, { name: 'd', categoryId: 'aggro' })
  await m.db
    .insertInto('DeckCategory')
    .values({ id: 'cMINE', name: '我的分類', sort: 9, createdAt: 1, updatedAt: null } as never)
    .execute()
  await m.db.updateTable('Deck').set({ categoryId: 'cMINE' }).where('id', '=', deck.id).execute()
  const tag = await addTag(m, 't')
  for (let i = 0; i < 3; i++) {
    const match = await addMatch(m, { my_deckId: deck.id, note: `m${i}` })
    await tagMatch(m, match.id, tag.id)
    await m.db
      .insertInto('MatchOpeningCard')
      .values({ matchId: match.id, stage: 'pre', slot: 0, cardId: 100 + i } as never)
      .execute()
  }
}

describe('how many of each there is', () => {
  it('counts every kind, and leaves the three built-in categories out', async () => {
    const m = await machine('a')
    expect(await countClearable(m.db)).toEqual({ matches: 0, decks: 0, tags: 0, categories: 0 })
    await populate(m)
    expect(await countClearable(m.db)).toEqual({ matches: 3, decks: 1, tags: 1, categories: 1 })
  })
})

describe('what a clear removes', () => {
  it('matches only: the games go with their hands and tag links; decks and tags stay', async () => {
    const m = await machine('a')
    await populate(m)
    const result = await clearData(m.db, { ...NONE, matches: true }, path.join(m.dir, 'bk'))

    expect(result.deleted).toEqual({ matches: 3, decks: 0, tags: 0, categories: 0 })
    expect(await m.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
    expect(await m.db.selectFrom('MatchOpeningCard').selectAll().execute()).toHaveLength(0)
    expect(await m.db.selectFrom('MatchTag').selectAll().execute()).toHaveLength(0)
    expect(await m.db.selectFrom('Deck').selectAll().execute()).toHaveLength(1)
    expect(await m.db.selectFrom('Tag').selectAll().execute()).toHaveLength(1)
  })

  it('decks only: the matches stay, with their deck field emptied', async () => {
    const m = await machine('a')
    await populate(m)
    await clearData(m.db, { ...NONE, decks: true }, path.join(m.dir, 'bk'))
    expect(await m.db.selectFrom('Deck').selectAll().execute()).toHaveLength(0)
    const left = await m.db.selectFrom('Match').select('my_deckId').execute()
    expect(left).toHaveLength(3)
    expect(left.every((r) => r.my_deckId === null)).toBe(true)
  })

  it('tags and categories: matches and decks stay; the built-in categories are never touched', async () => {
    const m = await machine('a')
    await populate(m)
    await clearData(m.db, { ...NONE, tags: true, categories: true }, path.join(m.dir, 'bk'))
    expect(await m.db.selectFrom('Tag').selectAll().execute()).toHaveLength(0)
    expect(await m.db.selectFrom('MatchTag').selectAll().execute()).toHaveLength(0)
    expect(await m.db.selectFrom('Match').selectAll().execute()).toHaveLength(3)
    const decks = await m.db.selectFrom('Deck').select('categoryId').execute()
    expect(decks).toEqual([{ categoryId: null }])
    const cats = await m.db.selectFrom('DeckCategory').select('id').orderBy('id').execute()
    expect(cats.map((c) => c.id)).toEqual(['aggro', 'control', 'midrange'])
  })

  it('everything at once leaves an app that looks freshly installed', async () => {
    const m = await machine('a')
    await populate(m)
    const result = await clearData(m.db, ALL, path.join(m.dir, 'bk'))
    expect(result.deleted).toEqual({ matches: 3, decks: 1, tags: 1, categories: 1 })
    expect(await countClearable(m.db)).toEqual({ matches: 0, decks: 0, tags: 0, categories: 0 })
  })

  it('reports what it removed, not what it was asked to', async () => {
    const m = await machine('a')
    await addMatch(m)
    const result = await clearData(m.db, ALL, path.join(m.dir, 'bk'))
    expect(result.deleted).toEqual({ matches: 1, decks: 0, tags: 0, categories: 0 })
  })
})

describe('the safety copy', () => {
  it('is taken first and holds what was there before the clear', async () => {
    const m = await machine('a')
    await populate(m)
    const { backup } = await clearData(m.db, ALL, path.join(m.dir, 'bk'))
    expect(path.basename(backup)).toMatch(/^app-\d+-before-clear\.db$/)
    const copy = new SQLite(backup, { readonly: true })
    expect(copy.prepare('SELECT COUNT(*) AS n FROM Match').get()).toEqual({ n: 3 })
    expect(copy.prepare('SELECT COUNT(*) AS n FROM Tag').get()).toEqual({ n: 1 })
    copy.close()
  })

  it('no copy, no clear: if the backup cannot be made nothing is deleted', async () => {
    const m = await machine('a')
    await populate(m)
    // A FILE where the backup directory should be, so creating the copy fails.
    const blocker = path.join(m.dir, 'blocker')
    await fs.writeFile(blocker, 'x')
    await expect(clearData(m.db, ALL, path.join(blocker, 'bk'))).rejects.toThrow()
    expect(await countClearable(m.db)).toEqual({ matches: 3, decks: 1, tags: 1, categories: 1 })
  })
})

describe('with cross-device sync on', () => {
  it('the deletions reach the other device, and nothing else does', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    await populate(a)
    await a.enable()
    await a.sync(cloud)
    await b.sync(cloud)
    expect((await countClearable(b.db)).matches).toBe(3)

    const result = await clearData(a.db, { ...NONE, matches: true }, path.join(a.dir, 'bk'))
    expect(result.syncs).toBe(true)
    expect(await outboxSize(a)).toBeGreaterThanOrEqual(3) // a tombstone per match

    await a.sync(cloud)
    await b.sync(cloud)
    expect((await countClearable(b.db)).matches).toBe(0)
    // What was not cleared is still there, and still the same on both.
    expect((await countClearable(b.db)).decks).toBe(1)
    expect(await dump(b)).toEqual(await dump(a))
  })

  it('says so when sync is off', async () => {
    const m = await machine('a')
    await addMatch(m)
    expect((await clearData(m.db, ALL, path.join(m.dir, 'bk'))).syncs).toBe(false)
  })

  it('does not queue demo data - it never went up, so there is nothing to take down', async () => {
    const m = await machine('a')
    await addMatch(m, { source: 'demo-seed' })
    await m.db.deleteFrom('SyncOutbox').execute()
    await clearData(m.db, ALL, path.join(m.dir, 'bk'))
    expect(await outboxSize(m)).toBe(0)
  })
})

describe('the handler', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createMigratedTestDb()
    registerDataClearIpc({ backupDir: () => path.join(db.dir, 'bk') })
  })
  afterAll(async () => {
    await removeTestDb(db)
  })

  const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    Promise.resolve(electronMock.handlers.get(channel)!({}, ...args)) as Promise<T>

  it('refuses a request that selects nothing, and does not trust the shape it is sent', async () => {
    await expect(call('data:clear', {})).rejects.toThrow('NOTHING_SELECTED')
    await expect(call('data:clear', null)).rejects.toThrow('NOTHING_SELECTED')
    await expect(call('data:clear', { matches: 'yes' })).rejects.toThrow('NOTHING_SELECTED')
  })

  it('answers the counts and performs a clear', async () => {
    await testDb()
      .insertInto('Match')
      .values({
        play_order: 'first',
        my_class: 'elf',
        oppo_class: 'elf',
        playedAt: 1,
        uid: 'u1'
      } as never)
      .execute()
    expect(await call('data:clearCounts')).toMatchObject({ matches: 1 })
    const result = await call<{ deleted: { matches: number } }>('data:clear', { matches: true })
    expect(result.deleted.matches).toBe(1)
    expect(await call('data:clearCounts')).toMatchObject({ matches: 0 })
  })
})
