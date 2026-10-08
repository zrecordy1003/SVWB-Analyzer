/**
 * Test doubles for the sync Worker: a D1 backed by real SQLite, an R2 backed by
 * a Map, and a Google that signs real RS256 id_tokens with a key we generated.
 *
 * Nothing here mocks the Worker's own logic. `world()` hands back the REAL
 * router wired to these three, so a test is a request in and a response out -
 * the same path production takes, minus Cloudflare.
 *
 * The D1 shim is deliberately faithful in the one place that has bitten this
 * project before: results come back as `{ results, success, meta }`, and
 * `meta.changes` is how the Worker learns whether a conditional write applied
 * (quota reservation, round counting, single-use grants all hang off it).
 */
import SQLite from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { handle } from '../../../server/sync/src/router'
import { retireIdleDevices } from '../../../server/sync/src/retire'
import { b64urlEncode, sha256, sha256Hex, utf8 } from '../../../server/sync/src/jwt'
import { parseConfig } from '../../../server/sync/src/limits'
import type {
  D1Like,
  D1Result,
  D1StatementLike,
  Deps,
  R2BodyLike,
  R2Like,
  R2ListResult
} from '../../../server/sync/src/types'

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/sync/migrations')

// ---------------------------------------------------------------- D1

class Statement implements D1StatementLike {
  constructor(
    private readonly db: SQLite.Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    for (const v of values) {
      // D1 rejects `undefined` at bind time; so must this, or a test would pass
      // on a call production refuses.
      if (v === undefined) throw new Error('D1 cannot bind undefined')
    }
    return new Statement(this.db, this.sql, values)
  }

  execute(): D1Result<unknown> {
    // D1 (like SQLite proper) takes `?1`-style numbered parameters, and a
    // parameter may be used more than once. better-sqlite3 does not understand
    // them, so they are rewritten to named parameters and bound as an object.
    const numbered = /\?(\d+)/.test(this.sql)
    const sql = numbered ? this.sql.replace(/\?(\d+)/g, ':p$1') : this.sql
    const args: unknown[] = numbered
      ? [Object.fromEntries(this.params.map((v, i) => [`p${i + 1}`, v]))]
      : this.params
    const stmt = this.db.prepare(sql)
    if (stmt.reader) {
      const rows = stmt.all(...args)
      return { results: rows, success: true, meta: { changes: 0, last_row_id: 0 } }
    }
    const info = stmt.run(...args)
    return {
      results: [],
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) }
    }
  }

  async run(): Promise<D1Result<unknown>> {
    return this.execute()
  }

  async first<T>(): Promise<T | null> {
    const rows = (this.execute().results as T[]) ?? []
    return rows[0] ?? null
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>
  }
}

export class SqliteD1 implements D1Like {
  readonly raw: SQLite.Database
  constructor() {
    this.raw = new SQLite(':memory:')
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
      if (file.endsWith('.sql')) this.raw.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))
    }
  }

  prepare(query: string): D1StatementLike {
    return new Statement(this.raw, query)
  }

  async batch(statements: D1StatementLike[]): Promise<D1Result<unknown>[]> {
    const run = this.raw.transaction(() => statements.map((s) => (s as Statement).execute()))
    return run()
  }

  /** Test-side peek. */
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[]
  }
}

// ---------------------------------------------------------------- R2

export class MemoryR2 implements R2Like {
  readonly store = new Map<string, Uint8Array>()
  /** Small so a test with a handful of objects still crosses a page boundary. */
  pageSize = 1000
  failNextPut = false
  listCalls = 0

  async get(key: string): Promise<R2BodyLike | null> {
    const value = this.store.get(key)
    if (!value) return null
    return {
      key,
      size: value.length,
      body: new Response(value).body as ReadableStream<Uint8Array>,
      arrayBuffer: async () => value.slice().buffer as ArrayBuffer
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false
      throw new Error('R2 put failed')
    }
    this.store.set(key, value.slice())
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys]
    if (list.length > 1000) throw new Error('R2 delete takes at most 1000 keys')
    for (const key of list) this.store.delete(key)
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResult> {
    this.listCalls++
    const limit = Math.min(options.limit ?? 1000, this.pageSize)
    const all = [...this.store.keys()]
      .filter((k) => k.startsWith(options.prefix ?? ''))
      .sort()
      .filter((k) => options.cursor === undefined || k > options.cursor)
    const page = all.slice(0, limit)
    const truncated = all.length > page.length
    return {
      objects: page.map((key) => ({ key, size: this.store.get(key)!.length })),
      truncated,
      cursor: truncated ? page[page.length - 1] : undefined
    }
  }

