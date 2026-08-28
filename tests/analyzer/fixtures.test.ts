import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  analyzerFixtureDir,
  loadAnalyzerFixtureManifest,
  resolveFixtureScreenshot
} from '../helpers/analyzerFixtures'

describe('analyzer fixture manifest', () => {
  it('keeps fixture metadata valid and ready for screenshot-backed recognition tests', () => {
    const manifest = loadAnalyzerFixtureManifest()
    expect(manifest.version).toBe(1)
    expect(Array.isArray(manifest.cases)).toBe(true)

    const ids = new Set<string>()
    for (const fixture of manifest.cases) {
      expect(fixture.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
      expect(ids.has(fixture.id)).toBe(false)
      ids.add(fixture.id)

      expect(typeof fixture.screenshot).toBe('string')
      expect(fixture.screenshot.length).toBeGreaterThan(0)
      expect(fixture.expected).toBeTypeOf('object')

      const screenshot = resolveFixtureScreenshot(fixture)
      expect(path.relative(analyzerFixtureDir, screenshot)).not.toMatch(/^\.\./)
      expect(fs.existsSync(screenshot)).toBe(true)
    }
  })

  // NOTE: there used to be a second case here asserting the manifest had at
  // least one entry, guarded by `it.skipIf(cases.length === 0)` - so it skipped
  // in precisely the situation where it would have failed, and could never
  // report anything. Removed rather than left as decorative coverage.
  //
  // Real screenshot-backed recognition assertions currently live elsewhere:
  // `tests/fixtures/captures/` (note: no `s`) holds the actual captures, checked by
  // `tools/vision-node-addon/check-*.cjs` against the Rust matcher. See the
  // README in `tests/fixtures/analyzer` before adding cases to this manifest.
})
