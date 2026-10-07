/**
 * The real client against the real Worker code.
 *
 * Nothing in this file is faked on either side of the protocol: the app's
 * `Session`, `SyncService` and `HttpTransport` talk, through a `fetch` that is
 * wired straight to the Worker's `handle()`, to the same router, auth, D1 SQL
 * and R2 logic that gets deployed (backed here by SQLite and a Map). The only
 * stand-ins are Google (a fake with a real RSA keypair signing real id_tokens)
 * and the browser (a function that follows the redirects).
 *
 * It exists because the two halves were written against a document, and a
 * document is not a test: this is where a field named differently on each side
 * would show up.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Session } from '../../src/main/sync/auth'
import type { CredentialStore, Credentials } from '../../src/main/sync/credentials'
import { syncOnce } from '../../src/main/sync/engine'
import { SyncService } from '../../src/main/sync/service'
import { HttpTransport } from '../../src/main/sync/transport'
import { handle } from '../../server/sync/src/router'
import { world, type World } from '../server/sync/helpers'
import {
  addDeck,
  addMatch,
  addTag,
  createMachine,
  dump,
  tagMatch,
  type Machine
} from '../helpers/syncMachine'

const ORIGIN = 'https://sync.test'
const machines: Machine[] = []
afterEach(async () => {
  for (const m of machines.splice(0)) await m.close()
})

interface Client {
  m: Machine
  session: Session
  service: SyncService
  store: CredentialStore & { current: Credentials | null }
  restored: number
}

async function client(w: World, name: string, sub = '1000000001'): Promise<Client> {
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
  const toWorld: typeof fetch = (input, init) => handle(w.deps, new Request(input as string, init))

  /** The browser: follow /auth/start to "Google", back through /auth/callback, to the app's loopback. */
  const openExternal = async (startUrl: string): Promise<void> => {
    const start = await toWorld(startUrl, { redirect: 'manual' })
    const google = new URL(start.headers.get('location')!)
    const code = await w.google.issueCode({ sub, nonce: google.searchParams.get('nonce')! })
    const callback = await toWorld(
      `${ORIGIN}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(google.searchParams.get('state')!)}`,
      { redirect: 'manual' }
    )
    await fetch(callback.headers.get('location')!) // the real loopback listener
  }

  const session = new Session({
    endpoint: () => ORIGIN,
    fetch: toWorld,
    store,
    openExternal,
    deviceId: async () => m.deviceId,
    deviceName: () => `PC-${name}`,
    appVersion: () => '1.6.0',
    now: () => w.clock.t
  })
  const c: Client = { m, session, store, restored: 0, service: undefined as never }
  c.service = new SyncService({
    db: () => m.db,
    session,
    backupDir: () => path.join(m.dir, 'sync-backup'),
    configured: () => true,
    memoryOnlyCredentials: () => false,
    notifyChanged: () => undefined,
    afterRestore: async () => {
      c.restored++
    },
    now: () => w.clock.t
  })
  return c
}

