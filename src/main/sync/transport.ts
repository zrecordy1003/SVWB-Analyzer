/**
 * What the sync engine needs from wherever the data is kept.
 *
 * The engine (`engine.ts`, `push.ts`) sees only `Transport`; everything else the
 * settings page and the service want - usage, devices, deleting, exporting - is
 * `Backend`. The real one is Google Drive (`drive.ts`); the tests run two
 * "machines" against an in-memory fake, which is why none of the merge logic
 * knows or cares where a segment physically lives.
 */
import type { SyncAccountInfo, SyncDevice } from '../../shared/sync.js'

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

  /** Google asked us to slow down, or is having a bad moment. Not a failure to report loudly. */
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

/** A `Transport` plus the things the settings page can ask about the cloud copy. */
export interface Backend extends Transport {
  /** How much this app has stored, and across how many devices. */
  usage(): Promise<Pick<SyncAccountInfo, 'bytesUsed' | 'activeDevices'>>
  devices(): Promise<SyncDevice[]>
  /** Whether the cloud holds anything written by THIS device. False after the user cleared it. */
  hasOwnData(): Promise<boolean>
  /** Every file of every device, concatenated. Each segment starts with its own header line. */
  exportAll(): Promise<string>
  /** Delete everything this app stored for the account. */
  deleteAll(): Promise<void>
}
