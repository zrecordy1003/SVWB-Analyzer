/**
 * Cross-device sync, end to end across two real databases and a fake server.
 *
 * What is under test is the whole client: the migration's triggers, the outbox,
 * building and parsing segments, the merge rules against real foreign keys and
 * UNIQUE constraints, and the cursors. The server is a fake that obeys the
 * protocol (see `tests/helpers/syncMachine.ts`).
 *
 * The property that matters most is the last describe: however two machines'
 * changes are interleaved, they end up with the same rows.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  Cloud,
  addDeck,
  addMatch,
  addTag,
  createMachine,
  dump,
  outboxSize,
  tagMatch,
  type Machine
} from '../helpers/syncMachine'
import { SyncError } from '../../src/main/sync/transport'
import { CHUNK, applySegment } from '../../src/main/sync/apply'
import { parseSegment } from '../../src/main/sync/segment'

const machines: Machine[] = []
async function machine(name: string): Promise<Machine> {
  const m = await createMachine(name)
  machines.push(m)
  return m
}

afterEach(async () => {
  for (const m of machines.splice(0)) await m.close()
})

/** Sync until nothing moves: what a user who leaves both apps open eventually gets. */
async function settle(cloud: Cloud, ...ms: Machine[]): Promise<void> {
  for (let round = 0; round < 3; round++) for (const m of ms) await m.sync(cloud)
}

describe('the first sync', () => {
  it('a new machine receives everything another one has recorded', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')

    const tag = await addTag(a, '練習')
    const deck = await addDeck(a, { name: '妖精速攻', class: 'elf', isDefault: true })
    await a.db
      .insertInto('DeckCard')
      .values([
        { deckId: deck.id, cardId: 100, count: 3 },
        { deckId: deck.id, cardId: 200, count: 2 }
      ])
      .execute()
    const match = await addMatch(a, { my_deckId: deck.id, my_class: 'elf', note: '好' })
    await tagMatch(a, match.id, tag.id)

    await a.enable()
    await a.sync(cloud)
    await b.enable()
    await b.sync(cloud)

    expect(await dump(b)).toEqual(await dump(a))
    // And the receiving side's integer ids are its own, not a copy of A's.
    const onB = await b.db.selectFrom('Match').select(['id', 'my_deckId']).executeTakeFirstOrThrow()
    const deckOnB = await b.db
      .selectFrom('Deck')
      .select('id')
      .where('uid', '=', deck.uid)
      .executeTakeFirstOrThrow()
    expect(onB.my_deckId).toBe(deckOnB.id)
  })

  it('carries the nameplate picture, which is the one binary column', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    const crop = Buffer.from([1, 2, 3, 250, 251, 0, 7])
    await addMatch(a, { oppo_name_crop: crop })
    await a.enable()
    await a.sync(cloud)
    await b.sync(cloud)
    const got = await b.db.selectFrom('Match').select('oppo_name_crop').executeTakeFirstOrThrow()
    expect(Buffer.from(got.oppo_name_crop as Uint8Array)).toEqual(crop)
  })
})

describe('what is NOT echoed', () => {
  it('applying remote changes writes nothing to the outbox', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    await addMatch(a)
    await addTag(a, 'x')
    await a.enable()
    await a.sync(cloud)

    await b.sync(cloud)
    expect(await outboxSize(b)).toBe(0)
    // So B's next round has nothing to upload.
    const report = await b.sync(cloud)
    expect(report.pushed.segments).toBe(0)
    expect(cloud.devices.get(b.deviceId)).toBeUndefined()
  })

  it('syncing twice changes nothing the second time', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    await addMatch(a)
    await a.enable()
    await a.sync(cloud)
    await b.sync(cloud)
    const before = await dump(b)
    const again = await b.sync(cloud)
    expect(again.pulledSegments).toBe(0)
    expect(await dump(b)).toEqual(before)
  })

  it('a change made on this machine DOES get recorded - by the trigger, with no app code', async () => {
    const a = await machine('a')
    const m = await addMatch(a)
    // `addMatch` is a bare INSERT, exactly what the Rust engine does.
    const row = await a.db
      .selectFrom('SyncOutbox')
      .selectAll()
      .where('uid', '=', m.uid)
      .executeTakeFirst()
    expect(row?.op).toBe('upsert')
  })

  it('demo data never leaves, however it was written', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const real = await addMatch(a)
    const fake = await addMatch(a, { source: 'demo-seed' })
    const fakeDeck = await addDeck(a, { name: '[demo]', sourceRef: 'demo-seed' })
    await a.enable() // enabling bulk-queues everything it may
    await a.sync(cloud)

    const sent = [...(cloud.devices.get(a.deviceId)?.segments.values() ?? [])].join('\n')
    expect(sent).toContain(real.uid)
    expect(sent).not.toContain(fake.uid)
    expect(sent).not.toContain(fakeDeck.uid)
    expect(await outboxSize(a)).toBe(0)
  })
})

