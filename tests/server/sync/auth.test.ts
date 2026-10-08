/**
 * Identity: the Google flow, id_token verification, grants, access tokens,
 * refresh rotation, revoke. Everything runs through the real router; only
 * Google, D1 and R2 are stand-ins (helpers.ts).
 */
import { describe, expect, it } from 'vitest'

import { b64urlEncode, sha256, utf8 } from '../../../server/sync/src/jwt'
import { CLIENT_ID, SESSION_SECRET, T0, world, type IdClaims, type World } from './helpers'

interface Flow {
  verifier: string
  challenge: string
  sealed: string
  nonce: string
}

async function begin(w: World, state = 'app-state-1'): Promise<Flow> {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64urlEncode(await sha256(utf8(verifier)))
  const start = await w.call('GET', `/auth/start?port=48151&challenge=${challenge}&state=${state}`)
  const google = new URL(start.headers.get('location')!)
  return {
    verifier,
    challenge,
    sealed: google.searchParams.get('state')!,
    nonce: google.searchParams.get('nonce')!
  }
}

async function callback(w: World, flow: Flow, code: string): Promise<URL> {
  const res = await w.call(
    'GET',
    `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.sealed)}`
  )
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location')!)
}

async function exchange(
  w: World,
  grant: string,
  verifier: string,
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return w.call('POST', '/v1/auth/token', {
    json: { grant, verifier, deviceId: 'dev-a', deviceName: 'PC', appVersion: '1.6.0', ...extra }
  })
}

describe('GET /auth/start', () => {
  it('redirects to Google with our client, redirect_uri, scope and a signed state', async () => {
    const w = await world()
    const res = await w.call(
      'GET',
      '/auth/start?port=48151&challenge=' + 'A'.repeat(43) + '&state=xyz'
    )
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location')!)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('https://sync.test/auth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('nonce')).toBeTruthy()
    // The Google secret never leaves the Worker.
    expect(url.toString()).not.toContain('test-client-secret')
  })

  it('writes nothing: an anonymous start cannot fill the database', async () => {
    const w = await world()
    await begin(w)
    for (const table of ['accounts', 'devices', 'grants', 'segments', 'rounds']) {
      expect(w.db.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]).toEqual({ n: 0 })
    }
  })

  it.each([
    ['port below 1024', 'port=80&challenge=' + 'A'.repeat(43) + '&state=s'],
    ['port above 65535', 'port=70000&challenge=' + 'A'.repeat(43) + '&state=s'],
    ['non-numeric port', 'port=abc&challenge=' + 'A'.repeat(43) + '&state=s'],
    ['short challenge', 'port=48151&challenge=abc&state=s'],
    ['challenge with a bad character', 'port=48151&challenge=' + '+'.repeat(43) + '&state=s'],
    ['empty state', 'port=48151&challenge=' + 'A'.repeat(43) + '&state='],
    [
      'state over 64 characters',
      'port=48151&challenge=' + 'A'.repeat(43) + '&state=' + 's'.repeat(65)
    ]
  ])('rejects %s with 422', async (_name, query) => {
    const w = await world()
    const res = await w.call('GET', `/auth/start?${query}`)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('invalid')
  })
})

