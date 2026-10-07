/**
 * One round of sync: pull what others wrote, then send what this machine wrote.
 *
 * Pull before push, deliberately. A change this machine made while another
 * machine changed the same row is resolved when the remote one is applied -
 * the newer wins, and a local change that loses is dropped from the outbox
 * instead of being uploaded just to be overruled.
 *
 * This file does not know about HTTP, Google or Electron. It takes a
 * `Transport` and a database, which is what lets the tests run two machines and
 * a server in one process.
 */
import { applySegment, emptyStats, type ApplyStats } from './apply.js'
import {
  KEY_LAST_APPLIED,
  KEY_LAST_ERROR,
  KEY_LAST_SYNC_AT,
  KEY_NEEDS_UPDATE,
  cursorKey,
  getNumber,
  schemaVersion,
  setState,
  snapshotKey,
  type Db
} from './ledger.js'
import { compactIfNeeded, push, type PushResult } from './push.js'
import { parseSegment } from './segment.js'
import type { RemoteDevice, Transport } from './transport.js'
import { nowMs } from '../data/db/client.js'

export interface SyncReport {
  pulledSegments: number
  pulledSnapshots: number
  applied: ApplyStats
  pushed: PushResult
  compacted: boolean
  /** Someone else's data was written by a newer build; it is waiting, not lost. */
  needsUpdate: boolean
  /** Whether any other device has anything on the server at all. */
  remoteHasData: boolean
}

export async function syncOnce(
  db: Db,
  transport: Transport,
  ctx: {
    deviceId: string
    schemaVersion?: number
    compactAfter?: number
    /** Called once, before the first remote change of a round is applied - the moment a backup is worth taking. */
    beforeApply?: () => Promise<void>
  }
): Promise<SyncReport> {
  const mine = ctx.schemaVersion ?? (await schemaVersion(db))
  const devices = await transport.listSegments()
  const pulled = await pull(db, transport, devices, {
    deviceId: ctx.deviceId,
    schemaVersion: mine,
    beforeApply: ctx.beforeApply
  })
  const pushed = await push(db, transport, { deviceId: ctx.deviceId, schemaVersion: mine })
  const compacted = await compactIfNeeded(
    db,
    transport,
    { deviceId: ctx.deviceId, schemaVersion: mine },
    ctx.compactAfter
  )

  await setState(db, KEY_NEEDS_UPDATE, pulled.needsUpdate ? '1' : null)
  await setState(db, KEY_LAST_SYNC_AT, String(nowMs()))
  await setState(db, KEY_LAST_ERROR, null)
  if (pulled.segments + pulled.snapshots > 0) {
    await setState(db, KEY_LAST_APPLIED, String(nowMs()))
  }
  return {
    pulledSegments: pulled.segments,
    pulledSnapshots: pulled.snapshots,
    applied: pulled.stats,
    pushed,
    compacted,
    needsUpdate: pulled.needsUpdate,
    remoteHasData: devices.some((d) => d.snapshot !== null || d.segments.length > 0)
  }
}

/** What is out there, without applying anything. For the first-login question. */
export async function peekRemote(transport: Transport): Promise<{ hasData: boolean }> {
  const devices = await transport.listSegments()
  return { hasData: devices.some((d) => d.snapshot !== null || d.segments.length > 0) }
}

async function pull(
  db: Db,
  transport: Transport,
  devices: RemoteDevice[],
  ctx: { deviceId: string; schemaVersion: number; beforeApply?: () => Promise<void> }
): Promise<{ segments: number; snapshots: number; stats: ApplyStats; needsUpdate: boolean }> {
  const total = emptyStats()
  let segments = 0
  let snapshots = 0
  let needsUpdate = false
  let warned = false
  const backUpOnce = async (): Promise<void> => {
    if (warned) return
    warned = true
    // A failed backup must not stop the sync: it is insurance, not the product.
    await ctx.beforeApply?.().catch(() => undefined)
  }
  const add = (s: ApplyStats): void => {
    total.applied += s.applied
    total.kept += s.kept
    total.deleted += s.deleted
    total.mergedByName += s.mergedByName
    total.pending += s.pending
  }

  for (const dev of devices) {
    if (dev.device === ctx.deviceId) continue

    // The snapshot first, if it covers more than we have read of this device.
    let cursor = await getNumber(db, cursorKey(dev.device), 0)
    if (dev.snapshot && dev.snapshot.upToSeq > cursor) {
      const seg = parseSegment(await transport.getSnapshot(dev.device))
      if (seg === null) continue
      if (seg.header.schemaVersion > ctx.schemaVersion) {
        needsUpdate = true
        continue
      }
      await backUpOnce()
      add(
        await applySegment(db, seg, {
          selfDevice: ctx.deviceId,
          cursor: { device: dev.device, seq: dev.snapshot.upToSeq, kind: 'snapshot' }
        })
      )
      snapshots++
      cursor = dev.snapshot.upToSeq
    }

    for (const info of [...dev.segments].sort((a, b) => a.seq - b.seq)) {
      if (info.seq <= cursor) continue
      const seg = parseSegment(await transport.getSegment(dev.device, info.seq))
      // An unreadable segment stops this device here rather than skipping it:
      // moving the cursor past it would drop its changes for good.
      if (seg === null) break
      if (seg.header.schemaVersion > ctx.schemaVersion) {
        // The writer is on a newer build. Hold the cursor so an update picks
        // up exactly here; nothing is lost, and nothing after it is applied
        // out of order.
        needsUpdate = true
        break
      }
      await backUpOnce()
      add(
        await applySegment(db, seg, {
          selfDevice: ctx.deviceId,
          cursor: { device: dev.device, seq: info.seq, kind: 'segment' }
        })
      )
      segments++
      cursor = info.seq
    }
  }
  return { segments, snapshots, stats: total, needsUpdate }
}

/** Remembered for the settings page; never thrown past it. */
export async function recordError(db: Db, message: string): Promise<void> {
  await setState(db, KEY_LAST_ERROR, message.slice(0, 300))
}

export { snapshotKey }
