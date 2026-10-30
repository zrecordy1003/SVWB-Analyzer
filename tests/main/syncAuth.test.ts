/**
 * Signing in with Google, and staying signed in, against the fake Google.
 *
 * The browser is a function: `openExternal` receives the authorization URL the
 * app would have opened, has the fake approve it, and follows the redirect to the
 * app's own loopback listener - a REAL http server here, because the listener
 * (bound to 127.0.0.1, one path, state-checked) is part of what is being tested.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DRIVE_APPDATA_SCOPE,
  GoogleSession,
  safePictureUrl,
  type GoogleConfig,
  type SessionDeps
} from '../../src/main/sync/google'
import {
  createFileCredentialStore,
  type Cipher,
  type CredentialStore,
  type Credentials
} from '../../src/main/sync/credentials'
import { SyncError } from '../../src/main/sync/transport'
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeGoogle } from '../../tools/sync-dev/fakeGoogle'

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

let clock = 1_000_000
let tmp: string
let google: FakeGoogle
beforeEach(async () => {
  clock = 1_000_000
  google = new FakeGoogle({ now: () => clock })
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-auth-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const config = (): GoogleConfig => ({
  clientId: FAKE_CLIENT_ID,
  clientSecret: FAKE_CLIENT_SECRET,
  endpoints: google.endpoints()
})

/** What a browser does with the URL: pick `email`, say yes, follow the redirect to the app. */
const browser =
  (email = 'me@example.com') =>
  async (url: string): Promise<void> => {
    await fetch(google.approve(url, email)).then((r) => r.text())
  }

function session(
  over: Partial<SessionDeps>,
  store: CredentialStore = memoryStore()
): GoogleSession {
  return new GoogleSession({
    config,
    fetch: google.fetch,
    store,
    openExternal: browser(),
    deviceId: async () => 'd-test',
    now: () => clock,
    ...over
  })
}

const someCreds = (): Credentials => ({
  refreshToken: 'x',
  email: 'me@example.com',
  name: null,
  picture: null,
  deviceId: 'd-test'
})

