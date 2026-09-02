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
