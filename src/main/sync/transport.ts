/**
 * Talking to the sync Worker. Contract: `docs/sync-protocol.md`.
 *
 * The rest of sync sees only the `Transport` interface, so the whole engine
 * runs against an in-memory fake in tests - two "machines" and a fake server in
 * one process - and the real one is only a thin layer of HTTP.
 */

export class SyncError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = 'SyncError'
  }

  /** The credentials are no good any more and asking again will not help: sign in again. */
  get needsSignIn(): boolean {
    return (
      this.status === 401 &&
      (this.code === 'revoked' || this.code === 'retired' || this.code === 'unknown_device')
    )
  }

  /** The server asked us to go away for a while (kill switch, rate limit). Not a failure to report loudly. */
  get shouldBackOff(): boolean {
    return this.status === 503 || this.status === 429
  }
}

export interface RemoteDevice {
  device: string
  retired: boolean
  schemaVersion: number | null
  snapshot: { upToSeq: number; bytes: number } | null
  segments: Array<{ seq: number; bytes: number }>
}

export interface Transport {
  listSegments(): Promise<RemoteDevice[]>
  getSegment(device: string, seq: number): Promise<string>
  getSnapshot(device: string): Promise<string>
  putSegment(seq: number, body: string, sha256: string): Promise<void>
  putSnapshot(upToSeq: number, body: string): Promise<void>
}

export interface AuthedFetch {
  (path: string, init?: RequestInit): Promise<Response>
}

/** Turn a failed response into a `SyncError`, reading the Worker's `{error, message}` body when there is one. */
export async function errorFrom(res: Response): Promise<SyncError> {
  let code = 'http_error'
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown }
    if (typeof body.error === 'string') code = body.error
    if (typeof body.message === 'string') message = body.message
  } catch {
    /* not JSON; the status line is all there is */
  }
  const retry = Number(res.headers.get('Retry-After'))
  return new SyncError(
    res.status,
    code,
    message,
    Number.isFinite(retry) && retry > 0 ? retry : null
  )
}

/**
 * The real transport.
 *
 * `request` does the authentication (bearer token, one refresh-and-retry on an
 * expired access token) and prefixes the endpoint; this class only knows the
 * paths and shapes.
 */
export class HttpTransport implements Transport {
  constructor(private readonly request: AuthedFetch) {}

  async listSegments(): Promise<RemoteDevice[]> {
    const res = await this.request('/v1/segments')
    if (!res.ok) throw await errorFrom(res)
    const body = (await res.json()) as { devices?: RemoteDevice[] }
    return Array.isArray(body.devices) ? body.devices : []
  }

  async getSegment(device: string, seq: number): Promise<string> {
    const res = await this.request(`/v1/segments/${encodeURIComponent(device)}/${seq}`)
    if (!res.ok) throw await errorFrom(res)
    return res.text()
  }

  async getSnapshot(device: string): Promise<string> {
    const res = await this.request(`/v1/snapshots/${encodeURIComponent(device)}`)
    if (!res.ok) throw await errorFrom(res)
    return res.text()
  }

  async putSegment(seq: number, body: string, sha256: string): Promise<void> {
    const res = await this.request(`/v1/segments/${seq}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-ndjson', 'X-Content-SHA256': sha256 },
      body
    })
    if (!res.ok) throw await errorFrom(res)
  }

  async putSnapshot(upToSeq: number, body: string): Promise<void> {
    const res = await this.request(`/v1/snapshot?upToSeq=${upToSeq}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body
    })
    if (!res.ok) throw await errorFrom(res)
  }
}