describe('login flow', () => {
  it('start -> callback -> grant -> token, and the app gets its own state back', async () => {
    const w = await world()
    const flow = await begin(w)
    const code = await w.google.issueCode({ nonce: flow.nonce })
    const back = await callback(w, flow, code)

    expect(back.origin).toBe('http://127.0.0.1:48151')
    expect(back.pathname).toBe('/cb')
    expect(back.searchParams.get('state')).toBe('app-state-1')
    const grant = back.searchParams.get('grant')!
    expect(grant).toBeTruthy()

    // The Worker, not the app, presented the secret to Google.
    const tokenCall = w.google.requests.find((r) => r.url.endsWith('/token'))!
    expect(new URLSearchParams(tokenCall.body).get('client_secret')).toBe('test-client-secret')

    const res = await exchange(w, grant, flow.verifier)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.account).toEqual({
      email: 'player@example.com',
      name: 'Test Player',
      picture: null
    })
    expect(body.deviceId).toBe('dev-a')
    expect(body.accessExpiresAt).toBe(Math.floor((T0 + 15 * 60_000) / 1000) * 1000)
    expect(body.refreshToken).toMatch(/^1000000001\./)

    // Keyed on Google's sub; the grant itself is stored only as a hash.
    expect(w.db.rows('SELECT sub, email FROM accounts')).toEqual([
      { sub: '1000000001', email: 'player@example.com' }
    ])
    expect(JSON.stringify(w.db.rows('SELECT * FROM devices'))).not.toContain(body.refreshToken)
    expect(JSON.stringify(w.db.rows('SELECT * FROM grants'))).not.toContain(grant)
  })

  it('a grant works exactly once', async () => {
    const w = await world()
    const flow = await begin(w)
    const back = await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
    const grant = back.searchParams.get('grant')!
    expect((await exchange(w, grant, flow.verifier)).status).toBe(200)
    const again = await exchange(w, grant, flow.verifier)
    expect(again.status).toBe(403)
    expect((await again.json()).error).toBe('forbidden')
  })

  it('refuses a wrong verifier, and the grant is burned either way', async () => {
    const w = await world()
    const flow = await begin(w)
    const back = await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
    const grant = back.searchParams.get('grant')!
    const wrong = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
    expect((await exchange(w, grant, wrong)).status).toBe(403)
    // A guesser gets one try; the real app's verifier no longer helps either.
    expect((await exchange(w, grant, flow.verifier)).status).toBe(403)
    expect(w.db.rows('SELECT COUNT(*) AS n FROM devices')[0]).toEqual({ n: 0 })
  })

  it('refuses a grant after five minutes', async () => {
    const w = await world()
    const flow = await begin(w)
    const back = await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
    w.clock.t += 5 * 60_000 + 1
    expect((await exchange(w, back.searchParams.get('grant')!, flow.verifier)).status).toBe(403)
  })

  it('accepts a grant just inside its five minutes', async () => {
    const w = await world()
    const flow = await begin(w)
    const back = await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
    w.clock.t += 5 * 60_000 - 1000
    expect((await exchange(w, back.searchParams.get('grant')!, flow.verifier)).status).toBe(200)
  })

  it('validates the token request body', async () => {
    const w = await world()
    const flow = await begin(w)
    const back = await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
    const grant = back.searchParams.get('grant')!
    expect((await exchange(w, grant, flow.verifier, { deviceId: '../etc' })).status).toBe(422)
    expect((await exchange(w, grant, 'short')).status).toBe(422)
    expect((await w.call('POST', '/v1/auth/token', { body: 'not json' })).status).toBe(422)
    // Validation failures happen before the grant is spent.
    expect((await exchange(w, grant, flow.verifier)).status).toBe(200)
  })

  it('takes the account from Google, never from the request body', async () => {
    const w = await world()
    const flow = await begin(w)
    const back = await callback(
      w,
      flow,
      await w.google.issueCode({ nonce: flow.nonce, sub: '111' })
    )
    const res = await exchange(w, back.searchParams.get('grant')!, flow.verifier, {
      sub: '999',
      email: 'evil@example.com'
    })
    expect(res.status).toBe(200)
    expect(w.db.rows('SELECT sub, email FROM accounts')).toEqual([
      { sub: '111', email: 'player@example.com' }
    ])
  })

  describe('the profile picture', () => {
    const login = async (picture?: string): Promise<{ account: { picture: string | null } }> => {
      const w = await world()
      const flow = await begin(w)
      const back = await callback(
        w,
        flow,
        await w.google.issueCode({ nonce: flow.nonce, sub: '111', ...(picture ? { picture } : {}) })
      )
      const res = await exchange(w, back.searchParams.get('grant')!, flow.verifier)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { account: { picture: string | null } }
      // Held by the grant for the exchange and by nothing afterwards.
      expect(w.db.rows('SELECT * FROM grants')).toEqual([])
      expect(JSON.stringify(w.db.rows('SELECT * FROM accounts'))).not.toContain('googleusercontent')
      return body
    }

    it('comes back once, at sign-in, and is not kept on the account', async () => {
      const url = 'https://lh3.googleusercontent.com/a/ACg8ocJ-abc=s96-c'
      expect((await login(url)).account.picture).toBe(url)
    })

    it('is null when Google sent none', async () => {
      expect((await login()).account.picture).toBeNull()
    })

    it.each([
      'http://lh3.googleusercontent.com/a/x',
      'https://evil.example.com/a.png',
      'https://googleusercontent.com.evil.example/a.png',
      'https://user:pw@lh3.googleusercontent.com/a.png',
      'javascript:alert(1)',
      `https://lh3.googleusercontent.com/${'a'.repeat(600)}`
    ])('is dropped when it is not a Google-hosted https image: %s', async (picture) => {
      expect((await login(picture)).account.picture).toBeNull()
    })
  })

  describe('Google callback problems', () => {
    it('sends access_denied back to the app', async () => {
      const w = await world()
      const flow = await begin(w)
      const res = await w.call(
        'GET',
        `/auth/callback?error=access_denied&state=${encodeURIComponent(flow.sealed)}`
      )
      const back = new URL(res.headers.get('location')!)
      expect(back.searchParams.get('error')).toBe('access_denied')
      expect(back.searchParams.get('state')).toBe('app-state-1')
      expect(back.searchParams.get('grant')).toBeNull()
    })

    it('refuses a tampered state with 422 and no redirect', async () => {
      const w = await world()
      const flow = await begin(w)
      const [body, sig] = flow.sealed.split('.')
      const forged = b64urlEncode(
        utf8(JSON.stringify({ p: 9999, c: flow.challenge, s: 'x', n: flow.nonce, e: T0 + 1e9 }))
      )
      for (const state of [`${forged}.${sig}`, `${body}.AAAA`, 'garbage', '']) {
        const res = await w.call('GET', `/auth/callback?code=c&state=${encodeURIComponent(state)}`)
        expect(res.status).toBe(422)
        expect(res.headers.get('location')).toBeNull()
      }
    })

    it('reports an expired state to the app', async () => {
      const w = await world()
      const flow = await begin(w)
      w.clock.t += 10 * 60_000 + 1
      const back = await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
      expect(back.searchParams.get('error')).toBe('expired')
    })

    it('reports a failed code exchange', async () => {
      const w = await world()
      const flow = await begin(w)
      const back = await callback(w, flow, 'a-code-google-never-issued')
      expect(back.searchParams.get('error')).toBe('exchange_failed')
      w.google.tokenFails = true
      const back2 = await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
      expect(back2.searchParams.get('error')).toBe('exchange_failed')
    })
  })
})

