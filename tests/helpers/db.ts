import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { initDatabaseAt } from '../../src/main/db/initDb'
import { resetPrismaForTests } from '../../src/main/db/prismaClient'

export type TestDb = {
  dir: string
  dbPath: string
  dbUrl: string
  migrationsDir: string
}

export async function createMigratedTestDb(): Promise<TestDb> {
  await resetPrismaForTests()

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-db-'))
  const dbPath = path.join(dir, 'app.db')
  const migrationsDir = path.join(process.cwd(), 'resources', 'migrations')

  await initDatabaseAt({ dbPath, migrationsDir, backup: false })

  return {
    dir,
    dbPath,
    dbUrl: process.env.DATABASE_URL!,
    migrationsDir
  }
}

export async function removeTestDb(db?: Pick<TestDb, 'dir'>): Promise<void> {
  await resetPrismaForTests()
  if (db?.dir) await fs.rm(db.dir, { recursive: true, force: true })
}
