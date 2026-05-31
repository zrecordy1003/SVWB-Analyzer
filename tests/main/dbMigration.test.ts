import { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'
import { initDatabaseAt } from '../../src/main/db/initDb'
import { createMigratedTestDb, removeTestDb, type TestDb } from '../helpers/db'

let testDb: TestDb | undefined

async function prismaFor(dbUrl: string): Promise<PrismaClient> {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;')
  return prisma
}

describe('database migrations', () => {
  afterEach(async () => {
    await removeTestDb(testDb)
    testDb = undefined
  })

  it('applies all bundled migrations idempotently to a fresh SQLite database', async () => {
    testDb = await createMigratedTestDb()
    const prisma = await prismaFor(testDb.dbUrl)

    try {
      const versions = await prisma.$queryRawUnsafe<{ version: number }[]>(
        'SELECT version FROM schema_migrations ORDER BY version'
      )
      expect(versions.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5])

      await initDatabaseAt({
        dbPath: testDb.dbPath,
        migrationsDir: testDb.migrationsDir,
        backup: false
      })

      const versionsAfterSecondRun = await prisma.$queryRawUnsafe<{ version: number }[]>(
        'SELECT version FROM schema_migrations ORDER BY version'
      )
      expect(versionsAfterSecondRun.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5])
    } finally {
      await prisma.$disconnect()
    }
  })

  it('creates the runtime indexes used by match list and deck statistics queries', async () => {
    testDb = await createMigratedTestDb()
    const prisma = await prismaFor(testDb.dbUrl)

    try {
      const indexes = await prisma.$queryRawUnsafe<{ name: string }[]>(
        'SELECT name FROM sqlite_master WHERE type = "index" ORDER BY name'
      )
      expect(indexes.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'idx_match_mydeck_playedAt',
          'idx_match_result_mydeck_playedAt',
          'idx_match_currentcr_playedAt',
          'idx_match_mode_playedAt',
          'idx_match_playedAt_id',
          'idx_match_ymd_id'
        ])
      )
    } finally {
      await prisma.$disconnect()
    }
  })
})