  keys(): string[] {
    return [...this.store.keys()].sort()
  }
}

// ---------------------------------------------------------------- Google

export const CLIENT_ID = 'test-client.apps.googleusercontent.com'
export const CLIENT_SECRET = 'test-client-secret'
export const SESSION_SECRET = 'test-session-secret-at-least-32-bytes-long!!'

export interface IdClaims {
  iss?: string
  aud?: string | string[]
  sub?: string
  email?: string
  email_verified?: boolean | string
  name?: string
  picture?: string
  nonce?: string
  exp?: number
  iat?: number
}

async function rsaKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )
}

export class FakeGoogle {
  private constructor(
    private readonly good: CryptoKeyPair,
    private readonly evil: CryptoKeyPair,
    private readonly publicJwk: JsonWebKey & { kid: string; alg: string; use: string },
    private readonly clock: { t: number }
  ) {}

  static async create(clock: { t: number }): Promise<FakeGoogle> {
    const good = await rsaKey()
    const evil = await rsaKey()
    const jwk = await crypto.subtle.exportKey('jwk', good.publicKey)
    return new FakeGoogle(good, evil, { ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }, clock)
  }

  readonly requests: Array<{ url: string; body?: string }> = []
  jwksFetches = 0
  tokenFails = false
  private readonly codes = new Map<string, string>()

