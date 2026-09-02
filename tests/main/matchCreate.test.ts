/**
 * `matches:create` - the hand-entered match.
 *
 * The write path is what these cases are about, not the form. A manual entry is
 * the one row nothing recognised, so everything a real match gets from the
 * engine has to be established here instead: the NOT NULL columns, the derived
 * y/m/d, and the `source` that keeps hand-typed rows out of the recognition
 * accuracy figures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerMatchesIpc } from '../../src/main/ipc/matches'
import { registerTagsIpc } from '../../src/main/ipc/tags'
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

let db: TestDb | undefined

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.handlers.get(channel)
  expect(handler, `Missing IPC handler: ${channel}`).toBeTypeOf('function')
  return (await handler!({}, ...args)) as T
}

const base = {
  result: true,
  play_order: 'first',
  my_class: 'witch',
  oppo_class: 'dragon',
  mode: 'ranked'
}

describe('matches:create', () => {
  beforeEach(async () => {
    electronMock.handlers.clear()
    db = await createMigratedTestDb()
    registerTagsIpc()
    registerMatchesIpc()
  })

  afterEach(async () => {
    await removeTestDb(db)
    db = undefined
  })

  it('stores the row and marks it as hand-entered', async () => {
    const created = await invoke<any>('matches:create', {
      ...base,
      playedAt: '2026-03-04T21:30:00',
      bp: 12,
      current_cr: 1200,
      delta_cr: -9,
      note: '手動補的'
    })

    expect(created).toMatchObject({
      result: true,
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'dragon',
      mode: 'ranked',
      bp: 12,
      current_cr: 1200,
      delta_cr: -9,
      note: '手動補的',
      source: 'manual'
    })

    // Nothing was observed, so nothing may be reported as observed - a snapshot
    // here would tell `provenanceStats` the engine had seen these values.
    expect(created.observed).toBeNull()
    expect(created.edited_fields).toBeNull()
  })

  it('derives year / month / day from the given time, not from today', async () => {
    const created = await invoke<any>('matches:create', {
      ...base,
      playedAt: new Date(2024, 10, 7, 9, 15).toISOString()
    })

    const row = await testDb()
      .selectFrom('Match')
      .select(['year', 'month', 'day', 'playedAt'])
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()

    expect(row).toMatchObject({ year: 2024, month: 11, day: 7 })
    expect(row.playedAt).toBe(new Date(2024, 10, 7, 9, 15).getTime())
  })

  it('falls back to now when no time is given', async () => {
    const before = Date.now()
    const created = await invoke<any>('matches:create', base)
    expect(new Date(created.playedAt).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('links the tags it is handed, ignoring duplicates', async () => {
    const tag = await invoke<any>('tags:create', 'ladder')
    const created = await invoke<any>('matches:create', {
      ...base,
      tagIds: [tag.id, tag.id]
    })

    expect(created.tags).toHaveLength(1)
    expect(created.tags[0].tag.name).toBe('ladder')
  })

  it('refuses a row with no classes', async () => {
    await expect(invoke('matches:create', { ...base, my_class: undefined })).rejects.toThrow(
      /MISSING_CLASS/
    )
    await expect(invoke('matches:create', { ...base, oppo_class: 'wizard' })).rejects.toThrow(
      /MISSING_CLASS/
    )
  })

  it('refuses a row with no play order', async () => {
    // The column is NOT NULL and every reader treats an unknown order as 後攻,
    // so an empty one would silently become a claim rather than a gap.
    await expect(invoke('matches:create', { ...base, play_order: null })).rejects.toThrow(
      /MISSING_PLAY_ORDER/
    )
    await expect(invoke('matches:create', { ...base, play_order: 'either' })).rejects.toThrow(
      /MISSING_PLAY_ORDER/
    )
  })

  it('drops the decks on a mode that has none', async () => {
    const created = await invoke<any>('matches:create', {
      ...base,
      mode: 'twoPick',
      my_deckId: 1,
      oppo_deckId: 2
    })

    expect(created.my_deckId).toBeNull()
    expect(created.oppo_deckId).toBeNull()
  })

  it('keeps a CR edit, which the update payload used to drop', async () => {
    const created = await invoke<any>('matches:create', { ...base, current_cr: 1000, delta_cr: 10 })

    const updated = await invoke<any>('matches:updateWithExtras', {
      id: created.id,
      prevUpdatedAt: new Date(created.updatedAt).toISOString(),
      current_cr: 1400,
      delta_cr: -20
    })

    expect(updated).toMatchObject({ current_cr: 1400, delta_cr: -20 })
    expect(JSON.parse(updated.edited_fields)).toEqual(
      expect.arrayContaining(['current_cr', 'delta_cr'])
    )
  })
})
