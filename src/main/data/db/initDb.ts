/**
 * Brings the database up to the shipped schema before anything reads it.
 *
 * The migration logic itself lives in `svwb-engine migrate` - one owner, handed
 * over in one change (docs/engine-refactor-plan.md, 判斷題 D-5). This module
 * kept its name and its single entry point so `index.ts` did not have to care;
 * what it now does is resolve the paths and run the engine synchronously, then
 * hand the database path to the UI's data layer.
 *
 * Synchronous on purpose: nothing may query a database that is still mid-schema,
 * and "wait for the migration" is exactly what app startup is for.
 */
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { ENGINE_BINARY } from '../../../shared/engineBinary.js'
import { configureDbPath } from './client.js'
import { RemoteSqliteDialect } from './remoteDriver.js'
import { createWorkerTransport } from './workerTransport.js'

function getDbPath(): string {
  const dir = path.join(app.getPath('userData'), 'db')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return path.join(dir, 'app.db')
}

function getEnginePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', ENGINE_BINARY)
    : path.join(__dirname, '../../tools/target/release', ENGINE_BINARY)
}

function getMigrationsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'migrations')
    : path.join(__dirname, '../../resources/migrations')
}

export async function initDatabase(): Promise<void> {
  const dbPath = getDbPath()

  // Failing loudly here beats a UI quietly querying half a schema. The engine
  // prints {"applied":N} on success and a reason on stderr otherwise.
  const out = execFileSync(
    getEnginePath(),
    ['migrate', '--db', dbPath, '--migrations', getMigrationsDir()],
    { encoding: 'utf8', windowsHide: true }
  )
  console.log('[DB] migrations:', out.trim())

  /**
   * The queries run in `src/dbworker`, not here.
   *
   * `better-sqlite3` is synchronous, so every UI query used to execute on the
   * same event loop as the 16ms focus ticker, the 1s game poll and the
   * engine's event stream - see `src/dbworker/index.ts` for the whole
   * argument. The data layer still opens lazily on first use; what changed is
   * where the file is opened.
   */
  configureDbPath(dbPath, new RemoteSqliteDialect(createWorkerTransport(), dbPath))
}
