/**
 * A migrated scratch database for tests, brought up the way the app brings one
 * up: by `svwb-engine migrate`, the single owner of migrations. If the engine
 * binary is missing the failure says how to build it, because a test suite that
 * silently skipped the migration owner would be testing a different app.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { ENGINE_BINARY } from '../../src/shared/engineBinary'
import { configureDbPath, getDb, resetDbForTests } from '../../src/main/data/db/client'
import type { Database } from '../../src/main/data/db/client'
import type { Kysely } from 'kysely'

export type TestDb = {
  dir: string
  dbPath: string
  migrationsDir: string
}

const ROOT = process.cwd()
const ENGINE = path.join(ROOT, 'tools', 'target', 'release', ENGINE_BINARY)

export function migrateWithEngine(dbPath: string, migrationsDir: string): void {
  // The header promises this failure says how to fix itself. Without the check
  // it is a bare spawnSync ENOENT, which is what a CI run with no Rust build
  // step actually produced.
  if (!existsSync(ENGINE)) {
    throw new Error(
      [
        `svwb-engine is not built at ${ENGINE}`,
        'Run: pnpm engine:build',
        '  (cargo build --manifest-path tools/Cargo.toml -p svwb-engine --release)'
      ].join('\n')
    )
  }
  execFileSync(ENGINE, ['migrate', '--db', dbPath, '--migrations', migrationsDir], {
    encoding: 'utf8',
    windowsHide: true
  })
}

export async function createMigratedTestDb(): Promise<TestDb> {
  await resetDbForTests()

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-db-'))
  const dbPath = path.join(dir, 'app.db')
  const migrationsDir = path.join(ROOT, 'resources', 'migrations')

  migrateWithEngine(dbPath, migrationsDir)
  configureDbPath(dbPath)

  return { dir, dbPath, migrationsDir }
}

export async function removeTestDb(db?: Pick<TestDb, 'dir'>): Promise<void> {
  await resetDbForTests()
  if (db?.dir) await fs.rm(db.dir, { recursive: true, force: true })
}

export function testDb(): Kysely<Database> {
  return getDb()
}

/** Seed one match the way the engine writes one: epoch-ms dates, 0/1 result. */
export async function insertMatch(values: {
  result?: boolean | null
  play_order: string
  my_class: string
  oppo_class: string
  mode?: string | null
  my_deckId?: number | null
  current_cr?: number | null
  playedAt: Date
  endedAt?: Date | null
}): Promise<number> {
  const row = await getDb()
    .insertInto('Match')
    .values({
      result: values.result == null ? null : values.result ? 1 : 0,
      play_order: values.play_order,
      my_class: values.my_class,
      oppo_class: values.oppo_class,
      mode: values.mode ?? null,
      my_deckId: values.my_deckId ?? null,
      current_cr: values.current_cr ?? null,
      year: values.playedAt.getUTCFullYear(),
      month: values.playedAt.getUTCMonth() + 1,
      day: values.playedAt.getUTCDate(),
      playedAt: values.playedAt.getTime(),
      endedAt: values.endedAt ? values.endedAt.getTime() : null,
      updatedAt: Date.now()
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
