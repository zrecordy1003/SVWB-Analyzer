import { app } from 'electron'

/**
 * Where uploads go.
 *
 * This is compiled into every build that ships, and an installed copy only
 * ever talks to the value it was built with - a release cannot be redirected
 * afterwards. Changing it is therefore a release, not a config edit, and the
 * old URL has to keep answering for as long as old versions are in the wild.
 *
 * Empty means telemetry is inert whatever the setting says, and the settings
 * page says so - a switch that silently sends nothing would be worse than no
 * switch. That is the state of any build made before 2026-09-02.
 *
 * `SVWB_TELEMETRY_URL` overrides it at runtime so a dev build can point at
 * `wrangler dev` without editing source, the same way `SVWB_UPDATE_SIM` picks
 * the updater simulator.
 */
const BUILT_IN_ENDPOINT = 'https://telemetry.svwb-analyzer.workers.dev'

export function telemetryEndpoint(): string | null {
  const raw = (process.env.SVWB_TELEMETRY_URL ?? BUILT_IN_ENDPOINT).trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    // Anything but https is refused, except a local dev server.
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !local) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Where uploads go — which, on a development build, is nowhere.
 *
 * `telemetryEndpoint()` above answers two different questions at once, and
 * they need different answers off a packaged build:
 *
 *   reading  the published meta document (`ipc/meta.ts`) — must keep working,
 *            otherwise 環境 is a blank page every time the app runs from source
 *   writing  this machine's own matches — must NOT happen from source
 *
 * The reason is not that dev data is private; it is that a development
 * machine's database is **not a record of games played**. It holds seeded
 * demo matches, half-migrated rows, whatever the last experiment left behind.
 * `classifyRow` already refuses anything whose `source` it does not recognise,
 * so a fabricated row cannot become a bucket — but that is a filter on one
 * known mistake, and it was itself added *after* 583 seeded matches uploaded
 * themselves as trustworthy. This is the layer that does not depend on
 * guessing which mistake comes next: **an unpackaged build has no upload
 * endpoint at all.**
 *
 * The escape hatch is explicit and can only point somewhere deliberate:
 * setting `SVWB_TELEMETRY_URL` re-enables uploading, because typing a URL is
 * a statement of intent. Pointing it at `wrangler dev` is the supported way
 * to exercise the whole path; pointing it at production from a dev build is
 * possible, and is the one case where you have said so out loud.
 */
export function telemetryUploadEndpoint(): string | null {
  if (!app.isPackaged && !(process.env.SVWB_TELEMETRY_URL ?? '').trim()) return null
  return telemetryEndpoint()
}
