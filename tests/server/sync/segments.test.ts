/**
 * The data plane and the policies around it: segments, snapshots, quota,
 * rounds, isolation, kill switch, deletion, export.
 */
import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../../../server/sync/src/jwt'
import { change, segmentText, world, T0, type Tokens, type World } from './helpers'

const bearer = (t: Tokens): { token: string } => ({ token: t.accessToken })

async function list(w: World, t: Tokens): Promise<Response> {
  return w.call('GET', '/v1/segments', bearer(t))
}

async function putSnapshot(
  w: World,
  t: Tokens,
  upTo: number | string,
  text: string
): Promise<Response> {
  return w.call('PUT', `/v1/snapshot?upToSeq=${upTo}`, { ...bearer(t), body: text })
}

describe('PUT /v1/segments/{seq}', () => {
  it('stores the bytes under a key the server built, and reports bytesUsed', async () => {
    const w = await world()
    const t = await w.login()
    const text = segmentText('dev-a', 1, [change('Match', 'm1', 10)])
    const res = await w.putSegment(t, 1, text)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytesUsed: text.length })
    expect(w.bucket.keys()).toEqual(['users/1000000001/devices/dev-a/000001.jsonl'])
    expect(w.db.rows('SELECT lastPushAt, maxSeq, schemaVersion FROM devices')).toEqual([
      { lastPushAt: T0, maxSeq: 1, schemaVersion: 18 }
    ])
  })

  it('is idempotent for the same hash and 409s on a different one', async () => {
    const w = await world()
    const t = await w.login()
    const text = segmentText('dev-a', 1, [change('Match', 'm1', 10)])
    const first = await w.putSegment(t, 1, text)
    const again = await w.putSegment(t, 1, text)
    expect(again.status).toBe(200)
    // The retry did not count the bytes twice.
    expect(await again.json()).toEqual(await first.json())

    const other = await w.putSegment(t, 1, segmentText('dev-a', 1, [change('Match', 'm2', 11)]))
    expect(other.status).toBe(409)
    expect((await other.json()).error).toBe('conflict')
    // ...and did not replace what was stored.
    const got = await w.call('GET', '/v1/segments/dev-a/1', bearer(t))
    expect(await got.text()).toBe(text)
  })

  it('heals an index row whose object never made it to R2', async () => {
    const w = await world()
    const t = await w.login()
    const text = segmentText('dev-a', 1)
    await w.putSegment(t, 1, text)
    w.bucket.store.clear() // the crash between the index row and the put
    expect((await w.call('GET', '/v1/segments/dev-a/1', bearer(t))).status).toBe(404)
    expect((await w.putSegment(t, 1, text)).status).toBe(200)
    expect((await w.call('GET', '/v1/segments/dev-a/1', bearer(t))).status).toBe(200)
  })

  it('rejects a missing, malformed or wrong X-Content-SHA256 with 422', async () => {
    const w = await world()
    const t = await w.login()
    const put = (headers: Record<string, string>): Promise<Response> =>
      w.call('PUT', '/v1/segments/1', { ...bearer(t), body: 'hello\n', headers })
    expect((await put({})).status).toBe(422)
    expect((await put({ 'x-content-sha256': 'abc' })).status).toBe(422)
    expect((await put({ 'x-content-sha256': 'a'.repeat(64) })).status).toBe(422)
    expect(w.bucket.keys()).toEqual([])
    expect(w.db.rows('SELECT bytesUsed FROM accounts')).toEqual([{ bytesUsed: 0 }])
  })

  it('rejects an empty body and out-of-range seq', async () => {
    const w = await world()
    const t = await w.login()
    expect((await w.putSegment(t, 1, '')).status).toBe(422)
    for (const seq of ['-1', '1000000', 'abc', '1.5']) {
      const res = await w.call('PUT', `/v1/segments/${seq}`, {
        ...bearer(t),
        body: 'x\n',
        headers: { 'x-content-sha256': await sha256Hex('x\n') }
      })
      expect(res.status).toBe(422)
    }
  })

  it('413 too_large above 1 MB, and the limit is inclusive of 1 MB itself', async () => {
    const w = await world()
    const t = await w.login()
    const exactly = 'a'.repeat(1024 * 1024 - 1) + '\n'
    expect((await w.putSegment(t, 1, exactly)).status).toBe(200)
    const over = await w.putSegment(t, 2, exactly + 'x')
    expect(over.status).toBe(413)
    expect((await over.json()).error).toBe('too_large')
    expect(w.db.rows('SELECT bytesUsed FROM accounts')).toEqual([{ bytesUsed: 1024 * 1024 }])
  })

  it('413 quota once the account is full, without storing or counting the refused push', async () => {
    const w = await world({ QUOTA_BYTES: '100' })
    const t = await w.login()
    const sixty = 'x'.repeat(59) + '\n'
    expect((await w.putSegment(t, 1, sixty)).status).toBe(200)
    const res = await w.putSegment(t, 2, sixty)
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('quota')
    expect(w.db.rows('SELECT seq FROM segments')).toEqual([{ seq: 1 }])
    expect(w.db.rows('SELECT bytesUsed FROM accounts')).toEqual([{ bytesUsed: 60 }])
    expect(w.bucket.keys()).toHaveLength(1)
    // A smaller one still fits.
    expect((await w.putSegment(t, 3, 'y'.repeat(39) + '\n')).status).toBe(200)
  })

  it('releases the reservation when R2 fails, and a retry then succeeds', async () => {
    const w = await world()
    const t = await w.login()
    const text = segmentText('dev-a', 1)
    w.bucket.failNextPut = true
    expect((await w.putSegment(t, 1, text)).status).toBe(500)
    expect(w.db.rows('SELECT COUNT(*) AS n FROM segments')[0]).toEqual({ n: 0 })
    expect(w.db.rows('SELECT bytesUsed FROM accounts')).toEqual([{ bytesUsed: 0 }])
    expect((await w.putSegment(t, 1, text)).status).toBe(200)
  })

  it("refuses a seq already folded into this device's snapshot", async () => {
    const w = await world()
    const t = await w.login()
    await w.putSegment(t, 1, segmentText('dev-a', 1))
    await putSnapshot(w, t, 1, segmentText('dev-a', 1))
    const res = await w.putSegment(t, 1, segmentText('dev-a', 1, [change('Match', 'm', 5)]))
    expect(res.status).toBe(409)
  })
})

