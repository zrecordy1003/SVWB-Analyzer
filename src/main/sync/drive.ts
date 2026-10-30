/**
 * The sync data's home: the app's hidden folder in the user's own Google Drive.
 *
 * `appDataFolder` is a per-app, per-user space that does not show up in the
 * user's Drive and that no other app can read, reachable with the non-sensitive
 * `drive.appdata` scope and counted against the user's own storage. So there is
 * no server here, no bucket to pay for, and nothing of the user's that we hold -
 * which is most of why it is Drive and not a Worker.
 *
 * LAYOUT. Flat, because the folder has no subfolders worth making, and every
 * file says what it is in its name AND in `appProperties` (which `files.list`
 * returns with no extra request, so listing never has to download anything):
 *
 *   seg-{device}-{seq:06d}.jsonl   one run of changes, written once, by one device
 *   snap-{device}.jsonl            that device's history folded into current state
 *   dev-{device}.json              empty; its appProperties say who the device is
 *
 * The same rule as before: each device writes only its own files and only ever
 * adds (or replaces its own snapshot), so there is nothing for two devices to
 * fight over and no merge on the server because there is no server.
 *
 * What a server used to do and this does not: revoke one device (Drive offers
 * only "revoke the app", which the user does in their Google account), a kill
 * switch, a quota the operator sets, or fold an abandoned device's history. The
 * user's own Drive quota is the ceiling; an abandoned device's files simply stay.
 */
import { randomBytes } from 'node:crypto'

import type { SyncAccountInfo, SyncDevice } from '../../shared/sync.js'
import { SyncError, type Backend, type RemoteDevice } from './transport.js'
import type { GoogleEndpoints } from './google.js'

const FOLDER = 'appDataFolder'
const FIELDS = 'id,name,size,appProperties,modifiedTime'
/** A device that has not been seen for this long is shown as idle. Display only; nothing is retired. */
const IDLE_MS = 90 * 24 * 3600_000
/** The device file's `seen` is refreshed at most this often: it is a write, and a write per sync is noise. */
const SEEN_EVERY_MS = 12 * 3600_000

interface DriveFile {
  id: string
  name: string
  size: number
  props: Record<string, string>
  modifiedAt: number
}

export interface DriveDeps {
  /** Authenticated `fetch` against an absolute URL (see `GoogleSession.request`). */
  request(url: string, init?: RequestInit): Promise<Response>
  endpoints: GoogleEndpoints
  self: { deviceId: string; deviceName: string; appVersion: string }
  now(): number
}

const pad = (seq: number): string => String(seq).padStart(6, '0')
export const segmentName = (device: string, seq: number): string =>
  `seg-${device}-${pad(seq)}.jsonl`
export const snapshotName = (device: string): string => `snap-${device}.jsonl`
export const deviceFileName = (device: string): string => `dev-${device}.json`

/** `appProperties` entries are capped at 124 bytes of key plus value; cut on a character boundary. */
function clip(value: string, maxBytes: number): string {
  let out = ''
  let bytes = 0
  for (const ch of value) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > maxBytes) break
    out += ch
    bytes += n
  }
  return out
}

export class DriveBackend implements Backend {
  private index: DriveFile[] | null = null

  constructor(private readonly deps: DriveDeps) {}

  private get self(): string {
    return this.deps.self.deviceId
  }

  // ------------------------------------------------------------------ errors

