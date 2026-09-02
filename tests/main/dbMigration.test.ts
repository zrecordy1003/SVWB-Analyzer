import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMigratedTestDb,
  migrateWithEngine,
  removeTestDb,
  testDb,
  type TestDb
} from '../helpers/db'

let db: TestDb | undefined

describe('database migrations (owned by svwb-engine)', () => {
  afterEach(async () => {
    await removeTestDb(db)
    db = undefined
  })

  it('applies all bundled migrations idempotently to a fresh SQLite database', async () => {
    db = await createMigratedTestDb()

    const versions = await sql<{ version: number }>`
      SELECT version FROM schema_migrations ORDER BY version
    `.execute(testDb())
    expect(versions.rows.map((row) => Number(row.version))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12
    ])

    // Second run must be a no-op, not a re-application.
    migrateWithEngine(db.dbPath, db.migrationsDir)

    const after = await sql<{ version: number }>`
      SELECT version FROM schema_migrations ORDER BY version
    `.execute(testDb())
    expect(after.rows.map((row) => Number(row.version))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12
    ])

    const columns = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('Match') ORDER BY name
    `.execute(testDb())
    expect(columns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'mp',
        'delta_mp',
        // Provenance (008). Split by owner: the engine writes the first four,
        // the UI writes `observed` and `edited_fields`.
        'source',
        'mode_confidence',
        'engine_version',
        'recog_flags',
        'observed',
        'edited_fields'
      ])
    )
  })

  it('creates the runtime indexes used by match list and deck statistics queries', async () => {
    db = await createMigratedTestDb()

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
    `.execute(testDb())
    expect(indexes.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_match_mydeck_playedAt',
        'idx_match_result_mydeck_playedAt',
        'idx_match_currentcr_playedAt',
        'idx_match_mode_playedAt',
        'idx_match_playedAt_id',
        'idx_match_myclass_playedAt_id',
        'idx_match_oppoclass_playedAt_id',
        'idx_match_ymd_id'
      ])
    )
  })
})
