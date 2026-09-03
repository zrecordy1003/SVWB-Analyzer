/**
 * A Kysely dialect that runs its SQL in another process.
 *
 * The other half of `src/dbworker/index.ts`; read its header first for why the
 * database moved and the handlers did not.
 *
 * What this buys is that nothing above it changes. Every handler still writes
 * `db.selectFrom('Match')...execute()`, every `db.transaction()` still works,
 * and the compiled SQL simply travels over a `postMessage` instead of into a
 * synchronous `better-sqlite3` call on the main process's event loop. Kysely's
 * driver interface is promise-based, so the boundary fits without a single
 * call site knowing about it.
 *
 * # Serialising is the whole trick
 *
 * `better-sqlite3` is synchronous and the worker holds one handle, so two
 * overlapping transactions would issue `BEGIN` twice against it. Kysely calls
 * `acquireConnection` before a transaction and `releaseConnection` after, so a
 * mutex there is enough: one caller holds the connection for the length of its
 * transaction and everyone else queues.
 *
 * Non-transactional queries go through the same gate. That is a real
 * serialisation - concurrent reads no longer overlap - and it costs nothing
 * here, because the worker could not have run them in parallel either.
 */
import type {
  DatabaseConnection,
  Driver,
  Dialect,
  QueryResult,
  CompiledQuery,
  DatabaseIntrospector,
  Kysely,
  QueryCompiler,
  DialectAdapter
} from 'kysely'
import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely'

/** What the worker understands. Mirrors `Request` in `src/dbworker/index.ts`. */
export type DbWorkerRequest =
  | { id: number; kind: 'open'; path: string }
  | { id: number; kind: 'query'; sql: string; parameters: readonly unknown[] }
  | { id: number; kind: 'begin' }
  | { id: number; kind: 'commit' }
  | { id: number; kind: 'rollback' }
  | { id: number; kind: 'close' }

/**
 * `Omit` over a union, distributed.
 *
 * A plain `Omit<DbWorkerRequest, 'id'>` collapses the union to the properties
 * every member shares - which is `kind` alone - so `sql` and `path` stop
 * existing. This keeps each member whole.
 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export type DbWorkerCall = WithoutId<DbWorkerRequest>

export type DbWorkerResponse =
  | { id: number; ok: true; rows?: unknown[]; numAffectedRows?: string; insertId?: string }
  | { id: number; ok: false; error: string }

/**
 * How the driver talks to the worker.
 *
 * An interface rather than a `UtilityProcess`, so the driver can be tested
 * against an in-memory worker with no Electron at all - see
 * `tests/main/remoteDriver.test.ts`. It is also what lets `initDb` decide
 * between the real process and something else without this file knowing.
 */
export type DbTransport = {
  send: (request: DbWorkerRequest) => void
  onMessage: (listener: (response: DbWorkerResponse) => void) => void
  dispose: () => Promise<void> | void
}

class RemoteConnection implements DatabaseConnection {
  constructor(
    private readonly call: (request: DbWorkerCall) => Promise<DbWorkerResponse & { ok: true }>
  ) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const response = await this.call({
      kind: 'query',
      sql: compiled.sql,
      parameters: compiled.parameters
    })
    return {
      rows: (response.rows ?? []) as R[],
      // Strings on the wire because a `bigint` cannot cross `postMessage`;
      // Kysely wants bigints, so they are rebuilt here.
      numAffectedRows:
        response.numAffectedRows === undefined ? undefined : BigInt(response.numAffectedRows),
      insertId: response.insertId === undefined ? undefined : BigInt(response.insertId)
    }
  }

  /**
   * Streaming is not supported, and saying so is better than a silent
   * fallback: `better-sqlite3`'s iterator holds the statement open across
   * awaits, which cannot be modelled over a request/response boundary without
   * pinning the worker for the duration. Nothing in this app streams.
   */
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    // Not a generator, so it throws when CALLED rather than on the first
    // iteration - the caller finds out at the query, not at the loop.
    throw new Error('streaming is not supported by the remote SQLite driver')
  }
}

class RemoteDriver implements Driver {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (r: DbWorkerResponse & { ok: true }) => void; reject: (e: Error) => void }
  >()
  /** The tail of the queue of callers waiting for the single connection. */
  private queue: Promise<void> = Promise.resolve()
  private connection: RemoteConnection | null = null

  constructor(
    private readonly transport: DbTransport,
    private readonly dbPath: string
  ) {}

  private call = (request: DbWorkerCall): Promise<DbWorkerResponse & { ok: true }> =>
    new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.transport.send({ id, ...request } as DbWorkerRequest)
    })

  async init(): Promise<void> {
    this.transport.onMessage((response) => {
      const waiter = this.pending.get(response.id)
      if (!waiter) return
      this.pending.delete(response.id)
      if (response.ok) waiter.resolve(response)
      // The worker sends the message text; the stack is this side's, which is
      // the useful one - it points at the query's call site.
      else waiter.reject(new Error(response.error))
    })
    this.connection = new RemoteConnection(this.call)
    await this.call({ kind: 'open', path: this.dbPath })
  }

  /**
   * One connection, handed out in turn.
   *
   * The queue is a chain of promises rather than a lock with a counter: each
   * caller waits on the previous release, which is exactly the ordering Kysely
   * needs and has no way to be left holding a lock after a throw.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    let release!: () => void
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    const ahead = this.queue
    this.queue = ahead.then(() => mine)
    await ahead
    this.releaseCurrent = release
    return this.connection as DatabaseConnection
  }

  private releaseCurrent: (() => void) | null = null

  async releaseConnection(): Promise<void> {
    const release = this.releaseCurrent
    this.releaseCurrent = null
    release?.()
  }

  async beginTransaction(): Promise<void> {
    await this.call({ kind: 'begin' })
  }

  async commitTransaction(): Promise<void> {
    await this.call({ kind: 'commit' })
  }

  async rollbackTransaction(): Promise<void> {
    await this.call({ kind: 'rollback' })
  }

  async destroy(): Promise<void> {
    try {
      await this.call({ kind: 'close' })
    } catch {
      // A worker that has already gone is the normal case at shutdown.
    }
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error('database connection closed'))
    }
    this.pending.clear()
    await this.transport.dispose()
  }
}

/**
 * The dialect to hand `new Kysely({ dialect })`.
 *
 * The adapter, compiler and introspector are SQLite's own - only the driver is
 * replaced, because only the driver touches the file.
 */
export class RemoteSqliteDialect implements Dialect {
  constructor(
    private readonly transport: DbTransport,
    private readonly dbPath: string
  ) {}

  createDriver(): Driver {
    return new RemoteDriver(this.transport, this.dbPath)
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter()
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}
