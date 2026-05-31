import { describe, expect, it } from 'vitest'
import { getStatsCacheVersion, invalidateStatsCaches } from '../../src/main/statsCache'

describe('stats cache versioning', () => {
  it('increments monotonically when caches are invalidated', () => {
    const before = getStatsCacheVersion()

    invalidateStatsCaches()
    invalidateStatsCaches()

    expect(getStatsCacheVersion()).toBe(before + 2)
  })
})