  /** A signed id_token. `signWith: 'evil'` signs with a key Google never published. */
  async idToken(
    claims: IdClaims,
    options: { signWith?: 'good' | 'evil'; kid?: string; alg?: string } = {}
  ): Promise<string> {
    const now = Math.floor(this.clock.t / 1000)
    const payload = {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '1000000001',
      email: 'player@example.com',
      email_verified: true,
      name: 'Test Player',
      iat: now,
      exp: now + 3600,
      ...claims
    }
    const header = { alg: options.alg ?? 'RS256', kid: options.kid ?? 'k1', typ: 'JWT' }
    const head = b64urlEncode(utf8(JSON.stringify(header)))
    const body = b64urlEncode(utf8(JSON.stringify(payload)))
    const key = (options.signWith === 'evil' ? this.evil : this.good).privateKey
    const sig = new Uint8Array(
      await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${head}.${body}`) as BufferSource)
    )
    return `${head}.${body}.${b64urlEncode(sig)}`
  }

  /** What the browser step would produce: a one-time code that maps to an id_token. */
  async issueCode(
    claims: IdClaims,
    options?: { signWith?: 'good' | 'evil'; kid?: string; alg?: string }
  ): Promise<string> {
    const code = `code-${this.codes.size + 1}-${Math.random().toString(36).slice(2)}`
    this.codes.set(code, await this.idToken(claims, options))
    return code
  }

  fetch = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<Response> => {
    this.requests.push({ url, body: init?.body })
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      this.jwksFetches++
      return Response.json({ keys: [this.publicJwk] })
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      if (this.tokenFails) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      const form = new URLSearchParams(init?.body ?? '')
      const code = form.get('code') ?? ''
      const ok =
        init?.method === 'POST' &&
        form.get('client_id') === CLIENT_ID &&
        form.get('client_secret') === CLIENT_SECRET &&
        form.get('grant_type') === 'authorization_code' &&
        form.get('redirect_uri') === 'https://sync.test/auth/callback'
      const idToken = this.codes.get(code)
      if (!ok || !idToken) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      this.codes.delete(code) // Google codes are single use too
      return Response.json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' })
    }
    return new Response('not found', { status: 404 })
  }
}

// ---------------------------------------------------------------- the world

export interface Tokens {
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  deviceId: string
}

export interface World {
  db: SqliteD1
  bucket: MemoryR2
  google: FakeGoogle
  clock: { t: number }
  deps: Deps
  call(
    method: string,
    pathAndQuery: string,
    init?: {
      token?: string
      json?: unknown
      body?: string | Uint8Array
      headers?: Record<string, string>
    }
  ): Promise<Response>
  /** The whole login flow, as the app performs it. */
  login(options?: LoginOptions): Promise<Tokens & { sub: string }>
  /** PUT a segment with the correct hash header. */
  putSegment(tokens: Tokens, seq: number, text: string): Promise<Response>
  retire(): ReturnType<typeof retireIdleDevices>
}

export interface LoginOptions {
  sub?: string
  email?: string
  name?: string
  deviceId?: string
  deviceName?: string
}

export const T0 = Date.UTC(2026, 8, 1, 12, 0, 0)

export async function world(
  vars: Partial<
    Record<'QUOTA_BYTES' | 'ROUNDS_PER_DAY' | 'MAX_DEVICES' | 'KILL_SWITCH', string>
  > = {}
): Promise<World> {
  const clock = { t: T0 }
  const google = await FakeGoogle.create(clock)
  const db = new SqliteD1()
  const bucket = new MemoryR2()
  const deps: Deps = {
    db,
    bucket,
    config: parseConfig(vars),
    secrets: {
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      sessionSecret: SESSION_SECRET
    },
    fetch: google.fetch,
    now: () => clock.t,
    jwks: { current: null }
  }

  const call: World['call'] = (method, pathAndQuery, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (init.token) headers.authorization = `Bearer ${init.token}`
    let body: string | Uint8Array | undefined = init.body
    if (init.json !== undefined) {
      body = JSON.stringify(init.json)
      headers['content-type'] = 'application/json'
    }
    return handle(
      deps,
      new Request(`https://sync.test${pathAndQuery}`, {
        method,
        headers,
        body: body as BodyInit | undefined
      })
    )
  }

  const login: World['login'] = async (options = {}) => {
    const sub = options.sub ?? '1000000001'
    const deviceId = options.deviceId ?? 'dev-a'
    const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = b64urlEncode(await sha256(utf8(verifier)))

    const start = await call(
      'GET',
      `/auth/start?port=48151&challenge=${challenge}&state=app-state-1`
    )
    if (start.status !== 302) throw new Error(`start: ${start.status}`)
    const googleUrl = new URL(start.headers.get('location')!)
    const sealed = googleUrl.searchParams.get('state')!
    const nonce = googleUrl.searchParams.get('nonce')!

    const code = await google.issueCode({
      sub,
      nonce,
      ...(options.email ? { email: options.email } : {}),
      ...(options.name ? { name: options.name } : {})
    })
    const callback = await call(
      'GET',
      `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(sealed)}`
    )
    const back = new URL(callback.headers.get('location')!)
    const grant = back.searchParams.get('grant')
    if (!grant) throw new Error(`login failed: ${back.search}`)
    const response = await call('POST', '/v1/auth/token', {
      json: {
        grant,
        verifier,
        deviceId,
        deviceName: options.deviceName ?? 'Test PC',
        appVersion: '1.6.0'
      }
    })
    if (response.status !== 200)
      throw new Error(`token: ${response.status} ${await response.text()}`)
    const tokens = (await response.json()) as Tokens
    return { ...tokens, sub }
  }

  return {
    db,
    bucket,
    google,
    clock,
    deps,
    call,
    login,
    putSegment: async (tokens, seq, text) =>
      call('PUT', `/v1/segments/${seq}`, {
        token: tokens.accessToken,
        body: text,
        headers: { 'x-content-sha256': await sha256Hex(text) }
      }),
    retire: () => retireIdleDevices(deps)
  }
}

/** A segment body: header line plus change lines. */
export function segmentText(device: string, seq: number, lines: object[] = []): string {
  const header = { v: 1, schemaVersion: 18, device, seq, hlc: 1757203200123 + seq }
  return [header, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n'
}

export function change(tbl: string, uid: string, ts: number, extra: object = {}): object {
  return { tbl, uid, op: 'upsert', ts, row: { n: ts }, ...extra }
}

export const DAY = 24 * 3600_000
