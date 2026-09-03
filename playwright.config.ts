import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests that drive the real Electron app.
 *
 * Kept apart from vitest by extension, not by config: vitest owns
 * `tests/**\/*.test.ts`, these are `*.spec.ts`. Nothing here is a browser
 * project - Playwright is used purely as the Electron driver, which is why
 * `pnpm install` never had to download Chromium.
 *
 * # The build is a project, not a precondition
 *
 * These tests drive `out/`, so a stale build silently tests stale code. That
 * cost a false green once - a deliberately reintroduced bug the suite
 * cheerfully failed to notice - and the fix used to be an mtime comparison
 * inside the fixture, which could only ever be a guess: it never looked at
 * `resources/`, `electron.vite.config.ts` or `package.json`, and a
 * `git checkout` reorders mtimes for reasons that have nothing to do with
 * staleness.
 *
 * So the build is a `setup` project that `e2e` depends on. It is now part of
 * the test graph rather than something the harness has to detect, and
 * `--no-deps` (see `test:e2e:only`) is the documented way to skip it while
 * iterating on a spec.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // The app takes a single-instance lock and spawns the engine and the capture
  // tool. Two copies at once is not a scenario worth making work.
  //
  // (The lock itself is keyed on the profile directory, and every test already
  // gets its own `--user-data-dir` - so it is the engine and capture-tool
  // processes, not the lock, that keep this at one. Raise it only with a
  // measured green run to show for it.)
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  /**
   * Retries exist for the launch, not for the assertions.
   *
   * Every test here boots a real Electron app, which starts a splash window,
   * runs migrations through `svwb-engine migrate` and spawns the engine. On a
   * shared CI runner that occasionally loses a race it has nothing to do with
   * the code under test. Locally, a retry would hide a real flake from the
   * person best placed to fix it, so there are none.
   */
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],
  // Launch to first paint is under a second; the ceiling is here for the
  // scenarios that wait on a simulated download running to completion.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  projects: [
    {
      name: 'setup',
      testMatch: /build\.setup\.ts/,
      // The build itself, not a test of the build. It gets its own ceiling
      // because a cold `electron-vite build` is minutes, not seconds.
      timeout: 10 * 60_000
    },
    {
      name: 'e2e',
      testIgnore: /build\.setup\.ts/,
      dependencies: ['setup']
    }
  ]
})
