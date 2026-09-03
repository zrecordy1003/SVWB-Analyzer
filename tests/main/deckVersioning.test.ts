/**
 * Deck versioning, stage 1 (docs/deck-versioning-plan.md).
 *
 * Three rules, all data-layer: a deck's card list FREEZES once a match
 * references it; editing a frozen deck FORKS a new version row linked by
 * familyId; "deleting" a family archives the versions that have matches and
 * hard-deletes the ones that do not. The compatibility promise under test is
 * that none of this changes what the user sees today: `decks:all` lists one
 * row per family, and `decks:stats` grouped by family returns the same
 * numbers the old per-deckId grouping did.
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

const expectErr = <T>(res: Res<T>): string => {
  if (res.ok) throw new Error('expected an error, got ok')
  return res.error
}

// witch is portal class id 3 (see CLASS_ID_TO_NAME).
const WITCH = 3

const CARDS_V1 = [
  { cardId: 900001, count: 3 },
  { cardId: 900002, count: 3 }
]
// One card swapped - a different fingerprint.
const CARDS_V2 = [
  { cardId: 900001, count: 3 },
  { cardId: 900003, count: 3 }
]

type SavedDeck = {
  id: number
  name: string
  class: string
  isDefault: boolean
  familyId: number | null
  archivedAt: Date | string | null
  sourceKind: string | null
  sourceRef: string | null
}

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

async function playMatch(deckId: number, result = true): Promise<number> {
  return insertMatch({
    result,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    my_deckId: deckId,
    playedAt: new Date()
  })
}

async function deckRows(): Promise<
  {
    id: number
    name: string
    familyId: number | null
    archivedAt: number | null
    isDefault: number
  }[]
> {
  return testDb()
    .selectFrom('Deck')
    .select(['id', 'name', 'familyId', 'archivedAt', 'isDefault'])
    .orderBy('id', 'asc')
    .execute()
}

async function cardIdsOf(deckId: number): Promise<number[]> {
  const rows = await testDb()
    .selectFrom('DeckCard')
    .select('cardId')
    .where('deckId', '=', deckId)
    .orderBy('cardId', 'asc')
    .execute()
  return rows.map((r) => r.cardId)
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

describe('rule 1: the freeze line is "has been played", not "has been created"', () => {
  it('edits an unplayed deck in place - no fork, no second row', async () => {
    const created = await saveLocal({})
    const edited = await saveLocal({ deckId: created.id, cards: CARDS_V2 })

    expect(edited.id).toBe(created.id)
    const rows = await deckRows()
    expect(rows).toHaveLength(1)
    expect(await cardIdsOf(created.id)).toEqual([900001, 900003])
  })

  it('forks a played deck: new row, inherited familyId, old card list untouched', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)

    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })

    expect(v2.id).not.toBe(v1.id)
    expect(v2.familyId).toBe(v1.id)

    const rows = await deckRows()
    expect(rows).toHaveLength(2)
    // The frozen version keeps exactly the cards its matches were played with.
    expect(await cardIdsOf(v1.id)).toEqual([900001, 900002])
    expect(await cardIdsOf(v2.id)).toEqual([900001, 900003])
  })

  it('freezes on an opponent-side reference too', async () => {
    const deck = await saveLocal({})
    await insertMatch({
      result: false,
      play_order: 'first',
      my_class: 'dragon',
      oppo_class: 'witch',
      mode: 'ranked',
      oppo_deckId: deck.id,
      playedAt: new Date()
    })

    const next = await saveLocal({ deckId: deck.id, cards: CARDS_V2 })
    expect(next.id).not.toBe(deck.id)
    expect(await cardIdsOf(deck.id)).toEqual([900001, 900002])
  })

  it('does not fork when the card list did not change (no-op save)', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)

    const saved = await saveLocal({ deckId: v1.id, cards: CARDS_V1, name: 'Renamed' })

    expect(saved.id).toBe(v1.id)
    expect(saved.name).toBe('Renamed')
    expect(await deckRows()).toHaveLength(1)
  })

  it('correction mode rewrites the frozen row instead of forking', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)

    const fixed = await saveLocal({ deckId: v1.id, cards: CARDS_V2, forceInPlace: true })

    expect(fixed.id).toBe(v1.id)
    expect(await deckRows()).toHaveLength(1)
    expect(await cardIdsOf(v1.id)).toEqual([900001, 900003])
  })
})

describe('rule 2: what a fork carries and what it must not', () => {
  /**
   * Every path a save can take must leave `isDefault` alone.
   *
   * The editor never sends the flag - it has no "設為預設" control - and the
   * writer used to turn that silence into a hard 0, so opening your default
   * deck and pressing save quietly stopped it being the default. The three
   * cases below are the three branches of `upsertDeckWithCards`; only the
   * fork one was ever covered.
   */
  it.each([
    ['in place (unplayed deck)', { cards: CARDS_V2 }],
    ['as a no-op (same card list)', { cards: CARDS_V1 }],
    ['as a correction', { cards: CARDS_V2, forceInPlace: true }]
  ])('keeps isDefault when the editor saves %s', async (_label, patch) => {
    const deck = await saveLocal({ isDefault: true })

    await saveLocal({ deckId: deck.id, ...patch })

    const rows = await deckRows()
    expect(rows.filter((r) => r.isDefault === 1)).toHaveLength(1)
  })

  it('keeps isDefault when a played deck is saved with an unchanged list', async () => {
    const deck = await saveLocal({ isDefault: true })
    await playMatch(deck.id)

    await saveLocal({ deckId: deck.id, cards: CARDS_V1 })

    const rows = await deckRows()
    expect(rows.find((r) => r.id === deck.id)?.isDefault).toBe(1)
  })

  it('moves isDefault to the new version, where the engine query will find it', async () => {
    const v1 = await saveLocal({ isDefault: true })
    await playMatch(v1.id)

    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })

    const rows = await deckRows()
    expect(rows.find((r) => r.id === v1.id)?.isDefault).toBe(0)
    expect(rows.find((r) => r.id === v2.id)?.isDefault).toBe(1)

    // Literally the engine's lookup (store.rs): it must land on the version
    // the user is actually playing now.
    const engineSees = await testDb()
      .selectFrom('Deck')
      .select('id')
      .where('class', '=', 'witch')
      .where('isDefault', '=', 1)
      .execute()
    expect(engineSees.map((r) => r.id)).toEqual([v2.id])
  })

  it('does not inherit provenance: the fork is a local edit, not the old import', async () => {
    // An imported deck, planted directly: rawJson and sourceRef describe ITS
    // card list, and must stay with it.
    const imported = await testDb()
      .insertInto('Deck')
      .values({
        name: 'Imported',
        class: 'witch',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isDefault: 0,
        sourceKind: 'hash',
        sourceRef: '1.7.abc',
        fingerprint: 'old-fingerprint',
        rawJson: '{"deck_card_num":{}}',
        importedAt: Date.now()
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow()
    await testDb()
      .updateTable('Deck')
      .set({ familyId: imported.id })
      .where('id', '=', imported.id)
      .execute()
    await testDb()
      .insertInto('DeckCard')
      .values(CARDS_V1.map((c) => ({ deckId: imported.id, ...c })))
      .execute()
    await playMatch(imported.id)

    const fork = await saveLocal({ deckId: imported.id, cards: CARDS_V2, name: 'Imported' })

    expect(fork.id).not.toBe(imported.id)
    const forkRow = await testDb()
      .selectFrom('Deck')
      .selectAll()
      .where('id', '=', fork.id)
      .executeTakeFirstOrThrow()
    expect(forkRow.sourceKind).toBe('local')
    expect(forkRow.sourceRef).toBeNull()
    expect(forkRow.rawJson).toBeNull()
    expect(forkRow.importedAt).toBeNull()

    const oldRow = await testDb()
      .selectFrom('Deck')
      .selectAll()
      .where('id', '=', imported.id)
      .executeTakeFirstOrThrow()
    expect(oldRow.rawJson).toBe('{"deck_card_num":{}}')
    expect(oldRow.sourceRef).toBe('1.7.abc')
  })

  it('allows the same name inside a family but still blocks it across families', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)
    // Fork under the SAME name - the whole point of "name belongs to the deck".
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
    expect(v2.name).toBe('Aggro')

    // A different family taking that name is still a duplicate.
    const clash = await invoke<Res<unknown>>('decks:saveLocal', {
      name: 'Aggro',
      classId: WITCH,
      cards: [{ cardId: 900009, count: 3 }]
    })
    expect(expectErr(clash)).toBe('DUPLICATE_NAME')
  })

  it('renames the whole family through decks:update', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })

    expectOk(await invoke<Res<unknown>>('decks:update', { id: v2.id, name: 'Tempo' }))

    const rows = await deckRows()
    expect(rows.map((r) => r.name)).toEqual(['Tempo', 'Tempo'])
    expect(rows.find((r) => r.id === v1.id)?.name).toBe('Tempo')
  })
})

