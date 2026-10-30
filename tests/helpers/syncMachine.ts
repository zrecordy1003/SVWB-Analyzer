/**
 * Two (or three) machines and a server, in one process.
 *
 * Each `Machine` is a real database migrated by the real engine, so the real
 * triggers, constraints and foreign keys are in play - the point of testing sync
 * against SQLite rather than against a model of it. The `Cloud` is a fake
 * server that obeys `docs/sync-protocol.md` closely enough for the client:
 * per-device segments, snapshots that cover them, idempotent PUTs, 409 on a
 * different body at the same seq.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

import { newUid, type Database } from '../../src/main/data/db/client'
import { syncOnce, type SyncReport } from '../../src/main/sync/engine'
import { ensureDeviceId, setState, KEY_ENABLED } from '../../src/main/sync/ledger'
import { seedOutbox } from '../../src/main/sync/lifecycle'
import { SyncError, type Backend, type RemoteDevice } from '../../src/main/sync/transport'
import { migrateWithEngine } from './db'

interface Stored {
  segments: Map<number, string>
  snapshot: { upToSeq: number; text: string } | null
}

export class Cloud {
  readonly devices = new Map<string, Stored>()
  /** Set to make every call fail the way a Worker behind its kill switch does. */
  down: SyncError | null = null
  /** Counts, so a test can assert a quiet sync is cheap. */
  calls = { list: 0, get: 0, put: 0 }

  private stored(device: string): Stored {
    let s = this.devices.get(device)
    if (!s) {
      s = { segments: new Map(), snapshot: null }
      this.devices.set(device, s)
    }
    return s
  }

  totalBytes(): number {
    let n = 0
    for (const s of this.devices.values()) {
      for (const t of s.segments.values()) n += Buffer.byteLength(t)
      if (s.snapshot) n += Buffer.byteLength(s.snapshot.text)
    }
    return n
  }

  transportFor(self: string): Backend {
    const check = (): void => {
      if (this.down) throw this.down
    }
    return {
      listSegments: async () => {
        check()
        this.calls.list++
        const out: RemoteDevice[] = []
        for (const [device, s] of this.devices) {
          if (device === self) continue
          const upTo = s.snapshot?.upToSeq ?? 0
          out.push({
            device,
            retired: false,
            schemaVersion: null,
            snapshot: s.snapshot
              ? { upToSeq: s.snapshot.upToSeq, bytes: Buffer.byteLength(s.snapshot.text) }
              : null,
            segments: [...s.segments.entries()]
              .filter(([seq]) => seq > upTo)
              .map(([seq, t]) => ({ seq, bytes: Buffer.byteLength(t) }))
          })
        }
        return out
      },
      getSegment: async (device, seq) => {
        check()
        this.calls.get++
        const t = this.devices.get(device)?.segments.get(seq)
        if (t === undefined) throw new SyncError(404, 'not_found', 'no such segment')
        return t
      },
      getSnapshot: async (device) => {
        check()
        this.calls.get++
        const t = this.devices.get(device)?.snapshot
        if (!t) throw new SyncError(404, 'not_found', 'no such snapshot')
        return t.text
      },
      putSegment: async (seq, body) => {
        check()
        this.calls.put++
        const s = this.stored(self)
        const held = s.segments.get(seq)
        if (held !== undefined && held !== body) throw new SyncError(409, 'conflict', 'seq taken')
        s.segments.set(seq, body)
      },
      putSnapshot: async (upToSeq, body) => {
        check()
        this.calls.put++
        const s = this.stored(self)
        s.snapshot = { upToSeq, text: body }
        for (const seq of [...s.segments.keys()]) if (seq <= upToSeq) s.segments.delete(seq)
      },
      hasOwnData: async () => {
        check()
        const s = this.devices.get(self)
        return s !== undefined && (s.segments.size > 0 || s.snapshot !== null)
      },
      usage: async () => {
        check()
        return { bytesUsed: this.totalBytes(), activeDevices: this.devices.size }
      },
      devices: async () => {
        check()
        return [...this.devices.keys()].map((id) => ({
          id,
          name: `PC-${id}`,
          appVersion: 'test',
          lastSeenAt: 0,
          lastPushAt: null,
          active: true,
          self: id === self
        }))
      },
      exportAll: async () => {
        check()
        let out = ''
        for (const s of this.devices.values()) {
          if (s.snapshot) out += s.snapshot.text
          for (const t of s.segments.values()) out += t
        }
        return out
      },
      deleteAll: async () => {
        check()
        this.devices.clear()
      }
    }
  }
}

export interface Machine {
  name: string
  dir: string
  db: Kysely<Database>
  deviceId: string
  sqlite: SQLite.Database
  /** One full round against `cloud`. */
  sync(cloud: Cloud): Promise<SyncReport>
  /** Turn sync on the way the app does for a machine whose cloud is empty. */
  enable(): Promise<void>
  close(): Promise<void>
}

