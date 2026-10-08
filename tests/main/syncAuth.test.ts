/**
 * Signing in and staying signed in, against a fake Worker.
 *
 * The browser is a function that follows the redirect by hand: `openExternal`
 * receives the `/auth/start` URL the app would have opened, and answers the way
 * the Worker's callback would - a 302 to the app's own loopback listener, which
 * is a REAL http server here, because the listener (bound to 127.0.0.1, one
 * path, state-checked) is part of what is being tested.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session, type SessionDeps } from '../../src/main/sync/auth'
import {
  createFileCredentialStore,
  type Cipher,
  type Credentials,
  type CredentialStore
} from '../../src/main/sync/credentials'
import { SyncError } from '../../src/main/sync/transport'

const ORIGIN = 'https://sync.example'

/** A reversible "encryption" that is visibly not plaintext. */
const fakeCipher = (available = true): Cipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(Buffer.from(plain).toString('hex'), 'utf8'),
  decryptString: (enc) => Buffer.from(enc.toString('utf8'), 'hex').toString('utf8')
})

function memoryStore(
  initial: Credentials | null = null
): CredentialStore & { current: Credentials | null } {
  const store = {
    current: initial,
    persistent: true,
    load: async () => store.current,
    save: async (c: Credentials) => {
      store.current = c
    },
    clear: async () => {
      store.current = null
    }
  }
  return store
}

interface FakeWorker {
  fetch: typeof fetch
  calls: string[]
  /** What the app sent to /v1/auth/token. */
  tokenRequests: Array<Record<string, unknown>>
  accessTtlMs: number
  /** Make the next refresh fail like this. */
  failRefresh: { status: number; error: string } | null
  /** Tokens the server currently honours. */
  validAccess: Set<string>
  validRefresh: Set<string>
}

function fakeWorker(now: () => number): FakeWorker {
  let n = 0
  const w: FakeWorker = {
    calls: [],
    tokenRequests: [],
    accessTtlMs: 15 * 60_000,
    failRefresh: null,
    validAccess: new Set(),
    validRefresh: new Set(),
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url)
      w.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      const json = (
        status: number,
        body: unknown,
        headers: Record<string, string> = {}
      ): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers }
        })
      const body = init?.body ? JSON.parse(init.body as string) : null

      if (url.pathname === '/v1/auth/token') {
        w.tokenRequests.push(body)
        const access = `access-${++n}`
        const refresh = `refresh-${++n}`
        w.validAccess.add(access)
        w.validRefresh.add(refresh)
        return json(200, {
          accessToken: access,
          accessExpiresAt: now() + w.accessTtlMs,
          refreshToken: refresh,
          account: { email: 'me@example.com', name: 'Me' },
          deviceId: body.deviceId
        })
      }
      if (url.pathname === '/v1/auth/refresh') {
        if (w.failRefresh)
          return json(w.failRefresh.status, { error: w.failRefresh.error, message: 'no' })
        if (!w.validRefresh.has(body.refreshToken))
          return json(401, { error: 'revoked', message: 'no' })
        w.validRefresh.delete(body.refreshToken) // rotation: the old one dies
        const access = `access-${++n}`
        const refresh = `refresh-${++n}`
        w.validAccess.add(access)
        w.validRefresh.add(refresh)
        return json(200, {
          accessToken: access,
          accessExpiresAt: now() + w.accessTtlMs,
          refreshToken: refresh
        })
      }
      if (url.pathname === '/v1/auth/logout') return new Response(null, { status: 204 })
      // Anything else needs a valid bearer.
      const bearer = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '')
      if (!bearer || !w.validAccess.has(bearer))
        return json(401, { error: 'expired', message: 'old' })
      return json(200, { ok: true })
    }
  }
  return w
}

/** What a browser plus the Worker's /auth/callback would do, given the start URL. */
function browser(answer: (start: URL) => string | null): (url: string) => Promise<void> {
  return async (url) => {
    const start = new URL(url)
    const target = answer(start)
    if (target === null) return
    // The browser follows the Worker's 302 to the app's loopback listener.
    await fetch(target).then((r) => r.text())
  }
}

