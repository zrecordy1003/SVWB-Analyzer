import { app } from 'electron'

import { GOOGLE_ENDPOINTS, type GoogleConfig, type GoogleEndpoints } from './google.js'

/**
 * Which Google OAuth client sync signs in with, and where Google is.
 *
 * Sync is INERT without a client id and secret, whatever the settings say: the
 * settings page and the account button say so rather than offering a button that
 * does nothing, the same stance telemetry takes without an endpoint.
 *
 * The client is a "Desktop app" client. Google issues it a secret too, but for
 * this type the secret is not confidential - it ships in every copy - and PKCE
 * (see `google.ts`) is what actually protects the sign-in. It still does not
 * belong in the repository: it is read at BUILD time from the environment, so a
 * fork cannot accidentally sign in as us and the maintainer can rotate it.
 *
 *   MAIN_VITE_GOOGLE_CLIENT_ID / MAIN_VITE_GOOGLE_CLIENT_SECRET   (a .env file works)
 *
 * Overrides, all deliberate statements of intent:
 *
 *   SVWB_GOOGLE_CLIENT_ID / SVWB_GOOGLE_CLIENT_SECRET  a client at run time; the way
 *                                                      to sign in from a build from source
 *   SVWB_GOOGLE_BASE                                   a local fake Google
 *                                                      (`tools/sync-dev.mjs`), localhost only
 *
 * An unpackaged build has no client unless one is supplied: a development
 * database holds seeded and half-migrated data and must not be able to reach
 * anyone's Drive by accident.
 */
const BUILT_IN_ID = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? ''
const BUILT_IN_SECRET = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? ''

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Endpoints under a local base, laid out the way `FakeGoogle` serves them. */
function localEndpoints(base: URL): GoogleEndpoints {
  const o = base.origin
  return {
    auth: `${o}/o/oauth2/v2/auth`,
    token: `${o}/token`,
    revoke: `${o}/revoke`,
    drive: `${o}/drive/v3`,
    upload: `${o}/upload/drive/v3`
  }
}

export function googleConfig(): GoogleConfig | null {
  const env = process.env
  const base = (env.SVWB_GOOGLE_BASE ?? '').trim()
  if (base) {
    try {
      const url = new URL(base)
      // The only way to point sign-in anywhere but Google is a local fake.
      if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) return null
      return {
        clientId: env.SVWB_GOOGLE_CLIENT_ID?.trim() || 'fake-client.apps.googleusercontent.com',
        clientSecret: env.SVWB_GOOGLE_CLIENT_SECRET?.trim() || 'fake-client-secret',
        endpoints: localEndpoints(url)
      }
    } catch {
      return null
    }
  }

  const runtimeId = (env.SVWB_GOOGLE_CLIENT_ID ?? '').trim()
  if (!app.isPackaged && !runtimeId) return null
  const clientId = runtimeId || BUILT_IN_ID
  const clientSecret = (env.SVWB_GOOGLE_CLIENT_SECRET ?? '').trim() || BUILT_IN_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, endpoints: GOOGLE_ENDPOINTS }
}