describe('editing and deleting', () => {
  it('an edit on either side reaches the other', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    const m = await addMatch(a, { note: 'old' })
    await a.enable()
    await settle(cloud, a, b)

    await b.db.updateTable('Match').set({ note: 'from b' }).where('uid', '=', m.uid).execute()
    await settle(cloud, b, a)
    expect((await a.db.selectFrom('Match').select('note').executeTakeFirstOrThrow()).note).toBe(
      'from b'
    )

    await a.db.updateTable('Match').set({ note: 'from a' }).where('uid', '=', m.uid).execute()
    await settle(cloud, a, b)
    expect((await b.db.selectFrom('Match').select('note').executeTakeFirstOrThrow()).note).toBe(
      'from a'
    )
  })

  it("a deletion propagates, and takes the match's tag links with it", async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    const tag = await addTag(a, 't')
    const m = await addMatch(a)
    await tagMatch(a, m.id, tag.id)
    await a.enable()
    await settle(cloud, a, b)

    await a.db.deleteFrom('Match').where('uid', '=', m.uid).execute()
    await settle(cloud, a, b)
    expect(await b.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
    expect(await b.db.selectFrom('MatchTag').selectAll().execute()).toHaveLength(0)
    expect(await b.db.selectFrom('Tag').selectAll().execute()).toHaveLength(1)
  })

  it('an older edit arriving late does not bring a deleted row back', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    const m = await addMatch(a, { note: 'x' })
    await a.enable()
    await settle(cloud, a, b)

    // B edits (older), A deletes (newer); B's edit reaches A after the delete.
    await b.db.updateTable('Match').set({ note: 'edit' }).where('uid', '=', m.uid).execute()
    await new Promise((r) => setTimeout(r, 5))
    await a.db.deleteFrom('Match').where('uid', '=', m.uid).execute()
    await settle(cloud, b, a, b)
    expect(await a.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
    expect(await b.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
  })

  it('deleting a deck that matches point at keeps the matches, on both machines', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    const deck = await addDeck(a, { name: 'd' })
    await addMatch(a, { my_deckId: deck.id })
    await a.enable()
    await settle(cloud, a, b)

    await a.db.deleteFrom('Deck').where('uid', '=', deck.uid).execute()
    await settle(cloud, a, b)
    for (const m of [a, b]) {
      const rows = await m.db.selectFrom('Match').select('my_deckId').execute()
      expect(rows).toEqual([{ my_deckId: null }])
    }
    expect(await dump(a)).toEqual(await dump(b))
  })
})

