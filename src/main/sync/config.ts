import { app } from 'electron'

/**
 * Where the sync server is.
 *
 * Empty until the Worker is deployed (`server/sync/README.md`), and an empty
 * value means sync is INERT whatever the settings say - the settings page says
 * so rather than showing a switch that does nothing, the same stance as
 * `telemetry/config.ts`.
 *
 * Compiled into the installer and not changeable afterwards, so when it is
 * filled in, the old URL has to keep answering for as long as old versions are
 * in the wild. That is the argument for keeping IDENTITY (who you are) behind
 * the Worker rather than baked into the app: the Worker can change its mind
 * about Google, or add another provider, without a release.
 *
 * `SVWB_SYNC_URL` overrides it at runtime, which is how a build from source
 * talks to `wrangler dev`, and how the e2e suite talks to its own Worker.
 */
const BUILT_IN_ENDPOINT = ''

export function syncEndpoint(): string | null {
  const override = (process.env.SVWB_SYNC_URL ?? '').trim()
  // An unpackaged build has no endpoint unless one is typed: a development
  // database holds seeded and half-migrated data, and it must not be able to
  // reach anyone's account by accident. Typing the URL is a statement of intent.
  if (!app.isPackaged && !override) return null
  const raw = override || BUILT_IN_ENDPOINT
  if (!raw) return null
  try {
    const url = new URL(raw)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !local) return null
    return url.origin
  } catch {
    return null
  }
}
