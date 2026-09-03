/**
 * The UI's SQLite, in a process of its own.
 *
 * # The problem this solves
 *
 * `better-sqlite3` is a SYNCHRONOUS driver, and every one of the app's IPC
 * handlers used to run its queries on the Electron main process's event loop -
 * the same loop that carries the 16ms foreground-focus ticker, the 1s game
 * poll, the engine's stdout JSON Lines, and every window message. So the cost
 * of one slow query was never "that screen is slow": the HUD dropped frames of
 * focus tracking, engine events queued up behind it, and every other IPC call
 * waited. `docs/performance-improvement-notes.md` has called it the one
 * remaining architectural performance problem rather than a constant factor.
 *
 * # Why the DATABASE moved and not the handlers
 *
 * The obvious plan - move `src/main/ipc/` wholesale into a utility process -
 * does not work, and it is worth writing down why so nobody starts it. A large
 * fraction of those handlers need main-only Electron APIs: `clipboard`
 * (`decks:clipboardCandidate`), `dialog` (the diagnostics export),
 * `shell.openPath`, `net.fetch` (the portal), `app.getVersion`, and
 * `electron-store` - none of which exist in a utility process.
 *
 * So the seam is one level lower: this process owns the file and the driver,
 * and main keeps a Kysely instance whose driver forwards compiled SQL here
 * (`src/main/data/db/remoteDriver.ts`). Every handler's code is unchanged -
 * they still write `db.selectFrom(...).execute()` - and the queries simply
 * stop running on the loop that has to stay responsive.
 *
 * # Connections and transactions
 *
 * `better-sqlite3` is synchronous and this process is single-threaded, so
 * "connections" here are bookkeeping rather than real ones: a transaction
 * pins an id, and while one is open the driver on the other side will not
 * hand out a second - Kysely's `acquireConnection` is what serialises it.
 * Without that, two interleaved transactions would issue `BEGIN` twice against
 * one handle.
 */
import SQLite from 'better-sqlite3'

/** Requests from `remoteDriver.ts`. See its header for the other half. */
type Request =
  | { id: number; kind: 'open'; path: string }
  | { id: number; kind: 'query'; sql: string; parameters: readonly unknown[] }
  | { id: number; kind: 'begin' }
  | { id: number; kind: 'commit' }
  | { id: number; kind: 'rollback' }
  | { id: number; kind: 'close' }

type Response =
  | { id: number; ok: true; rows?: unknown[]; numAffectedRows?: string; insertId?: string }
  | { id: number; ok: false; error: string }

let db: SQLite.Database | null = null

function open(dbPath: string): void {
  if (db) return
  const opened = new SQLite(dbPath)
  // The same three pragmas the in-process driver set, and for the same
  // reasons: WAL matches the engine's writer side so UI reads never block its
  // writes, and `busy_timeout` covers the moment a user edit lands while the
  // engine is mid-commit.
  opened.pragma('journal_mode = WAL')
  opened.pragma('foreign_keys = ON')
  opened.pragma('busy_timeout = 5000')
  db = opened
}

/**
 * Run one statement.
 *
 * The `reader` split is `better-sqlite3`'s own: `all()` is for statements that
 * return rows and throws on the ones that do not, and `run()` is the reverse.
 * `numAffectedRows` and `insertId` go back as STRINGS because Kysely types them
 * as `bigint` and a bigint cannot cross a `postMessage` boundary - the driver
 * converts them back.
 */
function query(sql: string, parameters: readonly unknown[]): Omit<Response & { ok: true }, 'id'> {
  if (!db) throw new Error('database not open')
  const statement = db.prepare(sql)
  if (statement.reader) {
    return { ok: true, rows: statement.all(...(parameters as unknown[])) as unknown[] }
  }
  const result = statement.run(...(parameters as unknown[]))
  return {
    ok: true,
    rows: [],
    numAffectedRows: String(result.changes),
    insertId: String(result.lastInsertRowid)
  }
}

function handle(request: Request): Omit<Response, 'id'> {
  switch (request.kind) {
    case 'open':
      open(request.path)
      return { ok: true }
    case 'query':
      return query(request.sql, request.parameters)
    case 'begin':
      db?.prepare('BEGIN').run()
      return { ok: true }
    case 'commit':
      db?.prepare('COMMIT').run()
      return { ok: true }
    case 'rollback':
      db?.prepare('ROLLBACK').run()
      return { ok: true }
    case 'close':
      if (db?.open) db.close()
      db = null
      return { ok: true }
  }
}

process.parentPort?.on('message', (event) => {
  const request = event.data as Request
  let response: Omit<Response, 'id'>
  try {
    response = handle(request)
  } catch (e) {
    // Errors travel as text. A `better-sqlite3` error carries a `code` that
    // some callers switch on, so it is prefixed into the message rather than
    // dropped - `SqliteError: ...` is what the in-process driver produced too.
    response = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  process.parentPort.postMessage({ id: request.id, ...response })
})
