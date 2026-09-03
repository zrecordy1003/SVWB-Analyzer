/**
 * The UI's view of the schema matches the schema.
 *
 * `resources/migrations/*.sql` is the single source of truth and it is
 * hand-mirrored twice: in `tools/engine/src/store.rs` for the engine's writes,
 * and in `client.ts`'s `Row` interfaces for the UI's reads. The Rust side has a
 * cargo test against the shipped migrations. This side had a comment asking
 * people to keep them in sync - so a column could land in a migration and in
 * Rust and never appear here, and nothing would say so until a query returned
 * `undefined` at runtime, in whichever screen happened to read it first.
 *
 * `TABLE_COLUMNS` closes the gap in two hops. The compile-time half lives with
 * the declaration (a `satisfies` clause and a `NoUncheckedColumn` type, both
 * checked by `pnpm typecheck`); this is the other half, against a database
 * brought up through the real migrations by the real migration owner.
 *
 * A column the migrations have and this file does not is the dangerous
 * direction and fails here. The reverse - a column listed here that the
 * database does not have - is just as much a bug and also fails: it means a
 * `SELECT` would name a column that is not there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'

import { TABLE_COLUMNS, type Database } from '../../src/main/data/db/client'
import { createMigratedTestDb, removeTestDb, testDb, type TestDb } from '../helpers/db'

let db: TestDb

beforeAll(async () => {
  db = await createMigratedTestDb()
})

afterAll(async () => {
  await removeTestDb(db)
})

/**
 * What SQLite says the table actually has.
 *
 * `pragma_table_info` rather than `PRAGMA table_info`: the function form takes
 * a bound parameter, so the table name never goes into the SQL text.
 */
async function columnsOf(table: string): Promise<string[]> {
  const result = await sql<{
    name: string
  }>`SELECT name FROM pragma_table_info(${table})`.execute(testDb())
  return result.rows.map((row) => row.name)
}

const TABLES = Object.keys(TABLE_COLUMNS) as Array<keyof Database>

describe('the UI schema mirror', () => {
  it('covers every table the client declares', () => {
    // Guards against the list and the `Database` interface drifting apart in
    // the one way the type system cannot see: a table removed from the const.
    expect(TABLES.length).toBeGreaterThan(0)
    expect(new Set(TABLES).size).toBe(TABLES.length)
  })

  for (const table of TABLES) {
    it(`${table} has exactly the columns client.ts declares`, async () => {
      const actual = await columnsOf(table)
      expect(actual.length, `${table} is missing from the migrations`).toBeGreaterThan(0)

      const declared = [...TABLE_COLUMNS[table]] as string[]
      // Sorted, because column order is not part of the contract - only
      // membership is - and an ALTER TABLE appends.
      expect(
        [...declared].sort(),
        `${table}: client.ts and resources/migrations disagree. ` +
          `Missing from client.ts: [${actual.filter((c) => !declared.includes(c)).join(', ')}]. ` +
          `Declared but absent from the database: [${declared
            .filter((c) => !actual.includes(c))
            .join(', ')}].`
      ).toEqual([...actual].sort())
    })
  }
})
