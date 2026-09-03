/**
 * The out-of-process SQLite driver, against a real database.
 *
 * The transport is an in-memory stand-in rather than a `utilityProcess`: it
 * runs the same `better-sqlite3` calls the worker does, through the same
 * request/response shapes, with an async hop in between. That is what the
 * driver actually depends on - it cannot tell a `postMessage` from a
 * `setTimeout` - and it means these cases need no Electron and no spawn.
 *
 * What is deliberately NOT covered here is the process itself: that a
 * `utilityProcess` forks, finds its bundle, and survives a quit. There is no
 * way to assert that without launching the app, so the E2E suite is what
 * covers it - every one of its 24 cases now reads and writes through this
 * driver, and `deckVersioning.spec.ts` in particular drives transactions
 * through the real thing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely, type Generated } from 'kysely'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  RemoteSqliteDialect,
  type DbTransport,
  type DbWorkerRequest,
  type DbWorkerResponse
} from '../../src/main/data/db/remoteDriver'

// `Generated`, so a row can be inserted without naming its id - which is what
// exercises `insertId` coming back across the boundary.
type Schema = { widget: { id: Generated<number>; name: string } }

/**
 * The worker's logic, in this process.
 *
 * Kept a faithful copy of `src/dbworker/index.ts`'s `handle` on purpose - the
 * `reader` split and the string-encoded counts are exactly the parts a change
 * would break silently.
 */
