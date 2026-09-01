import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests that drive the real Electron app.
 *
 * Kept apart from vitest by extension, not by config: vitest owns
 * `tests/**\/*.test.ts`, these are `*.spec.ts`. Nothing here is a browser
 * project - Playwright is used purely as the Electron driver, which is why
 * `pnpm install` never had to download Chromium.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // The app takes a single-instance lock and spawns the engine and the capture
  // tool. Two copies at once is not a scenario worth making work.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  // Launch to first paint is under a second; the ceiling is here for the
  // scenarios that wait on a simulated download running to completion.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results'
})
