import { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedTestDb, removeTestDb, type TestDb } from '../helpers/db'

let testDb: TestDb | undefined
let prisma: PrismaClient | undefined

async function seedMatches(): Promise<{ deckId: number }> {
  const deck = await prisma!.deck.create({ data: { name: 'Query Plan Deck', class: 'elf' } })
  await prisma!.match.createMany({
    data: Array.from({ length: 12 }, (_, index) => {
      const playedAt = new Date(`2026-05-${String(index + 1).padStart(2, '0')}T12:00:00Z`)
      return {
        result: index % 2 === 0,
        play_order: index % 2 === 0 ? 'first' : 'second',
        my_class: 'elf',
        oppo_class: 'royal',
        mode: index % 3 === 0 ? 'ranked' : 'twoPick',
        my_deckId: deck.id,
        current_cr: 1200 + index,
        year: playedAt.getUTCFullYear(),
        month: playedAt.getUTCMonth() + 1,
        day: playedAt.getUTCDate(),
        playedAt
      } as const
    })
  })
  return { deckId: deck.id }
}

async function explain(sql: string, ...params: unknown[]): Promise<string> {
  const rows = await prisma!.$queryRawUnsafe<{ detail: string }[]>(sql, ...params)
  return rows.map((row) => row.detail).join('\n')
}

describe('SQLite query plans', () => {
  beforeEach(async () => {
    testDb = await createMigratedTestDb()
    prisma = new PrismaClient({ datasources: { db: { url: testDb.dbUrl } } })
  })

  afterEach(async () => {
    await prisma?.$disconnect()
    prisma = undefined
    await removeTestDb(testDb)
    testDb = undefined
  })

  it('uses the deck/date index for deck-scoped match queries', async () => {
    const { deckId } = await seedMatches()

    const detail = await explain(
      'EXPLAIN QUERY PLAN SELECT id FROM "Match" WHERE "my_deckId" = ? AND "playedAt" >= ? ORDER BY "playedAt" DESC',
      deckId,
      new Date('2026-05-01T00:00:00Z')
    )

    expect(detail).toContain('idx_match_mydeck_playedAt')
  })

  it('uses the mode/date index for mode-filtered match queries', async () => {
    await seedMatches()

    const detail = await explain(
      'EXPLAIN QUERY PLAN SELECT id FROM "Match" WHERE "mode" = ? AND "playedAt" >= ? ORDER BY "playedAt" DESC',
      'ranked',
      new Date('2026-05-01T00:00:00Z')
    )

    expect(detail).toContain('idx_match_mode_playedAt')
  })
})
