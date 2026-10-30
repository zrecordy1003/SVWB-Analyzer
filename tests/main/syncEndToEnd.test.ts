/**
 * The whole client against the fake Google, with nothing in the middle stubbed.
 *
 * `GoogleSession`, `DriveBackend` and `SyncService` are the real ones; the only
 * stand-ins are Google (OAuth and the Drive appDataFolder, `tools/sync-dev`) and
 * the browser (a function that approves the sign-in and follows the redirect to
 * the app's real loopback listener). Two machines, each a real migrated database,
 * share one Google account the way two PCs would.
 */
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DriveBackend } from '../../src/main/sync/drive'
import { syncOnce } from '../../src/main/sync/engine'
import { GoogleSession } from '../../src/main/sync/google'
import type { CredentialStore, Credentials } from '../../src/main/sync/credentials'
import { SyncService } from '../../src/main/sync/service'
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeGoogle } from '../../tools/sync-dev/fakeGoogle'
import {
  addDeck,
  addMatch,
  addTag,
  createMachine,
  dump,
  tagMatch,
  type Machine
} from '../helpers/syncMachine'

const machines: Machine[] = []
afterEach(async () => {
  for (const m of machines.splice(0)) await m.close()
})

interface Client {
  m: Machine
  session: GoogleSession
  service: SyncService
  backend: () => Promise<DriveBackend>
  store: CredentialStore & { current: Credentials | null }
  restored: number
}

async function client(
  g: FakeGoogle,
  clock: { t: number },
  name: string,
  email = 'me@example.com'
): Promise<Client> {
  const m = await createMachine(name)
  machines.push(m)
  const store = {
    current: null as Credentials | null,
    persistent: true,
    load: async () => store.current,
    save: async (c: Credentials) => {
      store.current = c
    },
    clear: async () => {
      store.current = null
    }
  }
  const session = new GoogleSession({
    config: () => ({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      endpoints: g.endpoints()
    }),
    fetch: g.fetch,
    store,
    // The browser: approve, then follow the redirect to the app's loopback listener.
    openExternal: async (url) => {
      await fetch(g.approve(url, email)).then((r) => r.text())
    },
    deviceId: async () => m.deviceId,
    now: () => clock.t
  })
  const backend = async (): Promise<DriveBackend> =>
    new DriveBackend({
      request: (url, init) => session.request(url, init),
      endpoints: g.endpoints(),
      self: { deviceId: m.deviceId, deviceName: `PC-${name}`, appVersion: '1.6.0' },
      now: () => clock.t
    })
  const c: Client = { m, session, store, backend, restored: 0, service: undefined as never }
  c.service = new SyncService({
    db: () => m.db,
    session,
    backend,
    backupDir: () => path.join(m.dir, 'sync-backup'),
    configured: () => true,
    memoryOnlyCredentials: () => false,
    notifyChanged: () => undefined,
    afterRestore: async () => {
      c.restored++
    },
    now: () => clock.t
  })
  return c
}

const world = (): { g: FakeGoogle; clock: { t: number } } => {
  const clock = { t: Date.now() }
  return { g: new FakeGoogle({ now: () => clock.t }), clock }
}