describe('two machines that made the same thing', () => {
  it('a tag of the same name on both becomes one, and every match keeps its tag', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    const ta = await addTag(a, '練習')
    const tb = await addTag(b, '練習')
    const ma = await addMatch(a)
    const mb = await addMatch(b)
    await tagMatch(a, ma.id, ta.id)
    await tagMatch(b, mb.id, tb.id)
    await a.enable()
    await b.enable()
    await settle(cloud, a, b)

    const tags = await a.db.selectFrom('Tag').selectAll().execute()
    expect(tags).toHaveLength(1)
    expect(tags[0].uid).toBe(ta.uid < tb.uid ? ta.uid : tb.uid)
    expect(await dump(a)).toEqual(await dump(b))
    const links = await a.db.selectFrom('MatchTag').selectAll().execute()
    expect(links).toHaveLength(2)
  })

  it('a category of the same name on both becomes one, and decks follow it', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    await a.db
      .insertInto('DeckCategory')
      .values({ id: 'cAAA', name: '主力', sort: 9, createdAt: 1, updatedAt: null } as never)
      .execute()
    await b.db
      .insertInto('DeckCategory')
      .values({ id: 'cBBB', name: '主力', sort: 9, createdAt: 2, updatedAt: null } as never)
      .execute()
    await addDeck(a, { name: 'da', categoryId: 'cAAA' })
    await addDeck(b, { name: 'db', categoryId: 'cBBB' })
    await a.enable()
    await b.enable()
    await settle(cloud, a, b)

    const cats = await a.db
      .selectFrom('DeckCategory')
      .select('id')
      .where('name', '=', '主力')
      .execute()
    expect(cats).toEqual([{ id: 'cAAA' }])
    const decks = await a.db.selectFrom('Deck').select('categoryId').execute()
    expect(decks.every((d) => d.categoryId === 'cAAA')).toBe(true)
    expect(await dump(a)).toEqual(await dump(b))
  })

  it('both set a default deck for a class: exactly one keeps it, the same one on both', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    // Each sets a default while the other is offline, so neither app's own
    // "clear the others" step could have run.
    const da = await addDeck(a, { name: 'a', class: 'elf', isDefault: true })
    await new Promise((r) => setTimeout(r, 5))
    const db2 = await addDeck(b, { name: 'b', class: 'elf', isDefault: true })
    await a.enable()
    await b.enable()
    await settle(cloud, a, b)

    for (const m of [a, b]) {
      const defaults = await m.db
        .selectFrom('Deck')
        .select('uid')
        .where('isDefault', '=', 1)
        .execute()
      expect(defaults).toHaveLength(1)
    }
    expect(await dump(a)).toEqual(await dump(b))
    expect(da.uid).not.toBe(db2.uid)
  })
})

describe('a big segment is applied in short transactions', () => {
  /** A's segment with more than three chunks' worth of matches, as text. */
  async function bigSegment(): Promise<{ a: Machine; text: string; count: number }> {
    const cloud = new Cloud()
    const a = await machine('a')
    const count = CHUNK * 3 + 7
    for (let i = 0; i < count; i++) await addMatch(a, { note: `m${i}` })
    await a.enable()
    await a.sync(cloud)
    const texts = [...cloud.devices.get(a.deviceId)!.segments.values()]
    // One segment holds them all (entries are tiny), which is the point.
    expect(texts).toHaveLength(1)
    return { a, text: texts[0], count }
  }

  it('applies every entry, across chunks, and moves the cursor only at the end', async () => {
    const { a, text, count } = await bigSegment()
    const b = await machine('b')
    const seg = parseSegment(text)!
    const cursors: number[] = []
    await applySegment(b.db, seg, {
      selfDevice: b.deviceId,
      cursor: { device: a.deviceId, seq: seg.header.seq, kind: 'segment' },
      betweenChunks: async () => {
        const c = await b.db
          .selectFrom('SyncState')
          .select('value')
          .where('key', '=', `cursor:${a.deviceId}`)
          .executeTakeFirst()
        cursors.push(c ? Number(c.value) : -1)
      }
    })
    expect(await b.db.selectFrom('Match').selectAll().execute()).toHaveLength(count)
    // Three gaps between four chunks; the cursor was not there for any of them.
    expect(cursors).toEqual([-1, -1, -1])
    const after = await b.db
      .selectFrom('SyncState')
      .select('value')
      .where('key', '=', `cursor:${a.deviceId}`)
      .executeTakeFirst()
    expect(Number(after?.value)).toBe(seg.header.seq)
    expect(await outboxSize(b)).toBe(0)
  })

  it('a change made between two chunks is recorded - the flag is down whenever the database is free', async () => {
    const { a, text } = await bigSegment()
    const b = await machine('b')
    let local: { uid: string } | undefined
    await applySegment(b.db, parseSegment(text)!, {
      selfDevice: b.deviceId,
      cursor: { device: a.deviceId, seq: 1, kind: 'segment' },
      betweenChunks: async () => {
        // What the engine does the moment it can get the lock.
        local ??= await addMatch(b, { note: 'recorded mid-apply' })
      }
    })
    const queued = await b.db.selectFrom('SyncOutbox').select(['uid', 'op']).execute()
    // Only this one: the 100-odd remote rows stayed out of the outbox.
    expect(queued).toEqual([{ uid: local!.uid, op: 'upsert' }])
  })

  it('a crash between chunks leaves the cursor behind, and applying again finishes the job', async () => {
    const { a, text, count } = await bigSegment()
    const b = await machine('b')
    const seg = parseSegment(text)!
    const options = {
      selfDevice: b.deviceId,
      cursor: { device: a.deviceId, seq: seg.header.seq, kind: 'segment' as const }
    }
    await expect(
      applySegment(b.db, seg, {
        ...options,
        betweenChunks: async () => {
          throw new Error('power cut')
        }
      })
    ).rejects.toThrow('power cut')
    const partial = (await b.db.selectFrom('Match').selectAll().execute()).length
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(count)
    expect(
      await b.db.selectFrom('SyncState').selectAll().where('key', 'like', 'cursor:%').execute()
    ).toHaveLength(0)

    await applySegment(b.db, seg, options)
    expect(await b.db.selectFrom('Match').selectAll().execute()).toHaveLength(count)
    expect(await outboxSize(b)).toBe(0)
  })
})