describe('GET /v1/segments', () => {
  it('lists other devices only, not the caller, with sizes and schema versions', async () => {
    const w = await world()
    const a = await w.login({ deviceId: 'dev-a' })
    const b = await w.login({ deviceId: 'dev-b' })
    const sa = segmentText('dev-a', 1, [change('Match', 'm1', 10)])
    const sb = segmentText('dev-b', 1)
    await w.putSegment(a, 1, sa)
    await w.putSegment(a, 2, segmentText('dev-a', 2))
    await w.putSegment(b, 1, sb)

    const fromB = await (await list(w, b)).json()
    expect(fromB.devices).toEqual([
      {
        device: 'dev-a',
        retired: false,
        schemaVersion: 18,
        snapshot: null,
        segments: [
          { seq: 1, bytes: sa.length },
          { seq: 2, bytes: segmentText('dev-a', 2).length }
        ]
      }
    ])
    const fromA = await (await list(w, a)).json()
    expect(fromA.devices.map((d: { device: string }) => d.device)).toEqual(['dev-b'])
  })

  it('omits segments covered by the snapshot, and reports the snapshot', async () => {
    const w = await world()
    const a = await w.login({ deviceId: 'dev-a' })
    const b = await w.login({ deviceId: 'dev-b' })
    for (const seq of [1, 2, 3]) await w.putSegment(a, seq, segmentText('dev-a', seq))
    const snap = segmentText('dev-a', 2, [change('Match', 'm', 1)])
    await putSnapshot(w, a, 2, snap)
    await w.putSegment(a, 4, segmentText('dev-a', 4))

    const body = await (await list(w, b)).json()
    expect(body.devices[0].snapshot).toEqual({ upToSeq: 2, bytes: snap.length })
    expect(body.devices[0].segments.map((s: { seq: number }) => s.seq)).toEqual([3, 4])
  })

  it('lists a device that has pushed nothing, with an empty set', async () => {
    const w = await world()
    await w.login({ deviceId: 'dev-a' })
    const b = await w.login({ deviceId: 'dev-b' })
    expect((await (await list(w, b)).json()).devices).toEqual([
      { device: 'dev-a', retired: false, schemaVersion: null, snapshot: null, segments: [] }
    ])
  })

  it('counts a round, and 429s with Retry-After when the day is spent', async () => {
    const w = await world({ ROUNDS_PER_DAY: '3' })
    const t = await w.login()
    for (let i = 0; i < 3; i++) expect((await list(w, t)).status).toBe(200)
    const spent = await list(w, t)
    expect(spent.status).toBe(429)
    expect((await spent.json()).error).toBe('rate_limited')
    // Until the next UTC midnight: T0 is 12:00, so 12 hours.
    expect(spent.headers.get('retry-after')).toBe(String(12 * 3600))
    // Other endpoints are not rounds.
    expect((await w.call('GET', '/v1/devices', bearer(t))).status).toBe(200)

    const me = await (await w.call('GET', '/v1/me', bearer(t))).json()
    expect(me.syncRoundsToday).toBe(3)
    expect(me.roundsPerDay).toBe(3)

    w.clock.t += 13 * 3600_000 // past midnight UTC
    const fresh = await w.login() // the 15-minute token has long expired
    expect((await list(w, fresh)).status).toBe(200)
    expect((await (await w.call('GET', '/v1/me', bearer(fresh))).json()).syncRoundsToday).toBe(1)
  })

  it('does not let parallel rounds overshoot the limit', async () => {
    const w = await world({ ROUNDS_PER_DAY: '5' })
    const t = await w.login()
    const results = await Promise.all(Array.from({ length: 12 }, () => list(w, t)))
    expect(results.filter((r) => r.status === 200)).toHaveLength(5)
    expect(results.filter((r) => r.status === 429)).toHaveLength(7)
  })
})