describe('decks:all shows one row per family', () => {
  it('returns only the current version by default, all versions on request', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })

    const current = expectOk(await invoke<Res<{ id: number }[]>>('decks:all'))
    expect(current.map((d) => d.id)).toEqual([v2.id])

    const all = expectOk(await invoke<Res<{ id: number }[]>>('decks:all', { scope: 'all' }))
    expect(all.map((d) => d.id).sort()).toEqual([v1.id, v2.id].sort())
  })

  it('hides archived decks from the list but keeps them for decks:stats', async () => {
    const deck = await saveLocal({})
    await playMatch(deck.id, true)
    await playMatch(deck.id, false)

    expectOk(await invoke<Res<unknown>>('decks:delete', { id: deck.id }))

    const listed = expectOk(await invoke<Res<{ id: number }[]>>('decks:all'))
    expect(listed).toHaveLength(0)

    const stats = expectOk(
      await invoke<Res<{ deckId: number | null; total: number; wins: number }[]>>('decks:stats', {
        rangeKey: 'all'
      })
    )
    const row = stats.find((s) => s.deckId === deck.id)
    expect(row).toMatchObject({ total: 2, wins: 1 })
  })
})

describe('decks:stats - the compatibility promise', () => {
  it('groupBy family (the default) returns the same numbers after a fork as before it', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id, true)
    await playMatch(v1.id, true)
    await playMatch(v1.id, false)

    const before = expectOk(
      await invoke<Res<{ deckId: number | null; total: number; wins: number; winRate: number }[]>>(
        'decks:stats',
        { rangeKey: 'all' }
      )
    )
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({
      deckId: v1.id,
      familyId: v1.id,
      total: 3,
      wins: 2,
      winRate: 66.67
    })

    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })

    const after = expectOk(
      await invoke<Res<{ deckId: number | null; total: number; wins: number; winRate: number }[]>>(
        'decks:stats',
        { rangeKey: 'all' }
      )
    )
    // Same numbers, keyed to the row the list is now showing (the fork).
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      deckId: v2.id,
      familyId: v1.id,
      total: 3,
      wins: 2,
      winRate: 66.67
    })
  })

  it('splits the record into a first-turn half and a second-turn half', async () => {
    const deck = await saveLocal({})
    // 先攻兩勝一敗，後攻一勝。
    await playMatch(deck.id, true)
    await playMatch(deck.id, true)
    await playMatch(deck.id, false)
    await insertMatch({
      result: true,
      play_order: 'second',
      my_class: 'witch',
      oppo_class: 'dragon',
      mode: 'ranked',
      my_deckId: deck.id,
      playedAt: new Date()
    })

    const stats = expectOk(
      await invoke<
        Res<
          {
            deckId: number | null
            total: number
            first: { total: number; wins: number }
            second: { total: number; wins: number }
          }[]
        >
      >('decks:stats', { rangeKey: 'all' })
    )
    const row = stats.find((s) => s.deckId === deck.id)
    expect(row).toMatchObject({
      total: 4,
      first: { total: 3, wins: 2 },
      second: { total: 1, wins: 1 }
    })
  })

  it('groupBy deck separates the versions', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id, true)
    await playMatch(v1.id, false)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
    await playMatch(v2.id, true)

    const perDeck = expectOk(
      await invoke<Res<{ deckId: number | null; total: number; wins: number }[]>>('decks:stats', {
        rangeKey: 'all',
        groupBy: 'deck'
      })
    )
    expect(perDeck.find((s) => s.deckId === v1.id)).toMatchObject({ total: 2, wins: 1 })
    expect(perDeck.find((s) => s.deckId === v2.id)).toMatchObject({ total: 1, wins: 1 })

    const perFamily = expectOk(
      await invoke<Res<{ deckId: number | null; total: number }[]>>('decks:stats', {
        rangeKey: 'all'
      })
    )
    expect(perFamily.find((s) => s.deckId === v2.id)).toMatchObject({ total: 3, wins: 2 })
  })

  it('reports each version’s first and last playedAt, and nothing for an unplayed one', async () => {
    const v1 = await saveLocal({})
    const early = new Date('2026-08-30T10:00:00Z')
    const late = new Date('2026-09-02T18:00:00Z')
    const played = (deckId: number, at: Date) =>
      insertMatch({
        result: true,
        play_order: 'first',
        my_class: 'witch',
        oppo_class: 'dragon',
        mode: 'ranked',
        my_deckId: deckId,
        playedAt: at
      })
    await played(v1.id, late)
    await played(v1.id, early)
    await played(v1.id, new Date('2026-09-01T00:00:00Z'))
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })

    type Row = {
      deckId: number | null
      total: number
      firstPlayedAt: number | null
      lastPlayedAt: number | null
    }
    const perDeck = expectOk(
      await invoke<Res<Row[]>>('decks:stats', { rangeKey: 'all', groupBy: 'deck' })
    )
    expect(perDeck.find((s) => s.deckId === v1.id)).toMatchObject({
      total: 3,
      firstPlayedAt: early.getTime(),
      lastPlayedAt: late.getTime()
    })
    // v2 has no games, so it has no row at all - the renderer treats a missing
    // row as "尚未打過"; there is nothing to fabricate here.
    expect(perDeck.find((s) => s.deckId === v2.id)).toBeUndefined()

    // The span follows the same filter as the counts: cut the range and the
    // earliest game moves with it.
    const ranged = expectOk(
      await invoke<Res<Row[]>>('decks:stats', {
        rangeKey: 'custom',
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-03T00:00:00Z',
        groupBy: 'deck'
      })
    )
    expect(ranged.find((s) => s.deckId === v1.id)).toMatchObject({
      total: 2,
      firstPlayedAt: Date.parse('2026-09-01T00:00:00Z'),
      lastPlayedAt: late.getTime()
    })

    // The family row spans every version's games.
    const perFamily = expectOk(await invoke<Res<Row[]>>('decks:stats', { rangeKey: 'all' }))
    expect(perFamily.find((s) => s.deckId === v2.id)).toMatchObject({
      firstPlayedAt: early.getTime(),
      lastPlayedAt: late.getTime()
    })
  })

  it('adds one catch-all row for matches with no deck', async () => {
    const deck = await saveLocal({})
    await playMatch(deck.id, true)
    await insertMatch({
      result: false,
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'elf',
      mode: 'ranked',
      my_deckId: null,
      playedAt: new Date()
    })

    const stats = expectOk(
      await invoke<Res<{ deckId: number | null; total: number }[]>>('decks:stats', {
        rangeKey: 'all'
      })
    )
    expect(stats.find((s) => s.deckId === null)).toMatchObject({ total: 1, wins: 0 })
  })
})