describe('references that arrive out of order', () => {
  it('a match whose deck has not arrived yet gets its deck when it does', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const c = await machine('c')
    const deck = await addDeck(a, { name: 'd' })
    const m = await addMatch(a, { my_deckId: deck.id })
    await a.enable()
    await a.sync(cloud)

    // Hold the deck's segment back: hand C only the segment that has the match.
    const stored = cloud.devices.get(a.deviceId)!
    const [seq1] = [...stored.segments.keys()]
    const text = stored.segments.get(seq1)!
    const lines = text.trim().split('\n')
    const header = lines[0]
    const matchLine = lines.find((l) => l.includes('"tbl":"Match"'))!
    const deckLine = lines.find((l) => l.includes('"tbl":"Deck"'))!
    stored.segments.set(seq1, `${header}\n${matchLine}\n`)
    stored.segments.set(
      seq1 + 1,
      `${header.replace(`"seq":${seq1}`, `"seq":${seq1 + 1}`)}\n${deckLine}\n`
    )

    await c.sync(cloud)
    const after = await c.db
      .selectFrom('Match')
      .select(['uid', 'my_deckId'])
      .executeTakeFirstOrThrow()
    expect(after.uid).toBe(m.uid)
    const deckOnC = await c.db
      .selectFrom('Deck')
      .select('id')
      .where('uid', '=', deck.uid)
      .executeTakeFirstOrThrow()
    expect(after.my_deckId).toBe(deckOnC.id)
    expect(await c.db.selectFrom('SyncPending').selectAll().execute()).toHaveLength(0)
  })
})