describe('downloads', () => {
  it("serves another device's segment and snapshot byte for byte", async () => {
    const w = await world()
    const a = await w.login({ deviceId: 'dev-a' })
    const b = await w.login({ deviceId: 'dev-b' })
    const seg = segmentText('dev-a', 3, [change('Tag', 't1', 7)])
    const snap = segmentText('dev-a', 2, [change('Match', 'm', 1)])
    await w.putSegment(a, 3, seg)
    await putSnapshot(w, a, 2, snap)

    const s = await w.call('GET', '/v1/segments/dev-a/3', bearer(b))
    expect(s.status).toBe(200)
    expect(s.headers.get('content-type')).toBe('application/x-ndjson')
    expect(await s.text()).toBe(seg)
    const p = await w.call('GET', '/v1/snapshots/dev-a', bearer(b))
    expect(await p.text()).toBe(snap)
  })

  it('404s what does not exist', async () => {
    const w = await world()
    const a = await w.login()
    expect((await w.call('GET', '/v1/segments/dev-a/9', bearer(a))).status).toBe(404)
    expect((await w.call('GET', '/v1/snapshots/dev-a', bearer(a))).status).toBe(404)
    expect((await w.call('GET', '/v1/segments/nobody/1', bearer(a))).status).toBe(404)
    expect((await w.call('GET', '/v1/nope', bearer(a))).status).toBe(404)
  })
})

describe('isolation between accounts', () => {
  it("account B cannot read A's device, segment or snapshot: 404, same as nonexistent", async () => {
    const w = await world()
    const a = await w.login({ sub: '111', deviceId: 'dev-a' })
    const b = await w.login({ sub: '222', deviceId: 'dev-b' })
    await w.putSegment(a, 1, segmentText('dev-a', 1))
    await putSnapshot(w, a, 1, segmentText('dev-a', 1))

    const seg = await w.call('GET', '/v1/segments/dev-a/1', bearer(b))
    expect(seg.status).toBe(404)
    const snap = await w.call('GET', '/v1/snapshots/dev-a', bearer(b))
    expect(snap.status).toBe(404)
    // Indistinguishable from a device that never existed.
    const ghost = await w.call('GET', '/v1/segments/dev-ghost/1', bearer(b))
    expect(await seg.json()).toEqual(await ghost.json())
    expect((await (await list(w, b)).json()).devices).toEqual([])
    expect((await (await w.call('GET', '/v1/devices', bearer(b))).json()).devices).toHaveLength(1)
  })

  it('two accounts may use the same device id and segment numbers without touching', async () => {
    const w = await world()
    const a = await w.login({ sub: '111', deviceId: 'dev-x' })
    const b = await w.login({ sub: '222', deviceId: 'dev-x' })
    expect((await w.putSegment(a, 1, 'from-a\n')).status).toBe(200)
    expect((await w.putSegment(b, 1, 'from-b\n')).status).toBe(200)
    expect(w.bucket.keys()).toEqual([
      'users/111/devices/dev-x/000001.jsonl',
      'users/222/devices/dev-x/000001.jsonl'
    ])
    const other = await w.login({ sub: '111', deviceId: 'dev-y' })
    expect(await (await w.call('GET', '/v1/segments/dev-x/1', bearer(other))).text()).toBe(
      'from-a\n'
    )
  })

  it("the prefix is always the token's sub, whatever the body or path says", async () => {
    const w = await world()
    const a = await w.login({ sub: '111', deviceId: 'dev-a' })
    const lying = segmentText('dev-a', 1, [
      { sub: '222', device: 'dev-zzz', tbl: 'T', uid: 'u', ts: 1 }
    ])
    await w.putSegment(a, 1, lying)
    const res = await w.call('PUT', '/v1/segments/2?sub=222&device=dev-zzz', {
      ...bearer(a),
      body: 'x\n',
      headers: { 'x-content-sha256': await sha256Hex('x\n'), 'x-sub': '222' }
    })
    expect(res.status).toBe(200)
    expect(w.bucket.keys()).toEqual([
      'users/111/devices/dev-a/000001.jsonl',
      'users/111/devices/dev-a/000002.jsonl'
    ])
    // A traversal-shaped device id never reaches storage.
    const evil = await w.call('GET', '/v1/segments/..%2F..%2F222%2Fdevices%2Fx/1', bearer(a))
    expect(evil.status).toBe(404)
  })
})

