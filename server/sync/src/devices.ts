/** Device listing, revoke and logout. Registration lives in auth.ts (`/token`). */
import { ApiError, json, noContent } from './http'
import { DEVICE_ID_RE } from './limits'
import type { Deps, Session } from './types'

export interface DeviceRow {
  sub: string
  id: string
  name: string
  appVersion: string
  createdAt: number
  lastSeenAt: number
  lastPushAt: number | null
  retiredAt: number | null
  revokedAt: number | null
  revivedAt: number | null
  refreshHash: string | null
  prevRefreshHash: string | null
  maxSeq: number
  schemaVersion: number | null
  snapshotSeq: number | null
  snapshotBytes: number
}

/**
 * Names are shown in a list of "your devices" on other machines, so strip
 * control characters (a newline in a device name is a rendering bug at best)
 * and bound the length.
 */
export function sanitizeText(text: string, max: number): string {
  // By code point, not a regex: a control-character class trips no-control-regex.
  const cleaned = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : ch
  }).join('')
  return cleaned.trim().slice(0, max)
}

/** The row for (sub, id), or null. `sub` is always from the token, never the request. */
export async function getDevice(deps: Deps, sub: string, id: string): Promise<DeviceRow | null> {
  if (!DEVICE_ID_RE.test(id)) return null
  return deps.db
    .prepare(`SELECT * FROM devices WHERE sub = ?1 AND id = ?2`)
    .bind(sub, id)
    .first<DeviceRow>()
}

export async function activeDeviceCount(deps: Deps, sub: string): Promise<number> {
  const row = await deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM devices WHERE sub = ?1 AND retiredAt IS NULL AND revokedAt IS NULL`
    )
    .bind(sub)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function listDevices(deps: Deps, session: Session): Promise<Response> {
  const rows = await deps.db
    .prepare(
      `SELECT id, name, appVersion, lastSeenAt, lastPushAt, retiredAt, revokedAt
       FROM devices WHERE sub = ?1 ORDER BY createdAt, id`
    )
    .bind(session.sub)
    .all<
      Pick<
        DeviceRow,
        'id' | 'name' | 'appVersion' | 'lastSeenAt' | 'lastPushAt' | 'retiredAt' | 'revokedAt'
      >
    >()
  return json({
    devices: rows.results.map((d) => ({
      id: d.id,
      name: d.name,
      appVersion: d.appVersion,
      lastSeenAt: d.lastSeenAt,
      lastPushAt: d.lastPushAt,
      active: d.retiredAt === null && d.revokedAt === null,
      self: d.id === session.deviceId
    }))
  })
}

/**
 * Revoke: the device can no longer refresh, and its access token stops working
 * on the next request (auth.ts reads the row every time). Idempotent. Any
 * device of the SAME account can be revoked, including the caller's own; one
 * belonging to another account does not exist as far as this caller can tell.
 */
export async function revokeDevice(deps: Deps, session: Session, id: string): Promise<Response> {
  const device = await getDevice(deps, session.sub, id)
  if (!device) throw new ApiError(404, 'not_found', 'No such device.')
  if (device.revokedAt === null) {
    await deps.db
      .prepare(
        `UPDATE devices SET revokedAt = ?3, refreshHash = NULL, prevRefreshHash = NULL
         WHERE sub = ?1 AND id = ?2`
      )
      .bind(session.sub, id, deps.now())
      .run()
  }
  return noContent()
}

/** POST /v1/auth/logout: revoke this device. Signing in again revives it. */
export async function logout(deps: Deps, session: Session): Promise<Response> {
  return revokeDevice(deps, session, session.deviceId)
}