let clock = 1_000_000
let tmp: string
beforeEach(async () => {
  clock = 1_000_000
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-auth-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

function session(over: Partial<SessionDeps>, worker: FakeWorker, store: CredentialStore): Session {
  return new Session({
    endpoint: () => ORIGIN,
    fetch: worker.fetch,
    store,
    openExternal: async () => undefined,
    deviceId: async () => 'd-test',
    deviceName: () => 'TEST-PC',
    appVersion: () => '9.9.9',
    now: () => clock,
    ...over
  })
}

describe('signing in', () => {
  it('runs the whole round trip: PKCE pair out, grant back, tokens stored', async () => {
    const worker = fakeWorker(() => clock)
    const store = memoryStore()
    let started: URL | null = null
    const s = session(
      {
        openExternal: browser((start) => {
          started = start
          return `http://127.0.0.1:${start.searchParams.get('port')}/cb?grant=G1&state=${start.searchParams.get('state')}`
        })
      },
      worker,
      store
    )

    const creds = await s.signIn()
    expect(creds).toMatchObject({ email: 'me@example.com', deviceId: 'd-test' })
    expect(store.current?.refreshToken).toMatch(/^refresh-/)

    // What was sent to the Worker's start page and token endpoint.
    expect(started!.origin).toBe(ORIGIN)
    expect(started!.pathname).toBe('/auth/start')
    const verifier = worker.tokenRequests[0].verifier as string
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      started!.searchParams.get('challenge')
    )
    expect(worker.tokenRequests[0]).toMatchObject({
      grant: 'G1',
      deviceId: 'd-test',
      deviceName: 'TEST-PC',
      appVersion: '9.9.9'
    })
  })

  it('ignores a redirect whose state is not ours, and keeps waiting for the real one', async () => {
    const worker = fakeWorker(() => clock)
    const s = session(
      {
        openExternal: async (url) => {
          const start = new URL(url)
          const port = start.searchParams.get('port')
          const bad = await fetch(`http://127.0.0.1:${port}/cb?grant=EVIL&state=wrong`)
          expect(bad.status).toBe(400)
          const wrongPath = await fetch(`http://127.0.0.1:${port}/other`)
          expect(wrongPath.status).toBe(404)
          await fetch(
            `http://127.0.0.1:${port}/cb?grant=GOOD&state=${start.searchParams.get('state')}`
          )
        }
      },
      worker,
      memoryStore()
    )
    await s.signIn()
    expect(worker.tokenRequests).toHaveLength(1)
    expect(worker.tokenRequests[0].grant).toBe('GOOD')
  })

  it('a refusal at Google comes back as a cancelled sign-in, not a hang', async () => {
    const worker = fakeWorker(() => clock)
    const s = session(
      {
        openExternal: browser(
          (start) =>
            `http://127.0.0.1:${start.searchParams.get('port')}/cb?error=access_denied&state=${start.searchParams.get('state')}`
        )
      },
      worker,
      memoryStore()
    )
    await expect(s.signIn()).rejects.toMatchObject({ code: 'access_denied' })
    expect(worker.tokenRequests).toHaveLength(0)
  })

  it('gives up when the browser never comes back', async () => {
    const s = session(
      { openExternal: async () => undefined, signInTimeoutMs: 50 },
      fakeWorker(() => clock),
      memoryStore()
    )
    await expect(s.signIn()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('is inert when the build has no server', async () => {
    const s = session(
      { endpoint: () => null },
      fakeWorker(() => clock),
      memoryStore()
    )
    await expect(s.signIn()).rejects.toMatchObject({ code: 'not_configured' })
  })
})

describe('staying signed in', () => {
  const signedIn = async (worker: FakeWorker, store = memoryStore()): Promise<Session> => {
    const s = session(
      {
        openExternal: browser(
          (start) =>
            `http://127.0.0.1:${start.searchParams.get('port')}/cb?grant=G&state=${start.searchParams.get('state')}`
        )
      },
      worker,
      store
    )
    await s.signIn()
    return s
  }

  it('reuses the access token until it is about to lapse, then refreshes and stores the NEW refresh token', async () => {
    const worker = fakeWorker(() => clock)
    const store = memoryStore()
    const s = await signedIn(worker, store)
    const first = await s.accessToken()
    expect(await s.accessToken()).toBe(first)
    expect(worker.calls.filter((c) => c.includes('refresh'))).toHaveLength(0)

    const oldRefresh = store.current!.refreshToken
    clock += worker.accessTtlMs - 30_000 // inside the safety margin
    const next = await s.accessToken()
    expect(next).not.toBe(first)
    expect(store.current!.refreshToken).not.toBe(oldRefresh)
  })

  it('concurrent callers share one refresh - a second would burn the rotated token', async () => {
    const worker = fakeWorker(() => clock)
    const s = await signedIn(worker)
    clock += worker.accessTtlMs
    const tokens = await Promise.all([s.accessToken(), s.accessToken(), s.accessToken()])
    expect(new Set(tokens).size).toBe(1)
    expect(worker.calls.filter((c) => c.includes('refresh'))).toHaveLength(1)
  })

  it('a request that finds its token expired refreshes and retries once', async () => {
    const worker = fakeWorker(() => clock)
    const s = await signedIn(worker)
    worker.validAccess.clear() // the server forgot it, though our clock says fine
    const res = await s.request('/v1/me')
    expect(res.status).toBe(200)
    expect(worker.calls.filter((c) => c === 'GET /v1/me')).toHaveLength(2)
  })

  it('a revoked sign-in clears the stored credentials and says so', async () => {
    const worker = fakeWorker(() => clock)
    const store = memoryStore()
    const s = await signedIn(worker, store)
    worker.validRefresh.clear()
    clock += worker.accessTtlMs
    const err = await s.accessToken().catch((e) => e)
    expect(err).toBeInstanceOf(SyncError)
    expect((err as SyncError).needsSignIn).toBe(true)
    expect(store.current).toBeNull()
  })

  it('a flaky refresh (server error) does NOT sign the user out', async () => {
    const worker = fakeWorker(() => clock)
    const store = memoryStore()
    const s = await signedIn(worker, store)
    worker.failRefresh = { status: 503, error: 'unavailable' }
    clock += worker.accessTtlMs
    await expect(s.accessToken()).rejects.toMatchObject({ status: 503 })
    expect(store.current).not.toBeNull()
  })

  it('signing out tells the server, forgets locally, and survives the server being unreachable', async () => {
    const worker = fakeWorker(() => clock)
    const store = memoryStore()
    const s = await signedIn(worker, store)
    await s.signOut()
    expect(worker.calls).toContain('POST /v1/auth/logout')
    expect(store.current).toBeNull()

    const again = await signedIn(worker, memoryStore())
    const broken = session(
      {
        fetch: async () => {
          throw new Error('offline')
        }
      },
      worker,
      memoryStore(store.current)
    )
    void again
    await broken.signOut() // must not throw
  })
})

describe('where the sign-in is kept', () => {
  const creds: Credentials = {
    refreshToken: 'SECRET-REFRESH',
    email: 'me@example.com',
    name: null,
    picture: null,
    deviceId: 'd-1'
  }

  it('is encrypted on disk - the token is not in the file', async () => {
    const file = path.join(tmp, 'sync-credentials.bin')
    const store = createFileCredentialStore(file, fakeCipher())
    await store.save(creds)
    const bytes = await fs.readFile(file)
    expect(bytes.toString('utf8')).not.toContain('SECRET-REFRESH')
    expect(bytes.toString('latin1')).not.toContain('me@example.com')

    // A fresh process (new store object) reads it back.
    expect(await createFileCredentialStore(file, fakeCipher()).load()).toEqual(creds)
  })

  it('writes NOTHING when encryption is unavailable, and keeps the session in memory', async () => {
    const file = path.join(tmp, 'sync-credentials.bin')
    const store = createFileCredentialStore(file, fakeCipher(false))
    await store.save(creds)
    expect(store.persistent).toBe(false)
    await expect(fs.stat(file)).rejects.toThrow()
    expect(await store.load()).toEqual(creds)
    // ...and it is gone with the process.
    expect(await createFileCredentialStore(file, fakeCipher(false)).load()).toBeNull()
  })

  it('a file that will not decrypt (another user, a corrupted copy) just means signed out', async () => {
    const file = path.join(tmp, 'sync-credentials.bin')
    await fs.writeFile(file, 'garbage')
    expect(await createFileCredentialStore(file, fakeCipher()).load()).toBeNull()
  })

  it('clearing removes the file', async () => {
    const file = path.join(tmp, 'sync-credentials.bin')
    const store = createFileCredentialStore(file, fakeCipher())
    await store.save(creds)
    await store.clear()
    await expect(fs.stat(file)).rejects.toThrow()
    expect(await store.load()).toBeNull()
  })
})
