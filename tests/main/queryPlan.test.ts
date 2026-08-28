import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedTestDb, insertMatch, removeTestDb, testDb, type TestDb } from '../helpers/db'

let db: TestDb | undefined

async function seedMatches(): Promise<{ deckId: number }> {
  const deck = await testDb()
    .insertInto('Deck')
    .values({ name: 'Query Plan Deck', class: 'elf', isDefault: 0, createdAt: Date.now() })
    .returning('id')
    .executeTakeFirstOrThrow()

  for (let index = 0; index < 12; index++) {
    await insertMatch({
      result: index % 2 === 0,
      play_order: index % 2 === 0 ? 'first' : 'second',
      my_class: 'elf',
      oppo_class: 'royal',
      mode: index % 3 === 0 ? 'ranked' : 'twoPick',
      my_deckId: deck.id,
      current_cr: 1200 + index,
      playedAt: new Date(`2026-05-${String(index + 1).padStart(2, '0')}T12:00:00Z`)
    })
  }
  return { deckId: deck.id }
}

async function explain(query: string, ...params: unknown[]): Promise<string> {
  const quote = (v: unknown): string =>
    typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
  const compiled = sql.raw(query.replace(/\?/g, () => quote(params.shift())))
  const rows = await compiled.execute(testDb())
  return (rows.rows as { detail: string }[]).map((row) => row.detail).join('\n')
}

describe('SQLite query plans', () => {
  beforeEach(async () => {
    db = await createMigratedTestDb()
  })

  afterEach(async () => {
    await removeTestDb(db)
    db = undefined
  })

  it('uses the deck/date index for deck-scoped match queries', async () => {
    const { deckId } = await seedMatches()

    const detail = await explain(
      'EXPLAIN QUERY PLAN SELECT id FROM "Match" WHERE "my_deckId" = ? AND "playedAt" >= ? ORDER BY "playedAt" DESC',
      deckId,
      new Date('2026-05-01T00:00:00Z').getTime()
    )

    expect(detail).toContain('idx_match_mydeck_playedAt')
  })

  it('uses the mode/date index for mode-filtered match queries', async () => {
    await seedMatches()

    const detail = await explain(
      'EXPLAIN QUERY PLAN SELECT id FROM "Match" WHERE "mode" = ? AND "playedAt" >= ? ORDER BY "playedAt" DESC',
      'ranked',
      new Date('2026-05-01T00:00:00Z').getTime()
    )

    expect(detail).toContain('idx_match_mode_playedAt')
  })
})