describe('signing in', () => {
  it('runs the whole round trip: PKCE out, code back, tokens and identity stored', async () => {
    google.setProfile('me@example.com', {
      name: 'Me',
      picture: 'https://lh3.googleusercontent.com/a/abc=s96-c'
    })
    const store = memoryStore()
    let opened: URL | undefined
    const s = session(
      {
        openExternal: async (url) => {
          opened = new URL(url)
          await browser()(url)
        }
      },
      store
    )

    const creds = await s.signIn()
    expect(creds).toMatchObject({
      email: 'me@example.com',
      name: 'Me',
      picture: 'https://lh3.googleusercontent.com/a/abc=s96-c',
      deviceId: 'd-test'
    })
    expect(store.current?.refreshToken).toMatch(/^1\/\//)

    // What was asked of Google: PKCE, offline access, the loopback, and ONLY these scopes.
    const q = opened!.searchParams
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/)
    expect(q.get('scope')!.split(' ').sort()).toEqual(
      ['email', 'openid', 'profile', DRIVE_APPDATA_SCOPE].sort()
    )
  })

  it('ignores a redirect whose state is not ours, and keeps waiting for the real one', async () => {
    const s = session({
      openExternal: async (url) => {
        const back = new URL(google.approve(url, 'me@example.com'))
        const bad = new URL(back)
        bad.searchParams.set('state', 'wrong')
        expect((await fetch(bad)).status).toBe(400)
        expect((await fetch(`http://127.0.0.1:${back.port}/other`)).status).toBe(404)
        await fetch(back)
      }
    })
    await expect(s.signIn()).resolves.toMatchObject({ email: 'me@example.com' })
  })

  it('a refusal at Google comes back as a cancelled sign-in, not a hang', async () => {
    const s = session({
      openExternal: async (url) => {
        const back = new URL(google.approve(url, 'me@example.com'))
        back.searchParams.delete('code')
        back.searchParams.set('error', 'access_denied')
        await fetch(back)
      }
    })
    await expect(s.signIn()).rejects.toMatchObject({ code: 'access_denied' })
    expect(google.tokenCalls.code).toBe(0)
  })

  it('unticking the Drive permission is refused by name, and nothing is stored', async () => {
    google.denyDriveScope = true
    const store = memoryStore()
    await expect(session({}, store).signIn()).rejects.toMatchObject({ code: 'scope_missing' })
    expect(store.current).toBeNull()
  })

  it('gives up when the browser never comes back', async () => {
    const s = session({ openExternal: async () => undefined, signInTimeoutMs: 50 })
    await expect(s.signIn()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('is inert when the build has no Google client', async () => {
    await expect(session({ config: () => null }).signIn()).rejects.toMatchObject({
      code: 'not_configured'
    })
  })

  it('a client Google does not know is refused, and nothing is stored', async () => {
    const store = memoryStore()
    const s = session({ config: () => ({ ...config(), clientSecret: 'wrong' }) }, store)
    await expect(s.signIn()).rejects.toBeInstanceOf(SyncError)
    expect(store.current).toBeNull()
  })
})

describe('the profile picture', () => {
  it.each([
    ['https://lh3.googleusercontent.com/a/x=s96-c', true],
    ['http://lh3.googleusercontent.com/a/x', false],
    ['https://evil.example.com/a.png', false],
    ['https://googleusercontent.com.evil.example/a.png', false],
    ['https://user:pw@lh3.googleusercontent.com/a.png', false],
    ['javascript:alert(1)', false],
    [`https://lh3.googleusercontent.com/${'a'.repeat(600)}`, false],
    [undefined, false]
  ])('%s is kept only if it is a Google-hosted https image', (value, kept) => {
    expect(safePictureUrl(value) !== null).toBe(kept)
  })
})

describe('staying signed in', () => {
  const signedIn = async (store = memoryStore()): Promise<GoogleSession> => {
    const s = session({}, store)
    await s.signIn()
    return s
  }

  it('reuses the access token until it is about to lapse, then refreshes', async () => {
    const s = await signedIn()
    const first = await s.accessToken()
    expect(await s.accessToken()).toBe(first)
    expect(google.tokenCalls.refresh).toBe(0)

    clock += google.accessTtlMs - 30_000 // inside the safety margin
    expect(await s.accessToken()).not.toBe(first)
    expect(google.tokenCalls.refresh).toBe(1)
  })

  it('concurrent callers share one refresh', async () => {
    const s = await signedIn()
    clock += google.accessTtlMs
    const tokens = await Promise.all([s.accessToken(), s.accessToken(), s.accessToken()])
    expect(new Set(tokens).size).toBe(1)
    expect(google.tokenCalls.refresh).toBe(1)
  })

  it('a request that finds its token refused refreshes and retries once', async () => {
    const s = await signedIn()
    google.forgetAccessTokens() // ours looks valid; Google has dropped it
    const res = await s.request(`${config().endpoints.drive}/files?spaces=appDataFolder`)
    expect(res.status).toBe(200)
    expect(google.tokenCalls.refresh).toBe(1)
  })

  it('the user removing the app in their Google account clears the stored sign-in and says so', async () => {
    const store = memoryStore()
    const s = await signedIn(store)
    google.revokeAll('me@example.com')
    clock += google.accessTtlMs
    const err = await s.accessToken().catch((e) => e)
    expect(err).toBeInstanceOf(SyncError)
    expect((err as SyncError).needsSignIn).toBe(true)
    expect(store.current).toBeNull()
  })

  it('a Google outage while refreshing does NOT sign the user out', async () => {
    const store = memoryStore()
    const s = await signedIn(store)
    google.tokenFail = 503
    clock += google.accessTtlMs
    await expect(s.accessToken()).rejects.toMatchObject({ status: 503 })
    expect(store.current).not.toBeNull()
  })

  it('signing out tells Google to drop the grant, forgets locally, and survives being offline', async () => {
    const store = memoryStore()
    const s = await signedIn(store)
    const refreshToken = store.current!.refreshToken
    await s.signOut()
    expect(store.current).toBeNull()
    // The grant is really dead: the old refresh token no longer works.
    const again = session({}, memoryStore({ ...someCreds(), refreshToken }))
    await expect(again.accessToken()).rejects.toMatchObject({ code: 'revoked' })

    const offline = session(
      {
        fetch: (async () => {
          throw new Error('offline')
        }) as unknown as typeof fetch
      },
      memoryStore(someCreds())
    )
    await expect(offline.signOut()).resolves.toBeUndefined()
  })

  it('a server that never answers becomes a timeout error, not a round that never ends', async () => {
    const store = memoryStore()
    await signedIn(store)
    const hang = session(
      {
        requestTimeoutMs: 40,
        fetch: ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
          })) as unknown as typeof fetch
      },
      store
    )
    // A fresh session has no access token, so its first need is a refresh - which
    // also goes through the hanging network.
    const started = Date.now()
    const err = await hang.request(`${config().endpoints.drive}/files`).catch((e) => e)
    expect(err).toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(store.current).not.toBeNull() // a timeout is not a sign-out
  })
})

describe('where the sign-in is kept', () => {
  const stored: Credentials = {
    refreshToken: 'SECRET-REFRESH',
    email: 'me@example.com',
    name: null,
    picture: null,
    deviceId: 'd-1'
  }

  it('is encrypted on disk - the token is not in the file', async () => {
    const file = path.join(tmp, 'sync-credentials.bin')
    const store = createFileCredentialStore(file, fakeCipher())
    await store.save(stored)
    const bytes = await fs.readFile(file)
    expect(bytes.toString('utf8')).not.toContain('SECRET-REFRESH')
    expect(bytes.toString('latin1')).not.toContain('me@example.com')
    expect(await createFileCredentialStore(file, fakeCipher()).load()).toEqual(stored)
  })

  it('writes NOTHING when encryption is unavailable, and keeps the session in memory', async () => {
    const file = path.join(tmp, 'sync-credentials.bin')
    const store = createFileCredentialStore(file, fakeCipher(false))
    await store.save(stored)
    expect(store.persistent).toBe(false)
    await expect(fs.stat(file)).rejects.toThrow()
    expect(await store.load()).toEqual(stored)
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
    await store.save(stored)
    await store.clear()
    await expect(fs.stat(file)).rejects.toThrow()
    expect(await store.load()).toBeNull()
  })
})