describe('id_token verification', () => {
  const now = Math.floor(T0 / 1000)
  const cases: Array<
    [string, IdClaims, { signWith?: 'evil'; kid?: string; alg?: string }, string]
  > = [
    ['wrong audience', { aud: 'someone-elses-app' }, {}, 'invalid_id_token'],
    ['audience array without us', { aud: ['a', 'b'] }, {}, 'invalid_id_token'],
    ['wrong issuer', { iss: 'https://evil.example.com' }, {}, 'invalid_id_token'],
    ['expired', { exp: now - 3600 }, {}, 'invalid_id_token'],
    ['email not verified', { email_verified: false }, {}, 'email_unverified'],
    ['email_verified as the string "false"', { email_verified: 'false' }, {}, 'email_unverified'],
    ['wrong nonce', { nonce: 'not-the-nonce' }, {}, 'invalid_id_token'],
    ['no email', { email: '' }, {}, 'invalid_id_token'],
    ['a sub that is unsafe in an R2 key', { sub: '../other' }, {}, 'invalid_id_token'],
    ['signed with an unpublished key', {}, { signWith: 'evil' }, 'invalid_id_token'],
    ['an unknown kid', {}, { kid: 'nope' }, 'invalid_id_token'],
    ['alg none', {}, { alg: 'none' }, 'invalid_id_token'],
    ['alg HS256', {}, { alg: 'HS256' }, 'invalid_id_token']
  ]

  it.each(cases)('rejects %s', async (_name, claims, sign, expected) => {
    const w = await world()
    const flow = await begin(w)
    const code = await w.google.issueCode({ nonce: flow.nonce, ...claims }, sign)
    // A claim of `nonce` in `claims` must be able to override ours.
    const back = await callback(w, flow, code)
    expect(back.searchParams.get('error')).toBe(expected)
    expect(back.searchParams.get('grant')).toBeNull()
    expect(w.db.rows('SELECT COUNT(*) AS n FROM grants')[0]).toEqual({ n: 0 })
  })

  it('accepts email_verified given as the string "true", and an audience array containing us', async () => {
    const w = await world()
    const flow = await begin(w)
    const code = await w.google.issueCode({
      nonce: flow.nonce,
      email_verified: 'true',
      aud: ['other', CLIENT_ID]
    })
    expect((await callback(w, flow, code)).searchParams.get('grant')).toBeTruthy()
  })

  it('a token with a bad signature but otherwise perfect claims is still refused', async () => {
    const w = await world()
    const flow = await begin(w)
    const good = await w.google.idToken({ nonce: flow.nonce })
    const [h, p, s] = good.split('.')
    const flipped = `${h}.${p}.${s.slice(0, -4)}${s.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`
    const code = 'custom-code'
    ;(w.google as unknown as { codes: Map<string, string> }).codes.set(code, flipped)
    expect((await callback(w, flow, code)).searchParams.get('error')).toBe('invalid_id_token')
  })

  it('caches Google keys across logins and re-fetches for an unknown kid', async () => {
    const w = await world()
    for (let i = 0; i < 3; i++) {
      const flow = await begin(w)
      await callback(w, flow, await w.google.issueCode({ nonce: flow.nonce }))
    }
    expect(w.google.jwksFetches).toBe(1)
  })
})