describe('PUT /v1/snapshot', () => {
  it('replaces the snapshot and deletes the segments it covers, in R2 and in the index', async () => {
    const w = await world()
    const a = await w.login()
    for (const seq of [1, 2, 3]) await w.putSegment(a, seq, segmentText('dev-a', seq))
    const snap = segmentText('dev-a', 2, [change('Match', 'm', 1)])
    const res = await putSnapshot(w, a, 2, snap)
    expect(res.status).toBe(200)

    expect(w.bucket.keys()).toEqual([
      'users/1000000001/devices/dev-a/000003.jsonl',
      'users/1000000001/devices/dev-a/snapshot.jsonl'
    ])
    expect(w.db.rows('SELECT seq FROM segments')).toEqual([{ seq: 3 }])
    const expected = snap.length + segmentText('dev-a', 3).length
    expect(await res.json()).toEqual({ bytesUsed: expected })

    // A second snapshot replaces the first and frees ITS bytes too.
    const snap2 = segmentText('dev-a', 3, [change('Match', 'm', 2)])
    const res2 = await putSnapshot(w, a, 3, snap2)
    expect(await res2.json()).toEqual({ bytesUsed: snap2.length })
    expect(w.bucket.keys()).toEqual(['users/1000000001/devices/dev-a/snapshot.jsonl'])
    expect(w.db.rows('SELECT bytesUsed FROM accounts')).toEqual([{ bytesUsed: snap2.length }])
  })

  it('refuses to move upToSeq backwards, and requires it', async () => {
    const w = await world()
    const a = await w.login()
    await putSnapshot(w, a, 5, segmentText('dev-a', 5))
    expect((await putSnapshot(w, a, 4, segmentText('dev-a', 4))).status).toBe(409)
    expect((await putSnapshot(w, a, 5, segmentText('dev-a', 5))).status).toBe(200)
    expect((await w.call('PUT', '/v1/snapshot', { ...bearer(a), body: 'x\n' })).status).toBe(422)
    expect((await putSnapshot(w, a, 'abc', 'x\n')).status).toBe(422)
  })

  it('413 too_large above 8 MB', async () => {
    const w = await world()
    const a = await w.login()
    const ok = 'a'.repeat(8 * 1024 * 1024 - 1) + '\n'
    expect((await putSnapshot(w, a, 1, ok)).status).toBe(200)
    const res = await putSnapshot(w, a, 2, ok + 'x')
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('too_large')
  })

  it('413 quota when the snapshot would not fit, leaving the old state intact', async () => {
    const w = await world({ QUOTA_BYTES: '200' })
    const a = await w.login()
    await w.putSegment(a, 1, 'a'.repeat(99) + '\n')
    const res = await putSnapshot(w, a, 0, 'b'.repeat(149) + '\n') // covers nothing: 100 + 150 > 200
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('quota')
    expect(w.bucket.keys()).toHaveLength(1)
    // Compacting seq 1 into a smaller snapshot frees more than it adds, so it fits.
    expect((await putSnapshot(w, a, 1, 'c'.repeat(49) + '\n')).status).toBe(200)
  })
})

