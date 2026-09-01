/**
 * Launches the real app for a test and hands back its main window.
 *
 * Three things here are not obvious and were all found the hard way:
 *
 * `firstWindow()` returns the **splash**, not the app - the splash is created
 * first and lives for about a second. Windows have to be picked by URL.
 *
 * The app must already be built. This drives `out/`, the same bundle
 * `pnpm start` runs, so a stale build silently tests stale code; the check
 * below turns that into a sentence instead of a mystery.
 *
 * And every run gets its own `--user-data-dir`. Without it the single-instance
 * lock makes the second launch exit(0) with no window, and worse, the test
 * would be reading and migrating the developer's real match database.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page
} from '@playwright/test'

// The package is `"type": "module"`, so these files load as ESM and there is no
// `__dirname` to lean on.
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BUILT_MAIN = join(PROJECT_ROOT, 'out', 'main', 'index.js')

/** Scenarios the dev update simulator understands. See `main/updates.ts`. */
export type UpdateScenario = 'available' | 'big' | 'none' | 'error' | 'download-error' | 'real'

export type SvwbFixtures = {
  /**
   * `SVWB_UPDATE_SIM` for this test. Setting it also makes the app run its
   * background check on launch; leave it unset for tests that should not have
   * an update flow happening underneath them.
   */
  updateScenario: UpdateScenario | undefined
  app: ElectronApplication
  /** The main window, once it exists. Never the splash. */
  window: Page
}

/** Newest mtime anywhere under `dir`, in ms. */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const mtime = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest
}

/**
 * Refuse to run against a build older than the source.
 *
 * This is the harness's one genuinely dangerous failure mode, and it is silent:
 * the app under test is whatever is in `out/`, so an un-rebuilt change makes
 * every test pass against the old code. It cost a false green the first time it
 * happened - a deliberately reintroduced bug that the suite cheerfully failed
 * to notice. Better to stop with a sentence.
 */
function assertBuildIsFresh(): void {
  if (!existsSync(BUILT_MAIN)) {
    throw new Error(`No build at ${BUILT_MAIN}. Run \`pnpm build\` first (or \`pnpm test:e2e\`).`)
  }
  const built = newestMtime(join(PROJECT_ROOT, 'out'))
  const source = newestMtime(join(PROJECT_ROOT, 'src'))
  if (source > built) {
    const behind = Math.round((source - built) / 1000)
    throw new Error(
      `out/ is ${behind}s older than src/ - these tests would run against stale code. ` +
        `Run \`pnpm build\` (or use \`pnpm test:e2e\`, which builds first).`
    )
  }
}

async function mainWindowOf(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  let seen: string[] = []
  while (Date.now() < deadline) {
    const windows = app.windows()
    seen = windows.map((w) => w.url())
    const main = windows.find((w) => w.url().includes('renderer/index.html'))
    if (main) return main
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`main window never appeared. Windows seen: ${JSON.stringify(seen)}`)
}

export const test = base.extend<SvwbFixtures>({
  updateScenario: [undefined, { option: true }],

  app: async ({ updateScenario }, use) => {
    assertBuildIsFresh()

    const userDataDir = mkdtempSync(join(tmpdir(), 'svwb-e2e-'))
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    if (updateScenario) env.SVWB_UPDATE_SIM = updateScenario
    else delete env.SVWB_UPDATE_SIM

    const app = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: PROJECT_ROOT,
      env,
      timeout: 60_000
    })

    // Main-process logs are where this app says what it is doing ([Engine],
    // [DB], [Update]). Surfacing them costs nothing and turns a failed wait
    // into a readable transcript.
    if (process.env.E2E_VERBOSE) app.on('console', (m) => console.log('   ·', m.text()))

    await use(app)

    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  },

  window: async ({ app }, use) => {
    await use(await mainWindowOf(app))
  }
})

export { expect } from '@playwright/test'