export async function createMachine(name: string): Promise<Machine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `svtool-sync-${name}-`))
  const dbPath = path.join(dir, 'app.db')
  migrateWithEngine(dbPath, path.join(process.cwd(), 'resources', 'migrations'))
  const sqlite = new SQLite(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
  const deviceId = await ensureDeviceId(db)
  return {
    name,
    dir,
    db,
    deviceId,
    sqlite,
    sync: (cloud) => syncOnce(db, cloud.transportFor(deviceId), { deviceId }),
    enable: async () => {
      await setState(db, KEY_ENABLED, '1')
      await seedOutbox(db)
    },
    close: async () => {
      await db.destroy()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

// -------------------------------------------------------------- writing data

let clock = 1_800_000_000_000
/** A strictly increasing fake "now", so two edits never share a millisecond by accident. */
export const tick = (): number => (clock += 1000)

export async function addTag(m: Machine, name: string): Promise<{ id: number; uid: string }> {
  const uid = newUid()
  const row = await m.db
    .insertInto('Tag')
    .values({ name, createdAt: tick(), updatedAt: null, uid })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: row.id, uid }
}

export async function addDeck(
  m: Machine,
  values: {
    name: string
    class?: string
    isDefault?: boolean
    categoryId?: string | null
  } & Record<string, unknown>
): Promise<{ id: number; uid: string }> {
  const uid = newUid()
  const { name, class: cls, isDefault, categoryId, ...rest } = values
  const row = await m.db
    .insertInto('Deck')
    .values({
      name,
      class: cls ?? 'witch',
      createdAt: tick(),
      updatedAt: null,
      isDefault: isDefault ? 1 : 0,
      categoryId: categoryId ?? null,
      uid,
      ...rest
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow()
  await m.db.updateTable('Deck').set({ familyId: row.id }).where('id', '=', row.id).execute()
  return { id: row.id, uid }
}

export async function addMatch(
  m: Machine,
  values: Record<string, unknown> = {}
): Promise<{ id: number; uid: string }> {
  const uid = newUid()
  const playedAt = tick()
  const row = await m.db
    .insertInto('Match')
    .values({
      result: 1,
      play_order: 'first',
      my_class: 'witch',
      oppo_class: 'bishop',
      playedAt,
      updatedAt: playedAt,
      source: 'engine',
      uid,
      ...values
    } as never)
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: row.id, uid }
}

export async function tagMatch(m: Machine, matchId: number, tagId: number): Promise<void> {
  await m.db.insertInto('MatchTag').values({ matchId, tagId }).execute()
}

// ------------------------------------------------------------------ reading

/**
 * Everything sync is responsible for, with local integer ids replaced by uids -
 * so two machines that agree on content compare equal even though their ids
 * differ. This is the "same final state" the convergence tests assert.
 */
export async function dump(m: Machine): Promise<unknown> {
  const decks = await m.db.selectFrom('Deck').selectAll().orderBy('uid').execute()
  const deckUid = new Map(decks.map((d) => [d.id, d.uid]))
  const tags = await m.db.selectFrom('Tag').selectAll().orderBy('uid').execute()
  const tagUid = new Map(tags.map((t) => [t.id, t.uid]))
  const matches = await m.db.selectFrom('Match').selectAll().orderBy('uid').execute()
  const matchTags = await m.db.selectFrom('MatchTag').selectAll().execute()
  const cards = await m.db
    .selectFrom('DeckCard')
    .selectAll()
    .orderBy('deckId')
    .orderBy('cardId')
    .execute()
  const categories = await m.db.selectFrom('DeckCategory').selectAll().orderBy('id').execute()

  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, sort: c.sort })),
    tags: tags.map(({ id: _id, ...t }) => t),
    decks: decks.map(({ id, rawJson: _raw, familyId, ...d }) => ({
      ...d,
      family: familyId === null ? null : (deckUid.get(familyId) ?? `?${familyId}`),
      cards: cards.filter((c) => c.deckId === id).map((c) => [c.cardId, c.count])
    })),
    matches: matches.map(({ id, my_deckId, oppo_deckId, oppo_name_crop, ...mt }) => ({
      ...mt,
      my_deck: my_deckId === null ? null : deckUid.get(my_deckId),
      oppo_deck: oppo_deckId === null ? null : deckUid.get(oppo_deckId),
      crop: oppo_name_crop ? Buffer.from(oppo_name_crop).toString('base64') : null,
      tags: matchTags
        .filter((t) => t.matchId === id)
        .map((t) => tagUid.get(t.tagId))
        .sort()
    }))
  }
}

export async function outboxSize(m: Machine): Promise<number> {
  const r = await m.db
    .selectFrom('SyncOutbox')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow()
  return Number(r.n)
}