describe('kill switch', () => {
  it('503s with Retry-After everywhere except /auth/*, /v1/auth/* and /health', async () => {
    const w = await world()
    const t = await w.login()
    w.deps.config.killSwitch = true

    for (const [method, path] of [
      ['GET', '/v1/me'],
      ['GET', '/v1/segments'],
      ['PUT', '/v1/segments/1'],
      ['GET', '/v1/devices'],
      ['POST', '/v1/account/delete']
    ]) {
      const res = await w.call(method, path, bearer(t))
      expect(res.status, `${method} ${path}`).toBe(503)
      expect(res.headers.get('retry-after')).toBe('3600')
      expect((await res.json()).error).toBe('unavailable')
    }
    // Rejecting is free: not even a round was counted.
    expect(w.db.rows('SELECT COUNT(*) AS n FROM rounds')[0]).toEqual({ n: 0 })

    expect((await w.call('GET', '/health')).status).toBe(200)
    const start = await w.call(
      'GET',
      '/auth/start?port=48151&challenge=' + 'A'.repeat(43) + '&state=s'
    )
    expect(start.status).toBe(302)
    // A whole login still completes while the switch is on.
    const again = await w.login({ deviceId: 'dev-new' })
    expect(again.deviceId).toBe('dev-new')
    expect(
      (
        await w.call('POST', '/v1/auth/refresh', {
          json: { refreshToken: again.refreshToken, deviceId: 'dev-new' }
        })
      ).status
    ).toBe(200)

    w.deps.config.killSwitch = false
    expect((await w.call('GET', '/v1/me', bearer(t))).status).toBe(200)
  })

  it('is read from the Worker var', async () => {
    const w = await world({ KILL_SWITCH: '1' })
    expect((await w.call('GET', '/v1/me')).status).toBe(503)
  })
})