describe('the server', () => {
  it('a Worker that says go away is just an error; local data is untouched', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    await addMatch(a)
    await a.enable()
    cloud.down = new SyncError(503, 'unavailable', 'later', 3600)
    await expect(a.sync(cloud)).rejects.toMatchObject({ status: 503, retryAfterSeconds: 3600 })
    expect(await outboxSize(a)).toBeGreaterThan(0)
    expect(await a.db.selectFrom('Match').selectAll().execute()).toHaveLength(1)

    cloud.down = null
    await a.sync(cloud)
    expect(await outboxSize(a)).toBe(0)
  })

  it('a crash after upload but before bookkeeping re-sends under a fresh seq, harmlessly', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    await addMatch(a, { note: 'one' })
    await a.enable()
    await a.sync(cloud)

    // Simulate the lost bookkeeping: rewind the seq counter and re-dirty the row.
    await a.db.updateTable('SyncState').set({ value: '1' }).where('key', '=', 'nextSeq').execute()
    await a.db.updateTable('Match').set({ note: 'two' }).execute()
    await a.sync(cloud)

    await b.sync(cloud)
    expect((await b.db.selectFrom('Match').select('note').executeTakeFirstOrThrow()).note).toBe(
      'two'
    )
  })

  it('a peer on a newer schema is waited for, not applied and not lost', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    await addMatch(a)
    await a.enable()
    await a.sync(cloud)
    const stored = cloud.devices.get(a.deviceId)!
    for (const [seq, text] of stored.segments) {
      stored.segments.set(seq, text.replace(/"schemaVersion":\d+/, '"schemaVersion":9999'))
    }

    const report = await b.sync(cloud)
    expect(report.needsUpdate).toBe(true)
    expect(await b.db.selectFrom('Match').selectAll().execute()).toHaveLength(0)
    // The cursor did not move, so an update picks up exactly here.
    const cursor = await b.db
      .selectFrom('SyncState')
      .selectAll()
      .where('key', 'like', 'cursor:%')
      .execute()
    expect(cursor).toHaveLength(0)
  })

  it('a snapshot stands in for the segments it covers', async () => {
    const cloud = new Cloud()
    const a = await machine('a')
    const b = await machine('b')
    for (let i = 0; i < 4; i++) {
      await addMatch(a, { note: `n${i}` })
      await a.enable()
      await a.sync(cloud)
    }
    // Force compaction (the production threshold is 200 segments).
    const { syncOnce } = await import('../../src/main/sync/engine')
    await syncOnce(a.db, cloud.transportFor(a.deviceId), { deviceId: a.deviceId, compactAfter: 1 })
    const stored = cloud.devices.get(a.deviceId)!
    expect(stored.snapshot).not.toBeNull()
    expect(stored.segments.size).toBe(0)

    await b.sync(cloud)
    expect(await dump(b)).toEqual(await dump(a))
  })
})

describe('convergence', () => {
  // A small deterministic PRNG so a failure is reproducible from the seed alone.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  it.each([1, 2, 3, 4, 5, 6])(
    'random edits on three machines, synced in any order, end up identical (seed %i)',
    async (seed) => {
      const rand = rng(seed)
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
      const cloud = new Cloud()
      const ms = [await machine('a'), await machine('b'), await machine('c')]
      for (const m of ms) await m.enable()

      for (let step = 0; step < 40; step++) {
        const m = pick(ms)
        const roll = rand()
        const matches = await m.db.selectFrom('Match').select(['id', 'uid']).execute()
        const tags = await m.db.selectFrom('Tag').select(['id', 'uid']).execute()
        const decks = await m.db.selectFrom('Deck').select(['id', 'uid']).execute()
        if (roll < 0.2) await addMatch(m, { note: `s${step}` })
        else if (roll < 0.3) await addTag(m, pick(['a', 'b', 'c', 'd']))
        else if (roll < 0.4)
          await addDeck(m, {
            name: `d${step}`,
            class: pick(['elf', 'witch']),
            isDefault: rand() < 0.5
          })
        else if (roll < 0.55 && matches.length) {
          await m.db
            .updateTable('Match')
            .set({ note: `e${step}` })
            .where('id', '=', pick(matches).id)
            .execute()
        } else if (roll < 0.65 && matches.length && tags.length) {
          await m.db
            .insertInto('MatchTag')
            .values({ matchId: pick(matches).id, tagId: pick(tags).id })
            .onConflict((oc) => oc.doNothing())
            .execute()
        } else if (roll < 0.72 && matches.length && decks.length) {
          await m.db
            .updateTable('Match')
            .set({ my_deckId: pick(decks).id })
            .where('id', '=', pick(matches).id)
            .execute()
        } else if (roll < 0.8 && matches.length) {
          await m.db.deleteFrom('Match').where('id', '=', pick(matches).id).execute()
        } else if (roll < 0.85 && tags.length) {
          await m.db.deleteFrom('Tag').where('id', '=', pick(tags).id).execute()
        } else if (roll < 0.9 && decks.length) {
          await m.db.deleteFrom('Deck').where('id', '=', pick(decks).id).execute()
        }
        // Sometimes a machine syncs mid-stream; sometimes it does not.
        if (rand() < 0.35) await pick(ms).sync(cloud)
        // Edits need distinct timestamps to have a defined winner.
        await new Promise((r) => setTimeout(r, 2))
      }

      await settle(cloud, ...ms, ...ms)
      const [a, b, c] = await Promise.all(ms.map(dump))
      expect(b).toEqual(a)
      expect(c).toEqual(a)
    },
    60_000
  )
})