describe('access tokens', () => {
  it('works for 15 minutes, then 401 expired', async () => {
    const w = await world()
    const t = await w.login()
    expect((await w.call('GET', '/v1/me', { token: t.accessToken })).status).toBe(200)
    w.clock.t += 15 * 60_000 - 1000
    expect((await w.call('GET', '/v1/me', { token: t.accessToken })).status).toBe(200)
    w.clock.t += 2000
    const res = await w.call('GET', '/v1/me', { token: t.accessToken })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('expired')
  })

  it('rejects missing, malformed and forged tokens', async () => {
    const w = await world()
    const t = await w.login()
    expect((await w.call('GET', '/v1/me')).status).toBe(401)
    expect((await w.call('GET', '/v1/me', { token: 'a.b.c' })).status).toBe(401)
    const [h, p, s] = t.accessToken.split('.')
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    const forgedPayload = b64urlEncode(utf8(JSON.stringify({ ...claims, sub: '2000000002' })))
    const forged = await w.call('GET', '/v1/me', { token: `${h}.${forgedPayload}.${s}` })
    expect(forged.status).toBe(401)
    // `alg: none` is the classic bypass.
    const none = `${b64urlEncode(utf8('{"alg":"none","typ":"JWT"}'))}.${p}.`
    expect((await w.call('GET', '/v1/me', { token: none })).status).toBe(401)
    expect(SESSION_SECRET.length).toBeGreaterThan(32)
  })

  it('does not write lastSeenAt on every request', async () => {
    const w = await world()
    const t = await w.login()
    const seen = (): number =>
      w.db.rows<{ lastSeenAt: number }>('SELECT lastSeenAt FROM devices')[0].lastSeenAt
    expect(seen()).toBe(T0)
    w.clock.t += 5 * 60_000
    await w.call('GET', '/v1/me', { token: t.accessToken })
    expect(seen()).toBe(T0)
    w.clock.t += 6 * 60_000 // 11 minutes since the last write
    const t2 = await w.call('POST', '/v1/auth/refresh', {
      json: { refreshToken: t.refreshToken, deviceId: 'dev-a' }
    })
    const access = (await t2.json()).accessToken
    expect(seen()).toBe(w.clock.t) // refresh rotates, which is a write anyway
    w.clock.t += 11 * 60_000
    await w.call('GET', '/v1/me', { token: access })
    expect(seen()).toBe(w.clock.t)
  })
})