  /** Turn a failed Drive response into the `SyncError` the rest of sync understands. */
  private async fail(res: Response): Promise<SyncError> {
    let reason = ''
    let message = `Google 雲端硬碟回應 ${res.status}`
    try {
      const body = (await res.json()) as {
        error?: { message?: string; errors?: Array<{ reason?: string }>; status?: string }
      }
      reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? ''
      if (body.error?.message) message = body.error.message
    } catch {
      /* not JSON; the status line is all there is */
    }
    const retry = Number(res.headers.get('Retry-After'))
    const after = Number.isFinite(retry) && retry > 0 ? retry : null

    if (res.status === 401) return new SyncError(401, 'revoked', 'Google 授權已失效')
    if (res.status === 403 || res.status === 429) {
      if (reason === 'storageQuotaExceeded') {
        return new SyncError(413, 'quota', 'Google 雲端硬碟空間已滿')
      }
      if (/rateLimit|dailyLimit|quotaExceeded/i.test(reason) || res.status === 429) {
        return new SyncError(429, 'rate_limited', 'Google 雲端硬碟暫時限制了請求', after ?? 600)
      }
      return new SyncError(403, 'forbidden', message)
    }
    if (res.status === 404) return new SyncError(404, 'not_found', message)
    if (res.status >= 500) return new SyncError(503, 'unavailable', message, after ?? 300)
    return new SyncError(res.status, 'http_error', message)
  }

  private async ok(res: Response): Promise<Response> {
    if (!res.ok) throw await this.fail(res)
    return res
  }

  // ------------------------------------------------------------------- index

