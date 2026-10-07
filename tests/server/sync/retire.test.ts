/**
 * The nightly job: retire devices idle for 90 days, folding their log into one
 * snapshot, without making their data unreachable.
 */
import { describe, expect, it } from 'vitest'

import { DAY, change, segmentText, world, type Tokens, type World } from './helpers'

const bearer = (t: Tokens): { token: string } => ({ token: t.accessToken })

async function twoDevices(w: World): Promise<{ old: Tokens; fresh: Tokens }> {
  const old = await w.login({ deviceId: 'dev-old' })
  const fresh = await w.login({ deviceId: 'dev-new' })
  return { old, fresh }
}

/** A newer token for a device, since 90 days is longer than 15 minutes. */
async function relogin(w: World, deviceId: string): Promise<Tokens> {
  return w.login({ deviceId })
}

describe('retireIdleDevices', () => {
  it('folds an idle device into one snapshot, keeps it listed as retired, and frees space', async () => {
    const w = await world()
    const { old } = await twoDevices(w)
    const s1 = segmentText('dev-old', 1, [change('Match', 'm1', 10), change('Match', 'm2', 11)])
    const s2 = segmentText('dev-old', 2, [change('Match', 'm1', 20, { row: { n: 'newer' } })])
    await w.putSegment(old, 1, s1)
    await w.putSegment(old, 2, s2)

    w.clock.t += 91 * DAY
    const report = await w.retire()
    expect(report).toMatchObject({ retired: 2, folded: 1 })

    // One snapshot, no segments, in R2 and in the index.
    expect(w.bucket.keys()).toEqual(['users/1000000001/devices/dev-old/snapshot.jsonl'])
    expect(w.db.rows('SELECT COUNT(*) AS n FROM segments')[0]).toEqual({ n: 0 })
    expect(
      w.db.rows("SELECT snapshotSeq, retiredAt IS NOT NULL AS r FROM devices WHERE id = 'dev-old'")
    ).toEqual([{ snapshotSeq: 2, r: 1 }])
    const used = w.db.rows<{ bytesUsed: number }>('SELECT bytesUsed FROM accounts')[0].bytesUsed
    expect(used).toBe(w.bucket.store.get('users/1000000001/devices/dev-old/snapshot.jsonl')!.length)

    // A machine that signs in afterwards still gets that data.
    const reader = await relogin(w, 'dev-reader')
    const listing = await (await w.call('GET', '/v1/segments', bearer(reader))).json()
    const oldEntry = listing.devices.find((d: { device: string }) => d.device === 'dev-old')
    expect(oldEntry).toMatchObject({ retired: true, segments: [], snapshot: { upToSeq: 2 } })
    const snap = await (await w.call('GET', '/v1/snapshots/dev-old', bearer(reader))).text()
    const rows = snap
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(rows[0]).toMatchObject({ v: 1, device: 'dev-old', seq: 2 })
    expect(rows.slice(1).map((r) => [r.uid, r.ts])).toEqual([
      ['m2', 11],
      ['m1', 20]
    ])
  })

  it('folds an existing snapshot together with the segments after it', async () => {
    const w = await world()
    const { old } = await twoDevices(w)
    await w.putSegment(old, 1, segmentText('dev-old', 1, [change('Match', 'a', 1)]))
    await w.call('PUT', '/v1/snapshot?upToSeq=1', {
      ...bearer(old),
      body: segmentText('dev-old', 1, [change('Match', 'a', 1), change('Match', 'b', 2)])
    })
    await w.putSegment(old, 2, segmentText('dev-old', 2, [change('Match', 'b', 9)]))

    w.clock.t += 91 * DAY
    await w.retire()
    const reader = await relogin(w, 'dev-reader')
    const snap = await (await w.call('GET', '/v1/snapshots/dev-old', bearer(reader))).text()
    const rows = snap
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l))
    expect(rows.map((r) => [r.uid, r.ts])).toEqual([
      ['a', 1],
      ['b', 9]
    ])
    expect(w.db.rows("SELECT snapshotSeq FROM devices WHERE id = 'dev-old'")).toEqual([
      { snapshotSeq: 2 }
    ])
  })

  it('leaves a recently active device alone, using lastPushAt and falling back to createdAt', async () => {
    const w = await world()
    const pusher = await w.login({ deviceId: 'dev-push' })
    await w.login({ deviceId: 'dev-silent' })
    w.clock.t += 60 * DAY
    await w.putSegment(await relogin(w, 'dev-push'), 1, segmentText('dev-push', 1))
    w.clock.t += 40 * DAY // 100 days since creation, 40 since the push
    const report = await w.retire()
    // Only the one that never pushed (measured from createdAt) is retired.
    expect(w.db.rows('SELECT id, retiredAt IS NOT NULL AS r FROM devices ORDER BY id')).toEqual([
      { id: 'dev-push', r: 0 },
      { id: 'dev-silent', r: 1 }
    ])
    expect(report.retired).toBe(1)
    expect(pusher.deviceId).toBe('dev-push')
  })

  it('a retired device is refused until it signs in again, and then comes back as new', async () => {
    const w = await world()
    const { old } = await twoDevices(w)
    await w.putSegment(old, 1, segmentText('dev-old', 1, [change('Match', 'a', 1)]))
    w.clock.t += 91 * DAY
    await w.retire()

    // Its credentials are dead: the access token (long expired anyway) and the refresh.
    const refresh = await w.call('POST', '/v1/auth/refresh', {
      json: { refreshToken: old.refreshToken, deviceId: 'dev-old' }
    })
    expect(refresh.status).toBe(401)
    expect((await refresh.json()).error).toBe('retired')

    const back = await w.login({ deviceId: 'dev-old' })
    expect((await w.call('GET', '/v1/me', bearer(back))).status).toBe(200)
    expect(w.db.rows("SELECT retiredAt FROM devices WHERE id = 'dev-old'")).toEqual([
      { retiredAt: null }
    ])
    // It can push again, from after its snapshot.
    expect((await w.putSegment(back, 3, segmentText('dev-old', 3))).status).toBe(200)
    // ...and its idle clock restarted, so the very next cron leaves it be.
    w.clock.t += DAY
    await w.retire()
    expect(w.db.rows("SELECT retiredAt FROM devices WHERE id = 'dev-old'")).toEqual([
      { retiredAt: null }
    ])
  })

  it('a revived device that never pushes again is retired 90 days after it came back, not before', async () => {
    const w = await world()
    await w.login({ deviceId: 'dev-old' })
    w.clock.t += 91 * DAY
    await w.retire()
    await w.login({ deviceId: 'dev-old' })
    w.clock.t += 89 * DAY
    await w.retire()
    expect(w.db.rows('SELECT retiredAt FROM devices')).toEqual([{ retiredAt: null }])
    w.clock.t += 2 * DAY
    await w.retire()
    expect(w.db.rows('SELECT retiredAt IS NOT NULL AS r FROM devices')).toEqual([{ r: 1 }])
  })

  it('is idempotent: a second run changes nothing', async () => {
    const w = await world()
    const { old } = await twoDevices(w)
    await w.putSegment(old, 1, segmentText('dev-old', 1, [change('Match', 'a', 1)]))
    w.clock.t += 91 * DAY
    await w.retire()
    const before = JSON.stringify([w.db.rows('SELECT * FROM devices'), w.bucket.keys()])
    const second = await w.retire()
    expect(second).toMatchObject({ retired: 0, folded: 0 })
    expect(JSON.stringify([w.db.rows('SELECT * FROM devices'), w.bucket.keys()])).toBe(before)
  })

  it('never exceeds its operation budget, deferring the rest to the next night', async () => {
    const w = await world()
    for (let i = 0; i < 12; i++) {
      const t = await w.login({ deviceId: `dev-${i}` })
      for (const seq of [1, 2, 3, 4])
        await w.putSegment(t, seq, segmentText(`dev-${i}`, seq, [change('M', `u${seq}`, seq)]))
    }
    w.clock.t += 91 * DAY
    let gets = 0
    const realGet = w.bucket.get.bind(w.bucket)
    w.bucket.get = async (key) => {
      gets++
      return realGet(key)
    }
    const first = await w.retire()
    expect(first.deferred).toBeGreaterThan(0)
    expect(first.folded).toBeLessThan(12)
    expect(gets).toBeLessThanOrEqual(40)
    let nights = 1
    let last = first
    while (last.deferred > 0 && nights < 10) {
      last = await w.retire()
      nights++
    }
    expect(w.db.rows('SELECT COUNT(*) AS n FROM devices WHERE retiredAt IS NULL')[0]).toEqual({
      n: 0
    })
    expect(w.db.rows('SELECT COUNT(*) AS n FROM segments')[0]).toEqual({ n: 0 })
  })

  it('retires without folding a device too big for one run, keeping its segments readable', async () => {
    const w = await world()
    const t = await w.login({ deviceId: 'dev-big' })
    for (let seq = 1; seq <= 45; seq++) await w.putSegment(t, seq, segmentText('dev-big', seq))
    w.clock.t += 91 * DAY
    const report = await w.retire()
    expect(report).toMatchObject({ retired: 1, folded: 0, retiredUnfolded: 1 })
    expect(w.db.rows('SELECT COUNT(*) AS n FROM segments')[0]).toEqual({ n: 45 })
    const reader = await w.login({ deviceId: 'dev-reader' })
    const listing = await (await w.call('GET', '/v1/segments', bearer(reader))).json()
    expect(listing.devices[0]).toMatchObject({ device: 'dev-big', retired: true })
    expect(listing.devices[0].segments).toHaveLength(45)
  })

  it('prunes expired grants and old round counters', async () => {
    const w = await world()
    const t = await w.login()
    await w.call('GET', '/v1/segments', bearer(t))
    w.db.raw
      .prepare(
        `INSERT INTO grants (hash, sub, email, name, challenge, expiresAt) VALUES ('h','s','e',NULL,'c',?)`
      )
      .run(w.clock.t - 1)
    w.clock.t += 5 * DAY
    await w.retire()
    expect(w.db.rows('SELECT COUNT(*) AS n FROM grants')[0]).toEqual({ n: 0 })
    expect(w.db.rows('SELECT COUNT(*) AS n FROM rounds')[0]).toEqual({ n: 0 })
  })
})
