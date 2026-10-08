/**
 * What the renderer is told about cross-device sync.
 *
 * Plan: `docs/account-sync-plan.md`. Everything here is a view for the settings
 * page; the data itself never crosses this boundary - the renderer cannot read
 * the cloud, only ask main to run a round and report how it went.
 */

export interface SyncStatus {
  /** The build knows where the sync server is. False in builds made before the Worker exists, and in unpackaged ones. */
  configured: boolean
  signedIn: boolean
  email: string | null
  /** The Google profile picture as a `data:` URL (the renderer's CSP allows no remote images), or null. */
  avatar: string | null
  /** The account's display name, for a tooltip. */
  displayName: string | null
  /** Signed in AND the switch is on. Sync only ever runs when this is true. */
  enabled: boolean
  syncing: boolean
  /** Epoch ms of the last round that completed. */
  lastSyncAt: number | null
  lastError: string | null
  /** Local changes not yet uploaded. */
  pending: number
  /** Another device wrote data this version cannot read yet; an update will pick it up. */
  needsUpdate: boolean
  /** The server asked this app to stay away until then (kill switch or rate limit). */
  backoffUntil: number | null
  /** `safeStorage` is unavailable, so the sign-in lives in memory and is lost on restart. */
  memoryOnlyCredentials: boolean
  deviceId: string | null
}

/** The answer to "turn it on": done, or a question the user has to answer first (J-1). */
export type SyncEnableResult =
  | { needsChoice: false; status: SyncStatus }
  | { needsChoice: true; status: SyncStatus }

/** What to do with the games already on this machine when the cloud also has some. */
export type SyncFirstChoice = 'merge' | 'cloud'

export interface SyncAccountInfo {
  email: string
  name: string | null
  bytesUsed: number
  quotaBytes: number
  activeDevices: number
  syncRoundsToday: number
  roundsPerDay: number
}

export interface SyncDevice {
  id: string
  name: string
  appVersion: string
  lastSeenAt: number
  lastPushAt: number | null
  active: boolean
  self: boolean
}

export interface SyncBackup {
  file: string
  createdAt: number
  reason: string
  bytes: number
}