  /** Every file in the folder. One list is one round's whole picture; it is kept up to date by the writes after it. */
  private async files(refresh = false): Promise<DriveFile[]> {
    if (this.index && !refresh) return this.index
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const url = new URL(`${this.deps.endpoints.drive}/files`)
      url.searchParams.set('spaces', FOLDER)
      url.searchParams.set('q', 'trashed = false')
      url.searchParams.set('pageSize', '1000')
      url.searchParams.set('fields', `nextPageToken,files(${FIELDS})`)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const res = await this.ok(await this.deps.request(url.toString()))
      const body = (await res.json()) as {
        nextPageToken?: string
        files?: Array<{
          id: string
          name: string
          size?: string
          appProperties?: Record<string, string>
          modifiedTime?: string
        }>
      }
      for (const f of body.files ?? []) {
        out.push({
          id: f.id,
          name: f.name,
          size: Number(f.size ?? 0),
          props: f.appProperties ?? {},
          modifiedAt: f.modifiedTime ? Date.parse(f.modifiedTime) : 0
        })
      }
      pageToken = body.nextPageToken
    } while (pageToken)
    this.index = out
    return out
  }

  private remember(file: DriveFile): void {
    const rest = (this.index ?? []).filter((f) => f.id !== file.id && f.name !== file.name)
    this.index = [...rest, file]
  }

  private forget(file: DriveFile): void {
    this.index = (this.index ?? []).filter((f) => f.id !== file.id)
  }

  private fromResponse(body: {
    id: string
    name: string
    size?: string
    appProperties?: Record<string, string>
    modifiedTime?: string
  }): DriveFile {
    return {
      id: body.id,
      name: body.name,
      size: Number(body.size ?? 0),
      props: body.appProperties ?? {},
      modifiedAt: body.modifiedTime ? Date.parse(body.modifiedTime) : this.deps.now()
    }
  }

  // ------------------------------------------------------------------ writes

  /** Create a file, or replace one's content, with its metadata, in one request. */
  private async upload(
    existing: DriveFile | undefined,
    name: string,
    props: Record<string, string>,
    body: string
  ): Promise<DriveFile> {
    const boundary = `svwb${randomBytes(12).toString('hex')}`
    const metadata = existing
      ? { appProperties: props }
      : { name, parents: [FOLDER], appProperties: props }
    const payload =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/x-ndjson\r\n\r\n${body}\r\n--${boundary}--`
    const url = new URL(
      existing
        ? `${this.deps.endpoints.upload}/files/${encodeURIComponent(existing.id)}`
        : `${this.deps.endpoints.upload}/files`
    )
    url.searchParams.set('uploadType', 'multipart')
    url.searchParams.set('fields', FIELDS)
    const res = await this.ok(
      await this.deps.request(url.toString(), {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: payload
      })
    )
    const file = this.fromResponse(await res.json())
    this.remember(file)
    return file
  }

  private async remove(file: DriveFile): Promise<void> {
    const res = await this.deps.request(
      `${this.deps.endpoints.drive}/files/${encodeURIComponent(file.id)}`,
      { method: 'DELETE' }
    )
    // Already gone is the outcome we wanted.
    if (!res.ok && res.status !== 404) throw await this.fail(res)
    this.forget(file)
  }

  /** Make sure a file exists saying who this device is, and that it was seen recently. */
  private async announce(): Promise<void> {
    const { deviceId, deviceName, appVersion } = this.deps.self
    const files = await this.files()
    const mine = files.find((f) => f.name === deviceFileName(deviceId))
    const now = this.deps.now()
    if (mine && now - Number(mine.props.seen ?? 0) < SEEN_EVERY_MS) return
    const props = {
      k: 'dev',
      device: deviceId,
      nm: clip(deviceName, 90),
      av: clip(appVersion, 30),
      seen: String(now)
    }
    if (mine) {
      const url = new URL(`${this.deps.endpoints.drive}/files/${encodeURIComponent(mine.id)}`)
      url.searchParams.set('fields', FIELDS)
      const res = await this.ok(
        await this.deps.request(url.toString(), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appProperties: props })
        })
      )
      this.remember(this.fromResponse(await res.json()))
      return
    }
    const url = new URL(`${this.deps.endpoints.drive}/files`)
    url.searchParams.set('fields', FIELDS)
    const res = await this.ok(
      await this.deps.request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: deviceFileName(deviceId),
          parents: [FOLDER],
          appProperties: props
        })
      })
    )
    this.remember(this.fromResponse(await res.json()))
  }

  async putSegment(seq: number, body: string, sha256: string): Promise<void> {
    const files = await this.files()
    const name = segmentName(this.self, seq)
    const held = files.find((f) => f.name === name)
    // The same bytes again is a retry and succeeds; different bytes at a taken seq is
    // the client's cue to take the next number (see `uploadSegment`).
    if (held) {
      if (held.props.sha === sha256) return
      throw new SyncError(409, 'conflict', 'segment number already used')
    }
    const snap = files.find((f) => f.name === snapshotName(this.self))
    // A number the snapshot already covers was deleted on purpose; reusing it would be
    // read as old news by everyone who applied the snapshot.
    if (snap && Number(snap.props.upTo ?? -1) >= seq) {
      throw new SyncError(409, 'conflict', 'segment number is covered by the snapshot')
    }
    await this.upload(undefined, name, this.segmentProps(seq, body, sha256), body)
    await this.announce()
  }

  private segmentProps(seq: number, body: string, sha256: string): Record<string, string> {
    const header = firstLine(body)
    return {
      k: 'seg',
      device: this.self,
      seq: String(seq),
      sha: sha256,
      sv: String(header?.schemaVersion ?? '')
    }
  }

  async putSnapshot(upToSeq: number, body: string): Promise<void> {
    const files = await this.files()
    const existing = files.find((f) => f.name === snapshotName(this.self))
    if (existing && Number(existing.props.upTo ?? -1) > upToSeq) {
      throw new SyncError(409, 'conflict', 'a newer snapshot is already stored')
    }
    const header = firstLine(body)
    await this.upload(
      existing,
      snapshotName(this.self),
      {
        k: 'snap',
        device: this.self,
        upTo: String(upToSeq),
        sv: String(header?.schemaVersion ?? '')
      },
      body
    )
    // The snapshot is in place; only now do the segments it covers go. A crash in
    // between leaves both, which is wasteful and harmless.
    for (const f of (this.index ?? []).filter(
      (f) => f.props.k === 'seg' && f.props.device === this.self && Number(f.props.seq) <= upToSeq
    )) {
      await this.remove(f)
    }
    await this.announce()
  }

  // ------------------------------------------------------------------- reads

  async listSegments(): Promise<RemoteDevice[]> {
    const files = await this.files(true)
    const byDevice = new Map<string, DriveFile[]>()
    for (const f of files) {
      const device = f.props.device
      if (!device || device === this.self) continue
      if (f.props.k !== 'seg' && f.props.k !== 'snap') continue
      byDevice.set(device, [...(byDevice.get(device) ?? []), f])
    }
    const out: RemoteDevice[] = []
    for (const [device, list] of byDevice) {
      const snap = list.find((f) => f.props.k === 'snap')
      const upTo = snap ? Number(snap.props.upTo ?? -1) : -1
      const segments = list
        .filter((f) => f.props.k === 'seg')
        .map((f) => ({ seq: Number(f.props.seq), bytes: f.size }))
        .filter((s) => Number.isInteger(s.seq) && s.seq > upTo)
        .sort((a, b) => a.seq - b.seq)
      const versions = list
        .map((f) => Number(f.props.sv))
        .filter((n) => Number.isInteger(n) && n > 0)
      out.push({
        device,
        retired: false,
        schemaVersion: versions.length > 0 ? Math.max(...versions) : null,
        snapshot: snap ? { upToSeq: upTo, bytes: snap.size } : null,
        segments
      })
    }
    return out
  }

  private async download(file: DriveFile): Promise<string> {
    const res = await this.ok(
      await this.deps.request(
        `${this.deps.endpoints.drive}/files/${encodeURIComponent(file.id)}?alt=media`
      )
    )
    return res.text()
  }

  async getSegment(device: string, seq: number): Promise<string> {
    const name = segmentName(device, seq)
    const file = (await this.files()).find((f) => f.name === name)
    if (!file) throw new SyncError(404, 'not_found', `no such segment: ${name}`)
    return this.download(file)
  }

  async getSnapshot(device: string): Promise<string> {
    const name = snapshotName(device)
    const file = (await this.files()).find((f) => f.name === name)
    if (!file) throw new SyncError(404, 'not_found', `no such snapshot: ${name}`)
    return this.download(file)
  }

  // ------------------------------------------------------- what settings shows

  async hasOwnData(): Promise<boolean> {
    return (await this.files(true)).some(
      (f) => f.props.device === this.self && (f.props.k === 'seg' || f.props.k === 'snap')
    )
  }

  async devices(): Promise<SyncDevice[]> {
    const files = await this.files(true)
    const now = this.deps.now()
    const out: SyncDevice[] = []
    for (const f of files) {
      if (f.props.k !== 'dev' || !f.props.device) continue
      const id = f.props.device
      const pushes = files
        .filter((g) => g.props.device === id && (g.props.k === 'seg' || g.props.k === 'snap'))
        .map((g) => g.modifiedAt)
      const seen = Number(f.props.seen ?? f.modifiedAt)
      out.push({
        id,
        name: f.props.nm || '未命名的裝置',
        appVersion: f.props.av || '',
        lastSeenAt: seen,
        lastPushAt: pushes.length > 0 ? Math.max(...pushes) : null,
        active: now - seen < IDLE_MS,
        self: id === this.self
      })
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  async usage(): Promise<Pick<SyncAccountInfo, 'bytesUsed' | 'activeDevices'>> {
    const files = await this.files(true)
    const devices = await this.devices()
    return {
      bytesUsed: files.reduce((sum, f) => sum + f.size, 0),
      activeDevices: devices.filter((d) => d.active).length
    }
  }

  async exportAll(): Promise<string> {
    const files = (await this.files(true))
      .filter((f) => f.props.k === 'seg' || f.props.k === 'snap')
      .sort(
        (a, b) =>
          (a.props.device ?? '').localeCompare(b.props.device ?? '') ||
          // A device's snapshot first, then its segments in order.
          Number(b.props.k === 'snap') - Number(a.props.k === 'snap') ||
          Number(a.props.seq ?? 0) - Number(b.props.seq ?? 0)
      )
    const parts: string[] = []
    for (const f of files) {
      const text = await this.download(f)
      parts.push(text.endsWith('\n') ? text : `${text}\n`)
    }
    return parts.join('')
  }

  async deleteAll(): Promise<void> {
    for (const f of [...(await this.files(true))]) await this.remove(f)
    this.index = []
  }
}

/** The header line of a segment, for the schema version. Lenient: a file that does not parse just has none. */
function firstLine(body: string): { schemaVersion?: number } | null {
  const end = body.indexOf('\n')
  try {
    return JSON.parse(end === -1 ? body : body.slice(0, end)) as { schemaVersion?: number }
  } catch {
    return null
  }
}
