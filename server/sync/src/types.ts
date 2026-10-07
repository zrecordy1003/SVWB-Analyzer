/**
 * The shapes the core logic depends on, and nothing else.
 *
 * Every module except `index.ts` talks to storage and to the network through
 * the structural interfaces below instead of Cloudflare's own types. Two
 * reasons, and the second is the one that matters:
 *
 *   1. The root `pnpm typecheck` includes this directory, and the Workers
 *      global types contradict Node's. Types that are structural subsets of
 *      both worlds mean the core compiles in either.
 *   2. It makes the core runnable under Node, where the tests drive the REAL
 *      router against a SQLite-backed D1 and a Map-backed R2. A Worker whose
 *      only test is "deploy it and click" is one nobody dares change.
 *
 * Only WebCrypto, `fetch`, `Response` and `ReadableStream` are used as globals;
 * Node 20+ and the Workers runtime both have them.
 */

// ---------------------------------------------------------------- D1

export interface D1Result<T> {
  results: T[]
  success: boolean
  meta: { changes: number; last_row_id: number }
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike
  run(): Promise<D1Result<unknown>>
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
}

export interface D1Like {
  prepare(query: string): D1StatementLike
  /** One transaction: all of it lands or none of it does. */
  batch(statements: D1StatementLike[]): Promise<D1Result<unknown>[]>
}

// ---------------------------------------------------------------- R2

export interface R2ObjectLike {
  key: string
  size: number
}

export interface R2BodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface R2ListResult {
  objects: R2ObjectLike[]
  truncated: boolean
  cursor?: string
}

export interface R2Like {
  get(key: string): Promise<R2BodyLike | null>
  put(key: string, value: Uint8Array): Promise<unknown>
  /** Accepts up to 1000 keys per call on the real binding. */
  delete(keys: string | string[]): Promise<void>
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResult>
}

// ---------------------------------------------------------------- misc

export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** The subset of `fetch` the core uses, so a test can stand in for Google. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<Response>

export interface Secrets {
  googleClientId: string
  googleClientSecret: string
  /** Signs access JWTs and the OAuth `state`. At least 32 bytes of entropy. */
  sessionSecret: string
}

/** Server-side policy. Parsed once from the Worker's vars (see limits.ts). */
export interface Config {
  quotaBytes: number
  roundsPerDay: number
  /** 0 = no cap. */
  maxDevices: number
  killSwitch: boolean
}

/** Cached Google signing keys. Mutable; one per isolate in production. */
export interface JwksCache {
  keys: Array<Record<string, unknown>>
  fetchedAt: number
}

export interface Deps {
  db: D1Like
  bucket: R2Like
  config: Config
  secrets: Secrets
  fetch: FetchLike
  /** Epoch milliseconds. Injected so tests can move time. */
  now: () => number
  jwks?: { current: JwksCache | null }
  ipLimiter?: RateLimiterLike
  authIpLimiter?: RateLimiterLike
  accountLimiter?: RateLimiterLike
}

/** What a verified access token resolves to. */
export interface Session {
  sub: string
  deviceId: string
}

// ---------------------------------------------------------------- Worker env

/** The Worker's bindings, as `index.ts` receives them. */
export interface Env {
  DB: D1Like
  BUCKET: R2Like
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET?: string
  QUOTA_BYTES?: string
  ROUNDS_PER_DAY?: string
  MAX_DEVICES?: string
  KILL_SWITCH?: string
  /** Optional on purpose: a missing limiter fails OPEN (see wrangler.toml). */
  IP_LIMITER?: RateLimiterLike
  AUTH_IP_LIMITER?: RateLimiterLike
  ACCOUNT_LIMITER?: RateLimiterLike
}