describe('two machines, one Google account', () => {
  it('records on A, restores on B, edits on B, arrives on A - through sign-in, token refresh and Drive', async () => {
    const { g, clock } = world()
    g.setProfile('me@example.com', { name: 'Me', picture: null })
    const a = await client(g, clock, 'a')
    const b = await client(g, clock, 'b')

    const tag = await addTag(a.m, '練習')
    const deck = await addDeck(a.m, { name: '妖精速攻', class: 'elf', isDefault: true })
    await a.m.db.insertInto('DeckCard').values({ deckId: deck.id, cardId: 100, count: 3 }).execute()
    const match = await addMatch(a.m, {
      my_deckId: deck.id,
      note: '好局',
      oppo_name_crop: Buffer.from([9, 8, 7, 0, 255])
    })
    await tagMatch(a.m, match.id, tag.id)

    const first = await a.service.signIn()
    expect(first).toMatchObject({ needsChoice: false })
    expect(first.status).toMatchObject({ signedIn: true, enabled: true, email: 'me@example.com' })
    expect(first.status.lastError).toBeNull()

    const second = await b.service.signIn()
    expect(second.needsChoice).toBe(false)
    expect(await dump(b.m)).toEqual(await dump(a.m))
    expect(b.restored).toBe(1)

    await b.m.db
      .updateTable('Match')
      .set({ note: '從 B 改的' })
      .where('uid', '=', match.uid)
      .execute()
    await b.service.syncNow({ manual: true })
    clock.t += 2 * 60 * 60_000 // long enough for every access token to have lapsed and been refreshed
    await a.service.syncNow({ manual: true })
    expect((await a.m.db.selectFrom('Match').select('note').executeTakeFirstOrThrow()).note).toBe(
      '從 B 改的'
    )
    expect(await dump(a.m)).toEqual(await dump(b.m))

    expect(g.tokenCalls.refresh).toBeGreaterThan(0)
    const me = await a.service.account()
    expect(me).toMatchObject({ email: 'me@example.com', name: 'Me', activeDevices: 2 })
    expect(me!.bytesUsed).toBeGreaterThan(0)
    expect((await a.service.devices()).map((d) => d.name).sort()).toEqual(['PC-a', 'PC-b'])
  })

  it("only this app's hidden folder is ever touched", async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    await addMatch(a.m, { note: 'private' })
    await a.service.signIn()
    expect(g.calls.length).toBeGreaterThan(0)
    expect(g.calls.every((c) => /\/drive\/v3\/files|\/upload\/drive\/v3\/files/.test(c))).toBe(true)
  })

  it('a different Google account cannot see any of it', async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a', 'one@example.com')
    const stranger = await client(g, clock, 'x', 'two@example.com')
    await addMatch(a.m, { note: 'private' })
    await a.service.signIn()
    await stranger.service.signIn()
    expect(await stranger.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
  })

  it('the user removing the app in their Google account signs this machine out and loses nothing locally', async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    const b = await client(g, clock, 'b')
    await addMatch(a.m)
    await a.service.signIn()
    await b.service.signIn()
    const mineOnB = await addMatch(b.m, { note: 'b only' })

    g.revokeAll('me@example.com')
    clock.t += 2 * 60 * 60_000
    const status = await b.service.syncNow({ manual: true })
    expect(status).toMatchObject({ signedIn: false, enabled: false })
    expect(status.lastError).toContain('請重新登入')
    expect(b.store.current).toBeNull()
    expect(
      await b.m.db.selectFrom('Match').select('uid').where('uid', '=', mineOnB.uid).execute()
    ).toHaveLength(1)
  })

  it("emptying the app's Drive folder, then signing in again, sends everything up again", async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    await addMatch(a.m, { note: 'kept' })
    await a.service.signIn()
    await a.service.signOut()
    g.clearDrive('me@example.com') // the user deleted the app's data in Drive

    await a.service.signIn()
    const text = g
      .filesOf('me@example.com')
      .map((f) => f.content)
      .join('')
    expect(text).toContain('kept')
  })

  it('deleting the cloud copy empties Drive, signs out and keeps every local row', async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    const b = await client(g, clock, 'b')
    await addMatch(a.m)
    await a.service.signIn()
    await b.service.signIn()
    expect(g.filesOf('me@example.com').length).toBeGreaterThan(0)

    const after = await a.service.deleteAccount()
    expect(after.signedIn).toBe(false)
    expect(g.filesOf('me@example.com')).toEqual([])
    expect(await a.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(1)

    // The grant itself was revoked, so the other machine finds out on its next round.
    clock.t += 2 * 60 * 60_000
    expect(await b.service.syncNow({ manual: true })).toMatchObject({ signedIn: false })
  })

  it('compaction through Drive: a snapshot replaces the segments and a fresh machine reads it', async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    await a.service.signIn()
    for (let i = 0; i < 3; i++) {
      await addMatch(a.m, { note: `n${i}` })
      clock.t += 6 * 60_000
      await a.service.syncNow({ manual: true })
    }
    await syncOnce(a.m.db, await a.backend(), { deviceId: a.m.deviceId, compactAfter: 1 })
    const names = g.filesOf('me@example.com').map((f) => f.name)
    expect(names.some((n) => n.startsWith('snap-'))).toBe(true)
    expect(names.filter((n) => n.startsWith('seg-'))).toEqual([])

    const b = await client(g, clock, 'b')
    await b.service.signIn()
    expect(await dump(b.m)).toEqual(await dump(a.m))
  })

  it('a Drive with no room is reported plainly and nothing local is lost', async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    await a.service.signIn()
    await addMatch(a.m, { note: 'will not fit' })
    g.storageFull = true
    const status = await a.service.syncNow({ manual: true })
    expect(status.lastError).toContain('空間已滿')
    expect(status.pending).toBeGreaterThan(0)

    g.storageFull = false
    clock.t += 6 * 60_000
    expect((await a.service.syncNow({ manual: true })).pending).toBe(0)
  })

  it('a rate limit from Google is a quiet back-off', async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    await a.service.signIn()
    await addMatch(a.m)
    g.failNext.push({ status: 429, retryAfter: 120 })
    const status = await a.service.syncNow({ manual: true })
    expect(status.backoffUntil).not.toBeNull()
    expect(status.lastError).toContain('暫時')
  })

  it("export is the app's Drive data as one file", async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    await addMatch(a.m, { note: 'exported' })
    await a.service.signIn()
    const text = await (await a.backend()).exportAll()
    expect(text).toContain('exported')
    expect(text).toContain('"schemaVersion"')
  })

  it('a machine with a decision to make is asked, and nothing happens until it answers', async () => {
    const { g, clock } = world()
    const a = await client(g, clock, 'a')
    await addMatch(a.m, { note: 'from a' })
    await a.service.signIn()
    const b = await client(g, clock, 'b')
    await addMatch(b.m, { note: 'only on b' })
    const result = await b.service.signIn()
    expect(result.needsChoice).toBe(true)
    expect(result.status).toMatchObject({ signedIn: true, enabled: false })
    expect(await b.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(1)
  })
})