describe('two machines, one account, the real server', () => {
  it('records on A, restores on B, edits on B, arrives on A - through sign-in, rotation of nothing, and R2', async () => {
    const w = await world()
    const a = await client(w, 'a')
    const b = await client(w, 'b')

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
    expect(first.status).toMatchObject({ signedIn: true, enabled: true, email: expect.any(String) })

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
    w.clock.t += 10 * 60_000
    await a.service.syncNow({ manual: true })
    expect((await a.m.db.selectFrom('Match').select('note').executeTakeFirstOrThrow()).note).toBe(
      '從 B 改的'
    )
    expect(await dump(a.m)).toEqual(await dump(b.m))

    // The server's own bookkeeping agrees about who did what.
    const me = await a.service.account()
    expect(me).toMatchObject({ activeDevices: 2 })
    expect(me!.bytesUsed).toBeGreaterThan(0)
    const devices = await a.service.devices()
    expect(devices.map((d) => d.name).sort()).toEqual(['PC-a', 'PC-b'])
    expect(devices.find((d) => d.self)?.name).toBe('PC-a')
  })

  it('a different Google account cannot see any of it', async () => {
    const w = await world()
    const a = await client(w, 'a', '1000000001')
    const stranger = await client(w, 'stranger', '2000000002')
    await addMatch(a.m, { note: 'private' })
    await a.service.signIn()
    await stranger.service.signIn()
    expect(await stranger.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
  })

  it('a revoked device finds out, is signed out, and loses nothing locally', async () => {
    const w = await world()
    const a = await client(w, 'a')
    const b = await client(w, 'b')
    await addMatch(a.m)
    await a.service.signIn()
    await b.service.signIn()
    const mineOnB = await addMatch(b.m, { note: 'b only' })

    const bId = (await a.service.devices()).find((d) => !d.self)!.id
    await a.service.revokeDevice(bId)

    w.clock.t += 20 * 60_000 // past the access token's life, so b must go back to the server
    const status = await b.service.syncNow({ manual: true })
    expect(status).toMatchObject({ signedIn: false, enabled: false })
    expect(status.lastError).toContain('請重新登入')
    expect(b.store.current).toBeNull()
    expect(
      await b.m.db.selectFrom('Match').select('uid').where('uid', '=', mineOnB.uid).execute()
    ).toHaveLength(1)
  })

  it('deleting the cloud copy empties the server and signs the other device out on its next round', async () => {
    const w = await world()
    const a = await client(w, 'a')
    const b = await client(w, 'b')
    await addMatch(a.m)
    await a.service.signIn()
    await b.service.signIn()
    expect(w.bucket.keys().length).toBeGreaterThan(0)

    const after = await a.service.deleteAccount()
    expect(after.signedIn).toBe(false)
    expect(w.bucket.keys()).toEqual([])
    expect(w.db.rows('SELECT * FROM devices')).toEqual([])
    // Local data is the user's and stays.
    expect(await a.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(1)

    w.clock.t += 20 * 60_000
    expect(await b.service.syncNow({ manual: true })).toMatchObject({ signedIn: false })
    expect(await b.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(1)
  })

  it('compaction through the real server: a snapshot replaces the segments and a fresh machine reads it', async () => {
    const w = await world()
    const a = await client(w, 'a')
    await a.service.signIn()
    for (let i = 0; i < 3; i++) {
      await addMatch(a.m, { note: `n${i}` })
      w.clock.t += 6 * 60_000
      await a.service.syncNow({ manual: true })
    }
    const transport = new HttpTransport(a.session.request)
    await syncOnce(a.m.db, transport, { deviceId: a.m.deviceId, compactAfter: 1 })
    expect(w.bucket.keys().some((k) => k.endsWith('snapshot.jsonl'))).toBe(true)
    expect(w.bucket.keys().filter((k) => /\/\d{6}\.jsonl$/.test(k))).toEqual([])

    const b = await client(w, 'b')
    await b.service.signIn()
    expect(await dump(b.m)).toEqual(await dump(a.m))
  })

  it("the export is every device's data, concatenated, and parses as segments", async () => {
    const w = await world()
    const a = await client(w, 'a')
    await addMatch(a.m, { note: 'exported' })
    await a.service.signIn()
    const res = await a.session.request('/v1/account/export')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('exported')
    expect(text).toContain('"schemaVersion"')
  })

  it('a kill-switched server is a quiet back-off for the client', async () => {
    const w = await world({ KILL_SWITCH: '1' })
    const a = await client(w, 'a')
    // Sign-in is exempt from the kill switch so a login in progress can finish...
    const signedIn = await a.service.signIn()
    // ...but the data plane says go away, and that is reported without alarm.
    expect(signedIn.status).toMatchObject({ signedIn: true, enabled: false })
    expect(signedIn.status.backoffUntil).not.toBeNull()
    expect(signedIn.status.lastError).toContain('暫時不可用')
    expect(await a.m.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
    await fs.stat(a.m.dir) // the local database is, of course, untouched
  })
})