describe('account deletion', () => {
  it('wipes the R2 prefix (including orphans and across list pages) and every D1 row', async () => {
    const w = await world()
    const a = await w.login({ sub: '111', deviceId: 'dev-a' })
    const a2 = await w.login({ sub: '111', deviceId: 'dev-b' })
    const other = await w.login({ sub: '222', deviceId: 'dev-c' })
    for (const seq of [1, 2, 3]) await w.putSegment(a, seq, segmentText('dev-a', seq))
    await w.putSegment(a2, 1, segmentText('dev-b', 1))
    await putSnapshot(w, a, 1, segmentText('dev-a', 1))
    await w.putSegment(other, 1, segmentText('dev-c', 1))
    // An object the index does not know about: a push that crashed.
    await w.bucket.put('users/111/devices/dev-a/000099.jsonl', new Uint8Array([1]))
    // A neighbour whose sub merely STARTS with ours must survive.
    await w.bucket.put('users/1110/devices/x/000001.jsonl', new Uint8Array([1]))
    w.bucket.pageSize = 2
    await w.call('GET', '/v1/segments', bearer(a)) // a round, to give `rounds` a row

    const res = await w.call('POST', '/v1/account/delete', { ...bearer(a), json: { sub: '222' } })
    expect(res.status).toBe(204)

    expect(w.bucket.keys()).toEqual([
      'users/1110/devices/x/000001.jsonl',
      'users/222/devices/dev-c/000001.jsonl'
    ])
    for (const table of ['segments', 'devices', 'rounds']) {
      expect(w.db.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE sub = '111'`)[0]).toEqual({ n: 0 })
    }
    expect(w.db.rows('SELECT sub FROM accounts')).toEqual([{ sub: '222' }])
    expect(w.db.rows('SELECT COUNT(*) AS n FROM devices WHERE sub = ?', '222')[0]).toEqual({ n: 1 })
    expect(w.bucket.listCalls).toBeGreaterThan(1)

    // Every token for that account is dead at once, both devices.
    for (const t of [a, a2]) {
      expect((await w.call('GET', '/v1/me', bearer(t))).status).toBe(401)
      const refresh = await w.call('POST', '/v1/auth/refresh', {
        json: { refreshToken: t.refreshToken, deviceId: t.deviceId }
      })
      expect(refresh.status).toBe(401)
    }
    // The other account is untouched.
    expect((await w.call('GET', '/v1/me', bearer(other))).status).toBe(200)
    // Signing in again starts from nothing.
    const fresh = await w.login({ sub: '111', deviceId: 'dev-a' })
    expect((await (await w.call('GET', '/v1/me', bearer(fresh))).json()).bytesUsed).toBe(0)
  })

  it('can be repeated after a partial failure', async () => {
    const w = await world()
    const a = await w.login()
    await w.putSegment(a, 1, segmentText('dev-a', 1))
    const realDelete = w.bucket.delete.bind(w.bucket)
    w.bucket.delete = async () => {
      throw new Error('R2 down')
    }
    expect((await w.call('POST', '/v1/account/delete', bearer(a))).status).toBe(500)
    // D1 still has the account, so the person can simply press the button again.
    expect(w.db.rows('SELECT COUNT(*) AS n FROM accounts')[0]).toEqual({ n: 1 })
    w.bucket.delete = realDelete
    expect((await w.call('POST', '/v1/account/delete', bearer(a))).status).toBe(204)
    expect(w.bucket.keys()).toEqual([])
  })
})

describe('GET /v1/account/export', () => {
  it("concatenates every device's snapshot then segments, one header per part", async () => {
    const w = await world()
    const a = await w.login({ deviceId: 'dev-a' })
    const b = await w.login({ deviceId: 'dev-b' })
    const snapA = segmentText('dev-a', 1, [change('Match', 'm1', 1)])
    const seg2 = segmentText('dev-a', 2, [change('Match', 'm2', 2)])
    const segB = segmentText('dev-b', 1, [change('Tag', 't1', 3)])
    await w.putSegment(a, 1, segmentText('dev-a', 1))
    await putSnapshot(w, a, 1, snapA)
    await w.putSegment(a, 2, seg2)
    await w.putSegment(b, 1, segB)
    // A part with no trailing newline must not fuse with the next.
    await w.putSegment(b, 2, '{"v":1,"seq":2}')

    const res = await w.call('GET', '/v1/account/export', bearer(a))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const text = await res.text()
    expect(text).toBe(snapA + seg2 + segB + '{"v":1,"seq":2}\n')
    for (const line of text.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
  })

  it("exports nothing for another account's data", async () => {
    const w = await world()
    const a = await w.login({ sub: '111' })
    const b = await w.login({ sub: '222', deviceId: 'dev-b' })
    await w.putSegment(a, 1, segmentText('dev-a', 1))
    expect(await (await w.call('GET', '/v1/account/export', bearer(b))).text()).toBe('')
  })
})

describe('/v1/me and bookkeeping', () => {
  it('reports quota and device counts', async () => {
    const w = await world()
    const a = await w.login({ deviceId: 'dev-a', email: 'me@example.com', name: 'Me' })
    await w.login({ deviceId: 'dev-b' })
    await w.call('POST', '/v1/devices/dev-b/revoke', bearer(a))
    await w.putSegment(a, 1, 'abc\n')
    expect(await (await w.call('GET', '/v1/me', bearer(a))).json()).toEqual({
      email: 'player@example.com', // the second login (same sub) refreshed the stored email
      name: 'Test Player',
      bytesUsed: 4,
      quotaBytes: 100 * 1024 * 1024,
      activeDevices: 1,
      syncRoundsToday: 0,
      roundsPerDay: 200
    })
  })

  it('does not rewrite the account row when nothing about it changed', async () => {
    const w = await world()
    await w.login()
    w.db.raw.exec(
      `CREATE TABLE audit (n INTEGER); CREATE TRIGGER a AFTER UPDATE ON accounts BEGIN INSERT INTO audit VALUES (1); END;`
    )
    await w.login({ deviceId: 'dev-b' })
    expect(w.db.rows('SELECT COUNT(*) AS n FROM audit')[0]).toEqual({ n: 0 })
    await w.login({ deviceId: 'dev-c', email: 'new@example.com' })
    expect(w.db.rows('SELECT COUNT(*) AS n FROM audit')[0]).toEqual({ n: 1 })
  })
})

describe('the install id is a different system', () => {
  it('appears in no table, column, index or R2 key', async () => {
    const w = await world()
    const a = await w.login()
    await w.putSegment(a, 1, segmentText('dev-a', 1))
    await putSnapshot(w, a, 1, segmentText('dev-a', 1))

    const schema = w.db.rows<{ sql: string | null; name: string }>(
      `SELECT name, sql FROM sqlite_master`
    )
    expect(schema.length).toBeGreaterThan(4)
    for (const entry of schema) {
      expect(`${entry.name} ${entry.sql ?? ''}`).not.toMatch(/install/i)
    }
    for (const table of schema.filter((s) => s.sql?.startsWith('CREATE TABLE'))) {
      const columns = w.db.rows<{ name: string }>(`PRAGMA table_info(${table.name})`)
      for (const c of columns) expect(c.name).not.toMatch(/install/i)
    }
    for (const key of w.bucket.keys()) expect(key).not.toMatch(/install/i)
  })
})
