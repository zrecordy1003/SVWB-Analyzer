/**
 * `DriveBackend` against the fake Drive: what it writes, what it lists, and how
 * Google's failures are told apart.
 *
 * Everything goes through the real `GoogleSession` (sign-in included), so the
 * bearer token, the refresh and the timeouts are the ones the app uses.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { deviceFileName, DriveBackend, segmentName, snapshotName } from '../../src/main/sync/drive'
import { GoogleSession } from '../../src/main/sync/google'
import type { CredentialStore, Credentials } from '../../src/main/sync/credentials'
import { contentHash, serializeSegment, type SegmentHeader } from '../../src/main/sync/segment'
import { SyncError } from '../../src/main/sync/transport'
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeGoogle } from '../../tools/sync-dev/fakeGoogle'

let clock = 2_000_000_000_000
let google: FakeGoogle
beforeEach(() => {
  clock = 2_000_000_000_000
  google = new FakeGoogle({ now: () => clock })
})

const memoryStore = (): CredentialStore & { current: Credentials | null } => {
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
  return store
}

async function backendFor(
  deviceId: string,
  opts: { email?: string; name?: string } = {}
): Promise<DriveBackend> {
  const session = new GoogleSession({
    config: () => ({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      endpoints: google.endpoints()
    }),
    fetch: google.fetch,
    store: memoryStore(),
    openExternal: async (url) => {
      await fetch(google.approve(url, opts.email ?? 'me@example.com')).then((r) => r.text())
    },
    deviceId: async () => deviceId,
    now: () => clock
  })
  await session.signIn()
  return new DriveBackend({
    request: (url, init) => session.request(url, init),
    endpoints: google.endpoints(),
    self: { deviceId, deviceName: opts.name ?? `PC-${deviceId}`, appVersion: '1.6.0' },
    now: () => clock
  })
}

const header = (device: string, seq: number, schemaVersion = 19): SegmentHeader => ({
  v: 1,
  schemaVersion,
  device,
  seq,
  hlc: 1
})

const segment = (device: string, seq: number, note = 'x'): string =>
  serializeSegment(header(device, seq), [
    { tbl: 'Match', uid: `m${seq}`, op: 'upsert', ts: seq, row: { note } }
  ])

const put = (b: DriveBackend, device: string, seq: number, note?: string): Promise<void> => {
  const text = segment(device, seq, note)
  return b.putSegment(seq, text, contentHash(text))
}

describe('what gets written', () => {
  it('a segment is a flat file in the hidden folder, named and tagged so a list says what it is', async () => {
    const a = await backendFor('d-a')
    await put(a, 'd-a', 7)
    const files = google.filesOf('me@example.com')
    const seg = files.find((f) => f.props.k === 'seg')!
    const dev = files.find((f) => f.props.k === 'dev')!
    expect(seg.name).toBe(segmentName('d-a', 7))
    expect(seg.name).toBe('seg-d-a-000007.jsonl')
    expect(seg.props).toMatchObject({ k: 'seg', device: 'd-a', seq: '7', sv: '19' })
    expect(seg.props.sha).toMatch(/^[0-9a-f]{64}$/)
    // And the device announces itself with a file of its own.
    expect(dev.name).toBe(deviceFileName('d-a'))
    expect(dev.props).toMatchObject({ k: 'dev', device: 'd-a', nm: 'PC-d-a', av: '1.6.0' })
  })

  it('content survives byte for byte, including CRLF, multibyte text and the multipart boundary look-alikes', async () => {
    const a = await backendFor('d-a')
    const awkward = `--svwb\r\nContent-Type: x\r\n\r\n對局備註 🎴 \r\n  \n`
    const text = segment('d-a', 1, awkward)
    await a.putSegment(1, text, contentHash(text))
    const b = await backendFor('d-b')
    expect(await b.getSegment('d-a', 1)).toBe(text)
  })

  it('the same bytes again is a retry and succeeds; different bytes at a taken number is a conflict', async () => {
    const a = await backendFor('d-a')
    await put(a, 'd-a', 1, 'one')
    await put(a, 'd-a', 1, 'one')
    expect(google.filesOf('me@example.com').filter((f) => f.props.k === 'seg')).toHaveLength(1)
    await expect(put(a, 'd-a', 1, 'two')).rejects.toMatchObject({ status: 409 })
  })

  it('a number the snapshot already covers cannot be reused', async () => {
    const a = await backendFor('d-a')
    await put(a, 'd-a', 1)
    await put(a, 'd-a', 2)
    await a.putSnapshot(2, segment('d-a', 2))
    await expect(put(a, 'd-a', 2, 'again')).rejects.toMatchObject({ status: 409 })
    await put(a, 'd-a', 3) // the next one is fine
  })

  it('a snapshot replaces the previous one, deletes the segments it covers, and never goes backwards', async () => {
    const a = await backendFor('d-a')
    for (const seq of [1, 2, 3]) await put(a, 'd-a', seq)
    await a.putSnapshot(2, segment('d-a', 2, 'snap'))
    let names = google
      .filesOf('me@example.com')
      .map((f) => f.name)
      .sort()
    expect(names).toEqual(
      [deviceFileName('d-a'), segmentName('d-a', 3), snapshotName('d-a')].sort()
    )

    await a.putSnapshot(3, segment('d-a', 3, 'snap2'))
    names = google.filesOf('me@example.com').map((f) => f.name)
    expect(names.filter((n) => n.startsWith('snap-'))).toHaveLength(1) // replaced, not added
    expect(names.some((n) => n.startsWith('seg-'))).toBe(false)

    await expect(a.putSnapshot(1, segment('d-a', 1))).rejects.toMatchObject({ status: 409 })
  })

  it('a device name in Chinese is clipped on a character boundary to fit the property limit', async () => {
    const a = await backendFor('d-a', { name: '我的電腦'.repeat(20) })
    await put(a, 'd-a', 1)
    const dev = google.filesOf('me@example.com').find((f) => f.props.k === 'dev')!
    const bytes = Buffer.byteLength(dev.props.nm) + 'nm'.length
    expect(bytes).toBeLessThanOrEqual(124)
    expect(dev.props.nm).toMatch(/^[我的電腦]+$/)
  })

  it('refreshes "last seen" at most twice a day, not on every sync', async () => {
    const a = await backendFor('d-a')
    await put(a, 'd-a', 1)
    const seen = (): string =>
      google.filesOf('me@example.com').find((f) => f.props.k === 'dev')!.props.seen
    const first = seen()
    clock += 60 * 60_000
    await put(a, 'd-a', 2)
    expect(seen()).toBe(first)
    clock += 13 * 3600_000
    await put(a, 'd-a', 3)
    expect(seen()).not.toBe(first)
  })
})

describe('what is listed', () => {
  it('other devices only, with their segments in order and a snapshot standing in for what it covers', async () => {
    const a = await backendFor('d-a')
    for (const seq of [1, 2, 3, 4]) await put(a, 'd-a', seq)
    await a.putSnapshot(2, segment('d-a', 2))
    const b = await backendFor('d-b')
    await put(b, 'd-b', 1)

    const seenByB = await b.listSegments()
    expect(seenByB.map((d) => d.device)).toEqual(['d-a'])
    expect(seenByB[0].snapshot?.upToSeq).toBe(2)
    expect(seenByB[0].segments.map((s) => s.seq)).toEqual([3, 4])
    expect(seenByB[0].schemaVersion).toBe(19)

    expect((await a.listSegments()).map((d) => d.device)).toEqual(['d-b'])
  })

  it('reads every page when there are more files than one page holds', async () => {
    google.pageSize = 2
    const a = await backendFor('d-a')
    for (let seq = 1; seq <= 7; seq++) await put(a, 'd-a', seq)
    const b = await backendFor('d-b')
    const [other] = await b.listSegments()
    expect(other.segments.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('ignores anything in the folder that is not ours', async () => {
    const a = await backendFor('d-a')
    await put(a, 'd-a', 1)
    const b = await backendFor('d-b')
    // A stray file with no properties, as another version of the app might leave.
    google.filesOf('me@example.com')[0].props = {}
    expect(await b.listSegments()).toEqual([])
  })

  it('devices come from their own files: name, version, activity, and which is this one', async () => {
    const a = await backendFor('d-a', { name: '桌機' })
    await put(a, 'd-a', 1)
    const b = await backendFor('d-b', { name: '筆電' })
    await put(b, 'd-b', 1)
    clock += 100 * 24 * 3600_000 // a hundred days on, only b is seen again
    await put(b, 'd-b', 2)

    const list = await b.devices()
    expect(list.map((d) => [d.name, d.self, d.active])).toEqual([
      ['筆電', true, true],
      ['桌機', false, false]
    ])
    expect(list[1].lastPushAt).not.toBeNull()
    expect(await b.usage()).toMatchObject({ activeDevices: 1 })
    expect((await b.usage()).bytesUsed).toBeGreaterThan(0)
  })
})

describe('cleaning up and exporting', () => {
  it('knows whether the cloud holds anything of this device - false after the user clears the folder', async () => {
    const a = await backendFor('d-a')
    expect(await a.hasOwnData()).toBe(false)
    await put(a, 'd-a', 1)
    expect(await a.hasOwnData()).toBe(true)
    google.clearDrive('me@example.com')
    expect(await a.hasOwnData()).toBe(false)
  })

  it("export is every device's snapshot then segments, each starting with its own header", async () => {
    const a = await backendFor('d-a')
    await put(a, 'd-a', 1)
    await put(a, 'd-a', 2)
    await a.putSnapshot(1, segment('d-a', 1, 'folded'))
    const b = await backendFor('d-b')
    await put(b, 'd-b', 1)
    const text = await b.exportAll()
    const headers = text
      .split('\n')
      .filter((l) => l.startsWith('{"v":1'))
      .map((l) => JSON.parse(l) as { device: string; seq: number })
    expect(headers.map((h) => `${h.device}:${h.seq}`)).toEqual(['d-a:1', 'd-a:2', 'd-b:1'])
    expect(text).toContain('folded')
  })

  it("deleteAll empties the folder, other devices' files included", async () => {
    const a = await backendFor('d-a')
    await put(a, 'd-a', 1)
    const b = await backendFor('d-b')
    await put(b, 'd-b', 1)
    await b.deleteAll()
    expect(google.filesOf('me@example.com')).toEqual([])
    expect(await a.listSegments()).toEqual([])
  })
})

describe('Google saying no', () => {
  it.each([
    [403, 'storageQuotaExceeded', 413, 'quota'],
    [403, 'userRateLimitExceeded', 429, 'rate_limited'],
    [403, 'rateLimitExceeded', 429, 'rate_limited'],
    [429, undefined, 429, 'rate_limited'],
    [500, undefined, 503, 'unavailable'],
    [503, undefined, 503, 'unavailable'],
    [403, 'insufficientPermissions', 403, 'forbidden']
  ])('%i %s becomes %i %s', async (status, reason, expectStatus, expectCode) => {
    const a = await backendFor('d-a')
    google.failNext.push({ status, reason })
    const err = await put(a, 'd-a', 1).catch((e) => e)
    expect(err).toBeInstanceOf(SyncError)
    expect(err).toMatchObject({ status: expectStatus, code: expectCode })
  })

  it('rate limits and outages are quiet back-offs; a full Drive and a missing permission are not', async () => {
    const a = await backendFor('d-a')
    google.failNext.push(
      { status: 429 },
      { status: 503, retryAfter: 90 },
      { status: 403, reason: 'storageQuotaExceeded' }
    )
    expect(await put(a, 'd-a', 1).catch((e) => e)).toMatchObject({ shouldBackOff: true })
    const outage = await put(a, 'd-a', 1).catch((e) => e)
    expect(outage).toMatchObject({ shouldBackOff: true, retryAfterSeconds: 90 })
    expect(await put(a, 'd-a', 1).catch((e) => e)).toMatchObject({ shouldBackOff: false })
  })

  it('a full Drive refuses the upload and leaves no half-written file', async () => {
    const a = await backendFor('d-a')
    google.storageFull = true
    await expect(put(a, 'd-a', 1)).rejects.toMatchObject({ code: 'quota' })
    expect(google.filesOf('me@example.com').filter((f) => f.props.k === 'seg')).toEqual([])
  })

  it('a download of something that is gone is a plain not-found', async () => {
    const a = await backendFor('d-a')
    await expect(a.getSegment('d-ghost', 1)).rejects.toMatchObject({ status: 404 })
    await expect(a.getSnapshot('d-ghost')).rejects.toMatchObject({ status: 404 })
  })
})

describe('whose files they are', () => {
  it('another Google account sees none of it', async () => {
    const a = await backendFor('d-a', { email: 'one@example.com' })
    await put(a, 'd-a', 1)
    const stranger = await backendFor('d-x', { email: 'two@example.com' })
    expect(await stranger.listSegments()).toEqual([])
    expect(await stranger.hasOwnData()).toBe(false)
  })
})
