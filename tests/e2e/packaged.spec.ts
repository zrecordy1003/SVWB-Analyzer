/**
 * The packaged app has everything it needs on disk.
 *
 * Every other spec here drives `out/`, which is what `pnpm start` runs. That
 * build resolves its resources relative to the source tree, so it cannot fail
 * the way a package fails: a binary left out of `extraResources`, a migrations
 * directory that never got copied, a `traineddata` that is still a 132-byte
 * LFS pointer. Those are exactly the faults the release checklist has been
 * asking a human to look for by hand.
 *
 * So this one runs against a real package. Point `SVWB_E2E_EXECUTABLE` at an
 * installed `SVWB Analyzer.exe` or at the `--dir` output
 * (`dist/win-unpacked/SVWB Analyzer.exe`) and the whole suite drives that
 * instead; this file is skipped when it is unset, because against `out/` it
 * would be asserting paths that legitimately do not exist.
 *
 * No npm script for it: setting one environment variable portably across
 * PowerShell, cmd and bash is more machinery than the two lines are worth.
 *
 *     pnpm build:unpack
 *     $env:SVWB_E2E_EXECUTABLE = "dist/win-unpacked/SVWB Analyzer.exe"   # PowerShell
 *     pnpm test:e2e:only
 *
 * The assertions read the filesystem from inside the main process rather than
 * from the test, deliberately: `process.resourcesPath` is the app's own answer
 * to "where are my resources", and reconstructing it out here would be testing
 * this file's arithmetic instead of the package.
 */
import { test, expect } from './app'

const EXECUTABLE = process.env.SVWB_E2E_EXECUTABLE

test.describe('packaged resources', () => {
  test.skip(!EXECUTABLE, 'set SVWB_E2E_EXECUTABLE to a packaged build to run these')

  test('every extraResource the app resolves at runtime is present', async ({ app }) => {
    const found = await app.evaluate(async ({ app: electronApp }) => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const root = process.resourcesPath
      // Mirrors `extraResources` in package.json and the paths the code builds
      // from `process.resourcesPath` (see `data/db/initDb.ts`,
      // `recognition/engine.ts`, `recognition/engineNumbers.ts`).
      const expected = {
        engine: path.join(root, 'tools', 'svwb-engine.exe'),
        captureTool: path.join(root, 'tools', 'svwb-capture-tool.exe'),
        vision: path.join(root, 'svwb-vision.node'),
        migrations: path.join(root, 'migrations'),
        templates: path.join(root, 'templates'),
        splash: path.join(root, 'splash.html'),
        traineddata: path.join(root, 'tessdata', 'eng.traineddata.gz')
      }
      const sizes: Record<string, number> = {}
      for (const [key, target] of Object.entries(expected)) {
        sizes[key] = fs.existsSync(target) ? fs.statSync(target).size : -1
      }
      return { sizes, packaged: electronApp.isPackaged, resourcesPath: root }
    })

    expect(found.packaged, 'SVWB_E2E_EXECUTABLE did not point at a packaged app').toBe(true)

    for (const [key, size] of Object.entries(found.sizes)) {
      expect(size, `${key} is missing from ${found.resourcesPath}`).not.toBe(-1)
    }

    // A Git LFS pointer is ~132 bytes of text where a 2.9MB model should be,
    // and tesseract's failure mode for one is a bare "initialization failed".
    // The size is the only cheap way to tell the two apart.
    expect(found.sizes.traineddata, 'eng.traineddata.gz looks like an LFS pointer').toBeGreaterThan(
      100_000
    )
  })

  test('a fresh profile gets a migrated database', async ({ app, window }) => {
    // The window fixture is required, not incidental: the renderer's first
    // reads are what prove the migrated schema is actually usable, and
    // `initDb` runs `svwb-engine migrate` before anything reads.
    expect(window.url()).toContain('renderer/index.html')

    const db = await app.evaluate(async ({ app: electronApp }) => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const file = path.join(electronApp.getPath('userData'), 'db', 'app.db')
      return {
        file,
        exists: fs.existsSync(file),
        size: fs.existsSync(file) ? fs.statSync(file).size : -1
      }
    })
    expect(db.exists, `no database at ${db.file}`).toBe(true)
    expect(db.size).toBeGreaterThan(0)

    // And it answers a real query through the real IPC path, which is what
    // says the migrations ran rather than that a file was merely created.
    const count = await window.evaluate(
      () =>
        (
          window as unknown as {
            electron: { ipcRenderer: { invoke: (c: string, p: unknown) => Promise<number> } }
          }
        ).electron.ipcRenderer.invoke('matches:count', { rangeKey: 'all' }) as Promise<number>
    )
    expect(count).toBe(0)
  })
})
