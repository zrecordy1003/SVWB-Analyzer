/**
 * The behaviour around a sync: turning it on, the first-login question, backups
 * and going back, and how failures are reported.
 *
 * The cloud is the fake from `tests/helpers/syncMachine.ts` and the session is a
 * stub, so what is being tested is `SyncService`'s decisions, not HTTP. (HTTP and
 * the loopback are in `syncAuth.test.ts`.)
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GoogleSession } from '../../src/main/sync/google'
import type { Credentials } from '../../src/main/sync/credentials'
import { SyncService } from '../../src/main/sync/service'
import { SyncError } from '../../src/main/sync/transport'
import { listBackups } from '../../src/main/sync/lifecycle'
import {
  Cloud,
  addDeck,
  addMatch,
  addTag,
  createMachine,
  dump,
  type Machine
} from '../helpers/syncMachine'

const machines: Machine[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const m of machines.splice(0)) await m.close()
})

interface Rig {
  m: Machine
  cloud: Cloud
  service: SyncService
  session: {
    creds: Credentials | null
    forgotten: boolean
    signInAs: string
  }
  restored: number
  changed: number
  clock: { now: number }
}

async function rig(name: string, cloud = new Cloud(), email = 'me@example.com'): Promise<Rig> {
  const m = await createMachine(name)
  machines.push(m)
  const r: Rig = {
    m,
    cloud,
    service: undefined as never,
    session: { creds: null, forgotten: false, signInAs: email },
    restored: 0,
    changed: 0,
    clock: { now: 2_000_000_000_000 }
  }
  const session = {
    credentials: async () => r.session.creds,
    isSignedIn: async () => r.session.creds !== null,
    signIn: async () => {
      r.session.creds = {
        refreshToken: 'REFRESH-SECRET-TOKEN',
        email: r.session.signInAs,
        name: null,
        deviceId: m.deviceId
      }
      return r.session.creds
    },
    signOut: async () => {
      r.session.creds = null
    },
    forget: async () => {
      r.session.creds = null
      r.session.forgotten = true
    },
    request: async () => new Response('{}', { status: 200 })
  }
  r.service = new SyncService({
    db: () => m.db,
    session: session as unknown as GoogleSession,
    backend: async () => cloud.transportFor(m.deviceId),
    backupDir: () => path.join(m.dir, 'sync-backup'),
    configured: () => true,
    memoryOnlyCredentials: () => false,
    notifyChanged: () => {
      r.changed++
    },
    afterRestore: async () => {
      r.restored++
    },
    now: () => r.clock.now
  })
  return r
}

describe('turning it on', () => {
  it('signing in does not start syncing by itself on a machine with nothing to ask', async () => {
    const r = await rig('a')
    await addMatch(r.m)
    const result = await r.service.signIn()
    // Empty cloud: nothing to ask, so it goes straight through and uploads.
    expect(result.needsChoice).toBe(false)
    expect(result.status).toMatchObject({ signedIn: true, enabled: true, pending: 0 })
    expect(r.cloud.devices.get(r.m.deviceId)?.segments.size).toBe(1)
  })

  it('a new machine with an empty database just receives, and fetches the card pool afterwards', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m)
    await a.service.signIn()

    const b = await rig('b', cloud)
    const result = await b.service.signIn()
    expect(result.needsChoice).toBe(false)
    expect(await dump(b.m)).toEqual(await dump(a.m))
    expect(b.restored).toBe(1)
    // No backup needed: there was nothing here to lose.
    expect(await listBackups(path.join(b.m.dir, 'sync-backup'))).toHaveLength(0)
  })

  it('asks the first-login question when both sides have games, and changes nothing until answered', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m, { note: 'from a' })
    await a.service.signIn()

    const b = await rig('b', cloud)
    await addMatch(b.m, { note: 'only on b' })
    const result = await b.service.signIn()
    expect(result).toMatchObject({ needsChoice: true })
    expect(result.status.enabled).toBe(false)
    expect(await b.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(1)
    expect(cloud.devices.get(b.m.deviceId)).toBeUndefined()
  })

  it('"merge" keeps both, uploads this machine\'s, and backs up first', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m, { note: 'from a' })
    await a.service.signIn()

    const b = await rig('b', cloud)
    await addMatch(b.m, { note: 'only on b' })
    await b.service.signIn()
    const done = await b.service.enable('merge')
    expect(done.needsChoice).toBe(false)

    await a.service.syncNow({ manual: true })
    for (const r of [a, b]) {
      const notes = (await r.m.db.selectFrom('Match').select('note').orderBy('note').execute()).map(
        (x) => x.note
      )
      expect(notes).toEqual(['from a', 'only on b'])
    }
    const backups = await listBackups(path.join(b.m.dir, 'sync-backup'))
    expect(backups).toHaveLength(1)
    expect(backups[0].reason).toBe('before-first-sync')
  })

  it('"cloud wins" replaces this machine\'s games, backs up first, and uploads none of them', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m, { note: 'from a' })
    await a.service.signIn()

    const b = await rig('b', cloud)
    await addMatch(b.m, { note: 'b local, to be replaced' })
    await b.service.signIn()
    await b.service.enable('cloud')

    const notes = (await b.m.db.selectFrom('Match').select('note').execute()).map((x) => x.note)
    expect(notes).toEqual(['from a'])
    expect(await listBackups(path.join(b.m.dir, 'sync-backup'))).toHaveLength(1)
    expect(cloud.devices.get(b.m.deviceId)).toBeUndefined()
    expect(b.restored).toBe(1)
  })

  it('demo data on the machine does not count as "has games", and never goes up', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m, { note: 'real' })
    await a.service.signIn()

    const b = await rig('b', cloud)
    await addMatch(b.m, { source: 'demo-seed', note: 'fake' })
    const result = await b.service.signIn()
    expect(result.needsChoice).toBe(false) // nothing real to ask about
    const sent = [...(cloud.devices.get(b.m.deviceId)?.segments.values() ?? [])].join('')
    expect(sent).not.toContain('fake')
  })

  it("a different Google account starts from a clean ledger instead of reusing the old one's cursors", async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud, 'one@example.com')
    await addMatch(a.m)
    await a.service.signIn()
    const cursorsBefore = await a.m.db.selectFrom('SyncRowMeta').selectAll().execute()
    expect(cursorsBefore.length).toBeGreaterThan(0)

    await a.service.signOut()
    a.session.signInAs = 'two@example.com'
    const fresh = new Cloud()
    ;(a.service as unknown as { deps: { backend: () => unknown } }).deps.backend = async () =>
      fresh.transportFor(a.m.deviceId)
    await a.service.signIn()
    // Re-initialised against the new (empty) account: everything is queued and uploaded again.
    expect(fresh.devices.get(a.m.deviceId)?.segments.size).toBe(1)
  })
})

describe('when the cloud forgets this machine', () => {
  it('a revoked sign-in starts over: signing back in re-uploads everything', async () => {
    const r = await rig('a')
    await addMatch(r.m, { note: 'kept' })
    await r.service.signIn()
    r.cloud.down = new SyncError(401, 'revoked', 'revoked')
    await r.service.syncNow({ manual: true })
    r.cloud.down = null
    r.cloud.devices.clear() // and the account really is empty now

    await r.service.signIn()
    const sent = [...(r.cloud.devices.get(r.m.deviceId)?.segments.values() ?? [])].join('')
    expect(sent).toContain('kept')
  })
})

describe('the avatar', () => {
  it('is fetched once, handed to the renderer as a data URL, and a failure falls back to nothing', async () => {
    const r = await rig('a')
    await r.service.signIn()
    r.session.creds = {
      ...r.session.creds!,
      name: 'Me',
      picture: 'https://lh3.googleusercontent.com/a/x=s96-c'
    }

    let fetches = 0
    ;(
      r.service as unknown as { deps: { fetchAvatar: (u: string) => Promise<string | null> } }
    ).deps.fetchAvatar = async () => {
      fetches++
      return 'data:image/png;base64,AAAA'
    }
    expect(await r.service.status()).toMatchObject({
      avatar: 'data:image/png;base64,AAAA',
      displayName: 'Me'
    })
    await r.service.status()
    expect(fetches).toBe(1) // not once per status poll

    // A failing fetch is not retried on every poll either, and reads as "no picture".
    r.session.creds = { ...r.session.creds!, picture: 'https://lh3.googleusercontent.com/a/y' }
    ;(
      r.service as unknown as { deps: { fetchAvatar: () => Promise<string | null> } }
    ).deps.fetchAvatar = async () => {
      fetches++
      throw new Error('offline')
    }
    expect((await r.service.status()).avatar).toBeNull()
    await r.service.status()
    expect(fetches).toBe(2)
  })

  it('is null when the account has no picture', async () => {
    const r = await rig('a')
    await r.service.signIn()
    expect((await r.service.status()).avatar).toBeNull()
  })
})

describe('the switch', () => {
  it('changes made while it was off are sent when it is turned back on', async () => {
    const r = await rig('a')
    await r.service.signIn()
    await r.service.disable()
    const sent = (): number => r.cloud.devices.get(r.m.deviceId)?.segments.size ?? 0
    const before = sent()
    await addMatch(r.m, { note: 'made while off' })
    expect((await r.service.status()).pending).toBeGreaterThan(0)
    expect(sent()).toBe(before)

    await r.service.enable()
    expect((await r.service.status()).pending).toBe(0)
    expect(sent()).toBe(before + 1)
  })

  it('does nothing at all when signed out', async () => {
    const r = await rig('a')
    await addMatch(r.m)
    const status = await r.service.syncNow({ manual: true })
    expect(status).toMatchObject({ signedIn: false, enabled: false })
    expect(r.cloud.calls.list).toBe(0)
  })
})

describe('when it goes wrong', () => {
  it('a server that says go away is a quiet back-off, and automatic rounds respect it', async () => {
    const r = await rig('a')
    await r.service.signIn()
    await addMatch(r.m)
    r.cloud.down = new SyncError(503, 'unavailable', 'later', 600)
    const status = await r.service.syncNow({ manual: true })
    expect(status.backoffUntil).toBe(r.clock.now + 600_000)
    expect(status.lastError).toContain('暫時不可用')

    r.cloud.down = null
    r.clock.now += 5 * 60_000 + 1
    const callsBefore = r.cloud.calls.list
    await (r.service as unknown as { round(manual: boolean): Promise<unknown> }).round(false)
    expect(r.cloud.calls.list).toBe(callsBefore) // still inside the back-off

    r.clock.now += 600_000
    await (r.service as unknown as { round(manual: boolean): Promise<unknown> }).round(false)
    expect(r.cloud.calls.list).toBeGreaterThan(callsBefore)
    expect((await r.service.status()).backoffUntil).toBeNull()
  })

  it('automatic rounds are never closer together than the minimum gap; a manual one ignores it', async () => {
    const r = await rig('a')
    await r.service.signIn()
    const round = (manual: boolean) =>
      (r.service as unknown as { round(manual: boolean): Promise<unknown> }).round(manual)
    r.clock.now += 6 * 60_000
    await round(false)
    const after = r.cloud.calls.list
    r.clock.now += 60_000
    await round(false)
    expect(r.cloud.calls.list).toBe(after)
    await round(true)
    expect(r.cloud.calls.list).toBe(after + 1)
  })

  it('a revoked sign-in turns sync off, says so, and leaves every local row alone', async () => {
    const r = await rig('a')
    await addMatch(r.m)
    await r.service.signIn()
    r.cloud.down = new SyncError(401, 'revoked', 'revoked')
    const status = await r.service.syncNow({ manual: true })
    expect(status).toMatchObject({ signedIn: false, enabled: false })
    expect(status.lastError).toContain('請重新登入')
    expect(r.session.forgotten).toBe(true)
    expect(await r.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(1)
  })

  it('a full cloud is reported plainly', async () => {
    const r = await rig('a')
    await r.service.signIn()
    await addMatch(r.m)
    r.cloud.down = new SyncError(413, 'quota', 'over')
    expect((await r.service.syncNow({ manual: true })).lastError).toContain('已滿')
  })

  it('overlapping rounds are one round', async () => {
    const r = await rig('a')
    await r.service.signIn()
    const before = r.cloud.calls.list
    await Promise.all([r.service.syncNow({ manual: true }), r.service.syncNow({ manual: true })])
    expect(r.cloud.calls.list - before).toBe(1)
  })
})

describe('going back', () => {
  it('restores the pre-merge state, turns sync off, and cannot be pointed at an arbitrary file', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m, { note: 'from a' })
    await a.service.signIn()

    const b = await rig('b', cloud)
    const mine = await addMatch(b.m, { note: 'precious local game' })
    const tag = await addTag(b.m, 'local tag')
    await b.m.db.insertInto('MatchTag').values({ matchId: mine.id, tagId: tag.id }).execute()
    const deck = await addDeck(b.m, { name: 'local deck' })
    await b.service.signIn()
    await b.service.enable('cloud') // wipes the local game

    expect((await b.m.db.selectFrom('Match').select('note').execute()).map((x) => x.note)).toEqual([
      'from a'
    ])

    const [backup] = await b.service.backups()
    const status = await b.service.rollback(backup.file)
    expect(status.enabled).toBe(false)
    const notes = (await b.m.db.selectFrom('Match').select('note').execute()).map((x) => x.note)
    expect(notes).toEqual(['precious local game'])
    expect(await b.m.db.selectFrom('Tag').select('name').execute()).toEqual([{ name: 'local tag' }])
    expect(await b.m.db.selectFrom('MatchTag').selectAll().execute()).toHaveLength(1)
    expect(await b.m.db.selectFrom('Deck').select('uid').execute()).toEqual([{ uid: deck.uid }])
    // The restore is not itself a change to upload.
    expect((await b.service.status()).pending).toBe(0)
    expect(b.changed).toBeGreaterThan(0)

    await expect(b.service.rollback(path.join(b.m.dir, 'app.db'))).rejects.toThrow(
      'not a sync backup'
    )
  })

  it('keeps only the last three backups', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m)
    await a.service.signIn()
    const b = await rig('b', cloud)
    await addMatch(b.m)
    const { backUp } = await import('../../src/main/sync/lifecycle')
    const dir = path.join(b.m.dir, 'sync-backup')
    for (let i = 0; i < 5; i++) {
      await backUp(b.m.db, dir, `n${i}`)
      await new Promise((res) => setTimeout(res, 3))
    }
    const kept = await listBackups(dir)
    expect(kept).toHaveLength(3)
    expect(kept.map((k) => k.reason)).toEqual(['n4', 'n3', 'n2'])
  })
})

describe('the safety net under every merge', () => {
  it('copies the database before remote changes are applied - once per gap, and never when there is nothing to apply', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await a.service.signIn()
    const b = await rig('b', cloud)
    await b.service.signIn()
    const dir = path.join(b.m.dir, 'sync-backup')
    const count = async (): Promise<number> =>
      (await listBackups(dir)).filter((x) => x.reason === 'before-apply').length

    // Nothing from anyone yet: no apply, no copy.
    await b.service.syncNow({ manual: true })
    expect(await count()).toBe(0)

    await addMatch(a.m, { note: 'one' })
    a.clock.now += 7 * 3600_000
    await a.service.syncNow({ manual: true })
    b.clock.now += 7 * 3600_000
    await b.service.syncNow({ manual: true })
    expect(await count()).toBe(1)

    // Another apply soon after: already covered by the recent copy.
    await addMatch(a.m, { note: 'two' })
    a.clock.now += 10 * 60_000
    await a.service.syncNow({ manual: true })
    b.clock.now += 10 * 60_000
    await b.service.syncNow({ manual: true })
    expect(await count()).toBe(1)

    // Long after, another.
    await addMatch(a.m, { note: 'three' })
    a.clock.now += 7 * 3600_000
    await a.service.syncNow({ manual: true })
    b.clock.now += 7 * 3600_000
    await b.service.syncNow({ manual: true })
    expect(await count()).toBe(2)
  })

  it('rolling copies never push out the one taken before the first merge', async () => {
    const cloud = new Cloud()
    const a = await rig('a', cloud)
    await addMatch(a.m)
    await a.service.signIn()
    const b = await rig('b', cloud)
    await addMatch(b.m)
    await b.service.signIn()
    await b.service.enable('merge') // takes before-first-sync
    const { backUp } = await import('../../src/main/sync/lifecycle')
    const dir = path.join(b.m.dir, 'sync-backup')
    for (let i = 0; i < 6; i++) {
      await backUp(b.m.db, dir, 'before-apply')
      await new Promise((res) => setTimeout(res, 3))
    }
    const kept = await listBackups(dir)
    expect(kept.filter((x) => x.reason === 'before-first-sync')).toHaveLength(1)
    expect(kept.filter((x) => x.reason === 'before-apply')).toHaveLength(2)
  })
})

describe('what must never be in the database or on the wire', () => {
  it('the refresh token is nowhere in the database file; the telemetry install id is nowhere in what is uploaded', async () => {
    const r = await rig('a')
    await addMatch(r.m)
    await r.m.db
      .insertInto('TelemetryState')
      .values({ key: 'installId', value: 'INSTALL-ID-1234', updatedAt: 1 })
      .execute()
    await r.service.signIn()

    r.m.sqlite.pragma('wal_checkpoint(TRUNCATE)')
    const dbBytes = (await fs.readFile(path.join(r.m.dir, 'app.db'))).toString('latin1')
    expect(dbBytes).not.toContain('REFRESH-SECRET-TOKEN')

    const uploaded = [...(r.cloud.devices.get(r.m.deviceId)?.segments.values() ?? [])].join('\n')
    expect(uploaded.length).toBeGreaterThan(0)
    expect(uploaded).not.toContain('INSTALL-ID-1234')
    expect(uploaded).not.toContain('REFRESH-SECRET-TOKEN')
    // And the sync device id is its own thing, not the install id.
    expect(r.m.deviceId).not.toContain('INSTALL')
  })
})
