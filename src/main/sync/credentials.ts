/**
 * Where the sign-in is kept.
 *
 * The refresh token is the only long-lived secret, and it is the one thing that
 * must not be readable from a copy of the user's files. So:
 *
 *   - encrypted with `safeStorage` (Windows DPAPI: tied to this user on this
 *     machine) into a file of its own under userData;
 *   - NOT in `config.json`, because `settings:clear` wipes that and a sign-out
 *     should be a decision, not a side effect;
 *   - NOT in the SQLite database, because that is the file that gets backed up,
 *     exported for diagnostics and, once sync is on, uploaded. A credential
 *     inside the thing it unlocks is a loop. `tests/main/syncAuth.test.ts`
 *     checks the database really has none.
 *
 * If encryption is not available (rare), nothing is written: the session lives
 * in memory and the user signs in again after a restart. Writing it in the clear
 * would be the one unrecoverable choice here, and being asked to sign in again
 * is a nuisance.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export interface Credentials {
  refreshToken: string
  email: string
  name: string | null
  /** Google profile picture URL, as of the last sign-in. Not a secret, but it is who the user is. */
  picture?: string | null
  deviceId: string
}

export interface CredentialStore {
  load(): Promise<Credentials | null>
  save(credentials: Credentials): Promise<void>
  clear(): Promise<void>
  /** False when `save` keeps the sign-in in memory only. */
  readonly persistent: boolean
}

/** What of Electron's `safeStorage` this needs, so tests can supply their own. */
export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function createFileCredentialStore(file: string, cipher: Cipher): CredentialStore {
  let memory: Credentials | null = null
  const usable = (): boolean => {
    try {
      return cipher.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  return {
    get persistent() {
      return usable()
    },
    async load() {
      if (memory) return memory
      if (!usable()) return null
      try {
        const bytes = await fs.readFile(file)
        const parsed = JSON.parse(cipher.decryptString(bytes)) as Partial<Credentials>
        if (
          typeof parsed.refreshToken === 'string' &&
          typeof parsed.email === 'string' &&
          typeof parsed.deviceId === 'string'
        ) {
          memory = {
            refreshToken: parsed.refreshToken,
            email: parsed.email,
            name: typeof parsed.name === 'string' ? parsed.name : null,
            picture: typeof parsed.picture === 'string' ? parsed.picture : null,
            deviceId: parsed.deviceId
          }
          return memory
        }
      } catch {
        /* no file, or it does not decrypt (another user, another machine): signed out */
      }
      return null
    },
    async save(credentials) {
      memory = credentials
      if (!usable()) return
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, cipher.encryptString(JSON.stringify(credentials)))
    },
    async clear() {
      memory = null
      await fs.rm(file, { force: true }).catch(() => undefined)
    }
  }
}
