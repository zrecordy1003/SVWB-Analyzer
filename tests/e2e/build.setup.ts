/**
 * Builds the bundles the E2E suite drives.
 *
 * This is a Playwright `setup` project rather than a step in an npm script, so
 * that "the tests ran against the current source" is a fact about the test
 * graph instead of something the fixture has to detect after the fact. The
 * previous arrangement compared mtimes inside `app.ts` and could only guess;
 * see the config's header for what that missed.
 *
 * `electron-vite build` is incremental enough that a no-op rebuild is a couple
 * of seconds, which is cheap next to booting Electron once per test. When even
 * that is too slow - iterating on a single spec - `pnpm test:e2e:only` passes
 * `--no-deps` and skips this.
 *
 * Deliberately NOT `pnpm build:win`: the Rust engine, the vision addon and the
 * capture tool are built by their own commands and cached by CI, and rebuilding
 * them here would put a Cargo link step in front of every E2E run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as setup, expect } from '@playwright/test'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

setup('build the main, preload and renderer bundles', () => {
  execFileSync('pnpm', ['exec', 'electron-vite', 'build'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    // pnpm is a shell script on Windows; without this, spawn cannot find it.
    shell: true
  })

  // The bundle the harness actually launches. Asserted rather than assumed so a
  // build that succeeds while emitting nothing useful fails here, next to the
  // command that was supposed to produce it, instead of as a confusing
  // "main window never appeared" thirty seconds later.
  for (const artifact of [
    join('out', 'main', 'index.js'),
    join('out', 'preload', 'index.mjs'),
    join('out', 'renderer', 'index.html'),
    join('out', 'renderer', 'hud.html')
  ]) {
    expect(existsSync(join(PROJECT_ROOT, artifact)), `${artifact} was not built`).toBe(true)
  }
})
