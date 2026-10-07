/**
 * Every row that can be synced has a name that is the same on every machine.
 *
 * `uid` (migration 018) has no column default and is not NOT NULL, on purpose:
 * a refusal would turn a forgotten writer into a lost match. The price is that
 * nothing in the database notices a writer that forgets it - so this does. Each
 * test goes through the real handler, because the bug it guards against is "a
 * new code path that inserts and does not know about uid", and a direct INSERT
 * in a test would only prove that SQLite accepts one.
 *
 * The Rust engine's INSERT is covered by `every_match_gets_a_uid` in
 * `tools/engine/src/store.rs`; the backfill of existing rows by
 * `dbUpgrade.test.ts`, which migrates a database that already has history.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'

import { registerDecksIpc } from '../../src/main/ipc/decks'
import { registerMatchesIpc } from '../../src/main/ipc/matches'
import { registerTagsIpc } from '../../src/main/ipc/tags'
import { newUid } from '../../src/main/data/db/client'
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

const UID = /^[0-9a-f]{32}$/
const WITCH = 3

let db: TestDb

beforeAll(async () => {
  db = await createMigratedTestDb()
  registerDecksIpc()
  registerMatchesIpc()
  registerTagsIpc()
})

afterAll(async () => {
  await removeTestDb(db)
})

async function uidOf(table: 'Match' | 'Deck' | 'Tag', id: number): Promise<string | null> {
  const row = await testDb()
    .selectFrom(table)
    .select('uid')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return row.uid
}

describe('newUid', () => {
  it('is 16 random bytes as lowercase hex, and does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, newUid))
    expect(seen.size).toBe(500)
    for (const uid of seen) expect(uid).toMatch(UID)
  })
})

describe('every writer fills uid', () => {
  it('a manually entered match', async () => {
    const created = await invoke<{ id: number }>('matches:create', {
      my_class: 'witch',
      oppo_class: 'bishop',
      play_order: 'first'
    })
    expect(await uidOf('Match', created.id)).toMatch(UID)
  })

  it('a tag made by name on its own', async () => {
    const tag = await invoke<{ id: number }>('tags:create', 'uid-solo')
    expect(await uidOf('Tag', tag.id)).toMatch(UID)
  })

  it('a tag made as a side effect of tagging a match', async () => {
    const matchId = await insertMatch({
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'bishop',
      playedAt: new Date()
    })
    await invoke('matches:setTags', matchId, ['uid-via-match'])
    const tag = await testDb()
      .selectFrom('Tag')
      .select(['id', 'uid'])
      .where('name', '=', 'uid-via-match')
      .executeTakeFirstOrThrow()
    expect(tag.uid).toMatch(UID)
  })

  it('a deck from the new-deck dialog', async () => {
    const deck = expectOk(
      await invoke<Res<{ id: number }>>('decks:create', { name: 'uid-dialog', class: 'witch' })
    )
    expect(await uidOf('Deck', deck.id)).toMatch(UID)
  })

  it('a deck saved with a card list', async () => {
    const deck = expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        name: 'uid-saved',
        classId: WITCH,
        cards: [{ cardId: 910001, count: 3 }]
      })
    )
    expect(await uidOf('Deck', deck.id)).toMatch(UID)
  })

  it('a FORK of a played deck - a new row, so a new identity', async () => {
    const v1 = expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        name: 'uid-fork',
        classId: WITCH,
        cards: [{ cardId: 910002, count: 3 }]
      })
    )
    await insertMatch({
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'bishop',
      my_deckId: v1.id,
      playedAt: new Date()
    })
    const v2 = expectOk(
      await invoke<Res<{ id: number }>>('decks:saveLocal', {
        deckId: v1.id,
        name: 'uid-fork',
        classId: WITCH,
        cards: [{ cardId: 910003, count: 3 }]
      })
    )
    expect(v2.id).not.toBe(v1.id)
    const [a, b] = [await uidOf('Deck', v1.id), await uidOf('Deck', v2.id)]
    expect(a).toMatch(UID)
    expect(b).toMatch(UID)
    expect(a).not.toBe(b)
  })
})

describe('the database as a whole', () => {
  it('has no row without a uid, and no two rows with the same one', async () => {
    for (const table of ['Match', 'Deck', 'Tag'] as const) {
      const { rows } = await sql<{ nulls: number; total: number; uniq: number }>`
        SELECT SUM(uid IS NULL) AS nulls, COUNT(*) AS total, COUNT(DISTINCT uid) AS uniq
        FROM ${sql.table(table)}
      `.execute(testDb())
      const row = rows[0]
      expect(Number(row.nulls), `${table} rows without a uid`).toBe(0)
      expect(Number(row.uniq)).toBe(Number(row.total))
    }
  })
})
