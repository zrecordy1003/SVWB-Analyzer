/**
 * Launches the real app for a test and hands back its main window.
 *
 * Three things here are not obvious and were all found the hard way:
 *
 * `firstWindow()` returns the **splash**, not the app - the splash is created
 * first and lives for about a second. Windows have to be picked by URL.
 *
 * The app must already be built. That is now the `setup` project's job
 * (`build.setup.ts`), not a check in here; this file used to compare mtimes
 * between `out/` and `src/` and could only ever guess.
 *
 * And every run gets its own `--user-data-dir`. Without it the single-instance
 * lock makes the second launch exit(0) with no window, and worse, the test
 * would be reading and migrating the developer's real match database.
 */
import { mkdtempSync, rmSync } from 'node:fs'
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

/** Scenarios the dev update simulator understands. See `main/updates.ts`. */
export type UpdateScenario = 'available' | 'big' | 'none' | 'error' | 'download-error' | 'real'

export type SvwbFixtures = {
  /**
   * `SVWB_UPDATE_SIM` for this test. Setting it also makes the app run its
   * background check on launch; leave it unset for tests that should not have
   * an update flow happening underneath them.
   */
  updateScenario: UpdateScenario | undefined
  /**
   * Extra command-line arguments for this launch, e.g. `['--hidden']` to
   * reproduce what the login item does.
   */
  extraArgs: string[]
  app: ElectronApplication
  /** The main window, once it exists. Never the splash. */
  window: Page
}

/**
 * The main window, once it can actually be talked to.
 *
 * Two waits, and the second one was a latent flake for a long time. A window's
 * `url()` is set when the load STARTS, so matching on it can resolve before
 * the preload script has run `contextBridge.exposeInMainWorld` - and a spec
 * whose first act is `invoke(...)` then fails with
 * `Cannot read properties of undefined (reading 'ipcRenderer')`.
 *
 * It went unnoticed because the race was usually won: startup did enough work
 * between the two that the bridge was always ready first. Moving the database
 * into its own process (`src/dbworker`) shifted that timing and the same specs
 * started losing it two runs in three - the bug was in this function all along
 * and every seed-then-read spec was exposed to it.
 */
async function mainWindowOf(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  let seen: string[] = []
  let main: Page | undefined
  while (Date.now() < deadline) {
    const windows = app.windows()
    seen = windows.map((w) => w.url())
    main = windows.find((w) => w.url().includes('renderer/index.html'))
    if (main) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!main) {
    throw new Error(`main window never appeared. Windows seen: ${JSON.stringify(seen)}`)
  }

  // The preload bridge, which is what every spec reaches for first.
  await main.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { electron?: { ipcRenderer?: unknown } }).electron?.ipcRenderer
      ),
    undefined,
    { timeout: Math.max(1000, deadline - Date.now()) }
  )
  return main
}

export const test = base.extend<SvwbFixtures>({
  updateScenario: [undefined, { option: true }],
  extraArgs: [[], { option: true }],

  app: async ({ updateScenario, extraArgs }, use, testInfo) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'svwb-e2e-'))
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    if (updateScenario) env.SVWB_UPDATE_SIM = updateScenario
    else delete env.SVWB_UPDATE_SIM

    /**
     * Point this at an installed or `--dir`-unpacked executable to run the
     * suite against a real package instead of `out/`.
     *
     * The two are not the same app. `out/` is what `pnpm start` runs and it
     * resolves resources relative to the source tree; a package resolves them
     * under `process.resourcesPath`, which is where the engine binary, the
     * migrations, the templates and `eng.traineddata.gz` either are present or
     * are not. Every failure mode in that list is invisible to a test that
     * drives `out/`, which is why this seam exists - see `packaged.spec.ts`.
     */
    const executablePath = process.env.SVWB_E2E_EXECUTABLE
    const app = await electron.launch({
      // A packaged app IS the executable, so it takes no entry argument; the
      // unpackaged one needs `.` to find `package.json`'s `main`.
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userDataDir}`, ...extraArgs],
      ...(executablePath ? { executablePath } : {}),
      cwd: PROJECT_ROOT,
      env,
      timeout: 60_000
    })

    /**
     * Tracing has to be driven by hand here.
     *
     * `use: { trace: 'on-first-retry' }` does nothing for these tests: that
     * option is applied by the fixtures that create a browser context, and
     * this one does not - it gets its context from an already-running Electron
     * app. Without this block a CI failure is one red line from the list
     * reporter, which is the whole reason a real flake in the launch path used
     * to take a local reproduction to understand.
     *
     * Started for every test and kept only for the ones that fail: a trace is
     * a few MB, and keeping the green ones would bury the interesting one.
     */
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })

    // Main-process logs are where this app says what it is doing ([Engine],
    // [DB], [Update]). Surfacing them costs nothing and turns a failed wait
    // into a readable transcript.
    const mainProcessLog: string[] = []
    app.on('console', (m) => {
      mainProcessLog.push(m.text())
      if (process.env.E2E_VERBOSE) console.log('   ·', m.text())
    })

    await use(app)

    const failed = testInfo.status !== testInfo.expectedStatus
    if (failed) {
      await app
        .context()
        .tracing.stop({ path: testInfo.outputPath('trace.zip') })
        .catch(() => {})
      await testInfo
        .attach('trace', { path: testInfo.outputPath('trace.zip'), contentType: 'application/zip' })
        .catch(() => {})
      // The main process's own account of the run. Attached rather than
      // printed: on a suite-wide failure the console becomes unreadable, and
      // this is the transcript you want next to the trace anyway.
      if (mainProcessLog.length) {
        await testInfo
          .attach('main-process.log', {
            body: mainProcessLog.join('\n'),
            contentType: 'text/plain'
          })
          .catch(() => {})
      }
    } else {
      await app
        .context()
        .tracing.stop()
        .catch(() => {})
    }

    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  },

  window: async ({ app }, use) => {
    await use(await mainWindowOf(app))
  }
})

export { expect } from '@playwright/test'