describe('rule 3: delete acts on the family, archiving what has matches', () => {
  it('hard-deletes an unplayed deck, card list and all', async () => {
    const deck = await saveLocal({})
    const res = expectOk(
      await invoke<Res<{ deleted: number; archived: number }>>('decks:delete', { id: deck.id })
    )
    expect(res).toMatchObject({ deleted: 1, archived: 0 })
    expect(await deckRows()).toHaveLength(0)
    expect(await testDb().selectFrom('DeckCard').selectAll().execute()).toHaveLength(0)
  })

  it('archives a played deck and leaves its stats intact', async () => {
    const deck = await saveLocal({})
    await playMatch(deck.id, true)

    const res = expectOk(
      await invoke<Res<{ deleted: number; archived: number }>>('decks:delete', { id: deck.id })
    )
    expect(res).toMatchObject({ deleted: 0, archived: 1 })

    const rows = await deckRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].archivedAt).not.toBeNull()
    // The match still points at its deck - nothing was SET NULL.
    const match = await testDb().selectFrom('Match').select('my_deckId').executeTakeFirstOrThrow()
    expect(match.my_deckId).toBe(deck.id)
  })

  it('sweeps a whole multi-version family so no old version resurfaces in the list', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 }) // unplayed fork

    const res = expectOk(
      await invoke<Res<{ deleted: number; archived: number }>>('decks:delete', { id: v2.id })
    )
    expect(res).toMatchObject({ deleted: 1, archived: 1 })

    const rows = await deckRows()
    expect(rows.map((r) => r.id)).toEqual([v1.id])
    expect(rows[0].archivedAt).not.toBeNull()

    // The list must not fall back to showing the archived v1.
    const listed = expectOk(await invoke<Res<{ id: number }[]>>('decks:all'))
    expect(listed).toHaveLength(0)
  })

  it('clears isDefault when archiving, so the engine cannot assign new games to a deleted deck', async () => {
    const deck = await saveLocal({ isDefault: true })
    await playMatch(deck.id)

    expectOk(await invoke<Res<unknown>>('decks:delete', { id: deck.id }))

    const engineSees = await testDb()
      .selectFrom('Deck')
      .select('id')
      .where('class', '=', 'witch')
      .where('isDefault', '=', 1)
      .execute()
    expect(engineSees).toHaveLength(0)
  })

  it('reports how many matches a delete would touch, for the confirmation dialog', async () => {
    const v1 = await saveLocal({})
    await playMatch(v1.id)
    await playMatch(v1.id)
    const v2 = await saveLocal({ deckId: v1.id, cards: CARDS_V2 })
    await playMatch(v2.id)

    const impact = expectOk(
      await invoke<Res<{ matches: number; versions: number }>>('decks:deleteImpact', { id: v2.id })
    )
    expect(impact).toEqual({ matches: 3, versions: 2 })
  })
})

describe('familyId bookkeeping', () => {
  it('backfills familyId = id for decks:create, in the same transaction', async () => {
    const created = expectOk(
      await invoke<Res<{ id: number }>>('decks:create', { name: 'ByHand', class: 'witch' })
    )
    const row = await testDb()
      .selectFrom('Deck')
      .select(['id', 'familyId'])
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()
    expect(row.familyId).toBe(row.id)
  })

  it('backfills familyId = id for decks:saveLocal creates', async () => {
    const created = await saveLocal({})
    const row = await testDb()
      .selectFrom('Deck')
      .select(['id', 'familyId'])
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()
    expect(row.familyId).toBe(row.id)
  })
})