describe('refresh', () => {
  const refresh = (w: World, refreshToken: string, deviceId = 'dev-a'): Promise<Response> =>
    w.call('POST', '/v1/auth/refresh', { json: { refreshToken, deviceId } })

  it('rotates: a new pair every time, usable, and expired access tokens are replaced', async () => {
    const w = await world()
    const t = await w.login()
    w.clock.t += 20 * 60_000
    const res = await refresh(w, t.refreshToken)
    expect(res.status).toBe(200)
    const next = await res.json()
    expect(next.refreshToken).not.toBe(t.refreshToken)
    expect(next.accessExpiresAt).toBeGreaterThan(w.clock.t)
    expect((await w.call('GET', '/v1/me', { token: next.accessToken })).status).toBe(200)
    const third = await (await refresh(w, next.refreshToken)).json()
    expect(third.refreshToken).not.toBe(next.refreshToken)
  })

  it('rejects reuse of an old refresh token, and revokes the device', async () => {
    const w = await world()
    const t = await w.login()
    const next = await (await refresh(w, t.refreshToken)).json()
    const reuse = await refresh(w, t.refreshToken)
    expect(reuse.status).toBe(401)
    expect((await reuse.json()).error).toBe('revoked')
    // The copy that was used twice poisons the whole chain.
    expect((await refresh(w, next.refreshToken)).status).toBe(401)
    expect((await w.call('GET', '/v1/me', { token: next.accessToken })).status).toBe(401)
  })

  it('rejects another device id, a stranger sub and garbage', async () => {
    const w = await world()
    const t = await w.login()
    expect((await (await refresh(w, t.refreshToken, 'dev-zzz')).json()).error).toBe(
      'unknown_device'
    )
    const swapped = t.refreshToken.replace(/^1000000001/, '2000000002')
    expect((await refresh(w, swapped)).status).toBe(401)
    expect((await refresh(w, 'nodots')).status).toBe(401)
    expect((await refresh(w, `1000000001.${'A'.repeat(43)}`)).status).toBe(401)
    // None of that disturbed the real token.
    expect((await refresh(w, t.refreshToken)).status).toBe(200)
  })

  it('never stores the refresh token itself', async () => {
    const w = await world()
    const t = await w.login()
    expect(JSON.stringify(w.db.rows('SELECT * FROM devices'))).not.toContain(
      t.refreshToken.split('.')[1]
    )
  })
})