function fakeTransport(): DbTransport & { calls: DbWorkerRequest[] } {
  let db: SQLite.Database | null = null
  let listener: ((response: DbWorkerResponse) => void) | null = null
  const calls: DbWorkerRequest[] = []

  const run = (request: DbWorkerRequest): DbWorkerResponse => {
    try {
      switch (request.kind) {
        case 'open':
          db = new SQLite(request.path)
          db.pragma('journal_mode = WAL')
          db.pragma('foreign_keys = ON')
          return { id: request.id, ok: true }
        case 'query': {
          const statement = db!.prepare(request.sql)
          if (statement.reader) {
            return {
              id: request.id,
              ok: true,
              rows: statement.all(...(request.parameters as unknown[])) as unknown[]
            }
          }
          const result = statement.run(...(request.parameters as unknown[]))
          return {
            id: request.id,
            ok: true,
            rows: [],
            numAffectedRows: String(result.changes),
            insertId: String(result.lastInsertRowid)
          }
        }
        case 'begin':
          db!.prepare('BEGIN').run()
          return { id: request.id, ok: true }
        case 'commit':
          db!.prepare('COMMIT').run()
          return { id: request.id, ok: true }
        case 'rollback':
          db!.prepare('ROLLBACK').run()
          return { id: request.id, ok: true }
        case 'close':
          if (db?.open) db.close()
          db = null
          return { id: request.id, ok: true }
      }
    } catch (e) {
      return { id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    calls,
    send(request) {
      calls.push(request)
      // Asynchronously, because that is the one thing a real transport
      // guarantees and the driver has to cope with.
      const response = run(request)
      setTimeout(() => listener?.(response), 0)
    },
    onMessage(next) {
      listener = next
    },
    dispose() {
      if (db?.open) db.close()
      db = null
    }
  }
}

let dir: string
let dbPath: string
let db: Kysely<Schema>
let transport: ReturnType<typeof fakeTransport>

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-remote-'))
  dbPath = path.join(dir, 'app.db')
  // The schema is made here rather than through the driver, so a failure in
  // these cases is never ambiguous about which side broke.
  const seed = new SQLite(dbPath)
  seed.exec('CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  seed.close()

  transport = fakeTransport()
  db = new Kysely<Schema>({ dialect: new RemoteSqliteDialect(transport, dbPath) })
})

afterEach(async () => {
  await db.destroy()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('reads and writes', () => {
  it('round-trips a row', async () => {
    await db.insertInto('widget').values({ id: 1, name: 'anvil' }).execute()
    const rows = await db.selectFrom('widget').selectAll().execute()
    expect(rows).toEqual([{ id: 1, name: 'anvil' }])
  })

  it('reports affected rows and the insert id as bigints', async () => {
    // They cross the boundary as strings, because a bigint cannot survive a
    // `postMessage`. Kysely's contract is bigint, so the driver rebuilds them -
    // and a caller comparing against `1n` would break if it did not.
    //
    // The field names differ by statement: an insert answers with
    // `insertId` / `numInsertedOrUpdatedRows`, an update with
    // `numUpdatedRows`. `numAffectedRows` is the DRIVER's name for the same
    // number, one level down - reaching for it here is what the first version
    // of this case did, and it read `undefined`.
    const insert = await db.insertInto('widget').values({ name: 'hammer' }).executeTakeFirst()
    expect(insert.insertId).toBe(1n)
    expect(insert.numInsertedOrUpdatedRows).toBe(1n)

    const update = await db
      .updateTable('widget')
      .set({ name: 'mallet' })
      .where('id', '=', 1)
      .executeTakeFirst()
    expect(update.numUpdatedRows).toBe(1n)
  })

  it('surfaces a database error as a rejection with the message', async () => {
    await expect(
      db
        .insertInto('widget')
        .values({ id: 1, name: null as unknown as string })
        .execute()
    ).rejects.toThrow(/NOT NULL/)
  })
})

describe('transactions', () => {
  it('commits everything or nothing', async () => {
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('widget').values({ id: 1, name: 'a' }).execute()
      await tx.insertInto('widget').values({ id: 2, name: 'b' }).execute()
    })
    expect(await db.selectFrom('widget').selectAll().execute()).toHaveLength(2)
  })

  it('rolls back a transaction that throws, leaving nothing behind', async () => {
    await expect(
      db.transaction().execute(async (tx) => {
        await tx.insertInto('widget').values({ id: 1, name: 'a' }).execute()
        throw new Error('changed my mind')
      })
    ).rejects.toThrow('changed my mind')
    expect(await db.selectFrom('widget').selectAll().execute()).toEqual([])
  })

  /**
   * The case the whole `acquireConnection` queue exists for.
   *
   * `better-sqlite3` is synchronous and the worker holds ONE handle, so two
   * overlapping transactions would issue `BEGIN` twice against it - SQLite
   * refuses the second and the first one's work escapes its own transaction.
   * Kysely serialises through `acquireConnection`, and this asserts the
   * outcome rather than the mechanism: both transactions complete, and the
   * BEGINs never interleave.
   */
  it('serialises two transactions started at once', async () => {
    await Promise.all([
      db.transaction().execute(async (tx) => {
        await tx.insertInto('widget').values({ id: 1, name: 'first' }).execute()
        await tx.insertInto('widget').values({ id: 2, name: 'first' }).execute()
      }),
      db.transaction().execute(async (tx) => {
        await tx.insertInto('widget').values({ id: 3, name: 'second' }).execute()
        await tx.insertInto('widget').values({ id: 4, name: 'second' }).execute()
      })
    ])

    expect(await db.selectFrom('widget').selectAll().execute()).toHaveLength(4)

    // No BEGIN without its COMMIT before the next BEGIN.
    const shape = transport.calls
      .map((c) => c.kind)
      .filter((k) => k === 'begin' || k === 'commit' || k === 'rollback')
    expect(shape).toEqual(['begin', 'commit', 'begin', 'commit'])
  })

  it('a failed transaction does not strand the connection', async () => {
    // The queue hands the connection to the next caller on release, and a
    // release that only happened on the happy path would deadlock everything
    // after the first failure.
    await expect(
      db.transaction().execute(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    // If the connection were stranded this would never resolve.
    await db.insertInto('widget').values({ id: 9, name: 'after' }).execute()
    expect(await db.selectFrom('widget').selectAll().execute()).toHaveLength(1)
  })
})

describe('shutdown', () => {
  it('closes the worker and rejects anything still waiting', async () => {
    const closed = new Kysely<Schema>({
      dialect: new RemoteSqliteDialect(fakeTransport(), dbPath)
    })
    await closed.selectFrom('widget').selectAll().execute()
    await closed.destroy()
    await expect(closed.selectFrom('widget').selectAll().execute()).rejects.toThrow()
  })
})
