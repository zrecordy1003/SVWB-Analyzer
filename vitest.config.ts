import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  /**
   * The same two aliases `electron.vite.config.ts` gives the renderer build.
   *
   * They were absent here and it did not show, because every aliased import in
   * a tested module happened to be `import type` - erased before anything had
   * to resolve it. The first VALUE import through an alias
   * (`@renderer/ipc` in `useInfiniteMatches.ts`) failed the suite with
   * "Cannot find package", which is a confusing way to be told a config is
   * incomplete.
   */
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    pool: 'threads'
  }
})