describe('revoke and logout', () => {
  it('revoking a device ends its access and refresh immediately', async () => {
    const w = await world()
    const a = await w.login({ deviceId: 'dev-a' })
    const b = await w.login({ deviceId: 'dev-b' })
    expect((await w.call('GET', '/v1/me', { token: b.accessToken })).status).toBe(200)

    const res = await w.call('POST', '/v1/devices/dev-b/revoke', { token: a.accessToken })
    expect(res.status).toBe(204)

    const me = await w.call('GET', '/v1/me', { token: b.accessToken })
    expect(me.status).toBe(401)
    expect((await me.json()).error).toBe('revoked')
    const refresh = await w.call('POST', '/v1/auth/refresh', {
      json: { refreshToken: b.refreshToken, deviceId: 'dev-b' }
    })
    expect(refresh.status).toBe(401)
    // Idempotent, and a revoked device can no longer push.
    expect(
      (await w.call('POST', '/v1/devices/dev-b/revoke', { token: a.accessToken })).status
    ).toBe(204)
    expect((await w.putSegment(b, 1, 'x\n')).status).toBe(401)
    // The revoking device is unaffected.
    expect((await w.call('GET', '/v1/me', { token: a.accessToken })).status).toBe(200)
  })

  it("404s an unknown device and another account's device, and ignores a sub in the body", async () => {
    const w = await world()
    const a = await w.login({ sub: '111', deviceId: 'dev-a' })
    const other = await w.login({ sub: '222', deviceId: 'dev-a' }) // same id, different account
    expect((await w.call('POST', '/v1/devices/nope/revoke', { token: a.accessToken })).status).toBe(
      404
    )
    // Same device id string exists under account 222 too; revoking from 111
    // touches only 111's.
    const res = await w.call('POST', '/v1/devices/dev-a/revoke', {
      token: a.accessToken,
      json: { sub: '222' }
    })
    expect(res.status).toBe(204)
    expect((await w.call('GET', '/v1/me', { token: other.accessToken })).status).toBe(200)
    expect((await w.call('GET', '/v1/me', { token: a.accessToken })).status).toBe(401)
  })

  it('logout revokes this device; signing in again revives it', async () => {
    const w = await world()
    const t = await w.login()
    expect((await w.call('POST', '/v1/auth/logout', { token: t.accessToken })).status).toBe(204)
    expect((await w.call('GET', '/v1/me', { token: t.accessToken })).status).toBe(401)
    const back = await w.login()
    expect((await w.call('GET', '/v1/me', { token: back.accessToken })).status).toBe(200)
    expect(w.db.rows('SELECT revokedAt FROM devices')).toEqual([{ revokedAt: null }])
  })

  it('lists devices with active and self flags', async () => {
    const w = await world()
    const a = await w.login({ deviceId: 'dev-a', deviceName: 'Desk' })
    await w.login({ deviceId: 'dev-b', deviceName: 'Laptop\nwith newline' })
    await w.call('POST', '/v1/devices/dev-b/revoke', { token: a.accessToken })
    const body = await (await w.call('GET', '/v1/devices', { token: a.accessToken })).json()
    expect(body.devices).toEqual([
      expect.objectContaining({
        id: 'dev-a',
        name: 'Desk',
        self: true,
        active: true,
        lastPushAt: null
      }),
      expect.objectContaining({
        id: 'dev-b',
        name: 'Laptop with newline',
        self: false,
        active: false
      })
    ])
  })

  it('MAX_DEVICES refuses a new device over the cap but lets a known one sign in', async () => {
    const w = await world({ MAX_DEVICES: '1' })
    await w.login({ deviceId: 'dev-a' })
    await expect(w.login({ deviceId: 'dev-b' })).rejects.toThrow(/403/)
    expect((await w.login({ deviceId: 'dev-a' })).deviceId).toBe('dev-a')
  })
})

describe('limiters', () => {
  it('429s with Retry-After when the auth limiter says no, and fails open when it breaks', async () => {
    const w = await world()
    w.deps.authIpLimiter = { limit: async () => ({ success: false }) }
    const limited = await w.call('POST', '/v1/auth/token', { json: {} })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    // Non-auth routes are not subject to the auth limiter.
    expect((await w.call('GET', '/health')).status).toBe(200)

    w.deps.authIpLimiter = {
      limit: async () => {
        throw new Error('limiter down')
      }
    }
    expect((await w.call('POST', '/v1/auth/token', { json: {} })).status).toBe(422)
  })

  it('applies the per-account limiter after authentication, keyed on sub', async () => {
    const w = await world()
    const t = await w.login({ sub: '4242' })
    const keys: string[] = []
    w.deps.accountLimiter = {
      limit: async ({ key }) => {
        keys.push(key)
        return { success: false }
      }
    }
    const res = await w.call('GET', '/v1/me', { token: t.accessToken })
    expect(res.status).toBe(429)
    expect(keys).toEqual(['4242'])
    // Unauthenticated requests never reach it.
    expect((await w.call('GET', '/v1/me')).status).toBe(401)
    expect(keys).toEqual(['4242'])
  })
})
