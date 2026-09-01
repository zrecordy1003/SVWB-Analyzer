/**
 * The card image cache.
 *
 * Two things here are worth more than the rest: that `parseCardImageUrl`
 * refuses anything it does not fully recognise (it is the only place a
 * renderer-supplied string becomes both a file path and an outbound URL), and
 * that eviction actually bounds the directory.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  cacheFilePath,
  cardImageCacheStats,
  clearCardImageCache,
  DEFAULT_CACHE_LIMIT_BYTES,
  evictCardImages,
  parseCardImageUrl,
  portalImageUrl,
  resolveCardImage,
  setCardImageFetchForTests
} from '../../src/main/data/cardImages'

const HASH = '0a8181b6031d489c9b3d1d14466bef44'
const OTHER = '1acd3046188c457d877de9cf45279cc5'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-cards-'))
})

afterEach(async () => {
  setCardImageFetchForTests(null)
  await fs.rm(root, { recursive: true, force: true })
})

const png = (bytes: number): Response =>
  new Response(Buffer.alloc(bytes, 1), { status: 200, headers: { 'content-type': 'image/png' } })

describe('parseCardImageUrl', () => {
  it('reads both variants', () => {
    expect(parseCardImageUrl(`svwb-card://list/${HASH}`)).toEqual({ variant: 'list', hash: HASH })
    expect(parseCardImageUrl(`svwb-card://card/${HASH}`)).toEqual({ variant: 'card', hash: HASH })
  })

  it('tolerates a .png suffix and uppercase hex', () => {
    expect(parseCardImageUrl(`svwb-card://list/${HASH.toUpperCase()}.png`)).toEqual({
      variant: 'list',
      hash: HASH
    })
  })

  it('refuses a path that is not exactly a 32-hex hash', () => {
    for (const bad of [
      `svwb-card://list/${HASH}extra`,
      'svwb-card://list/short',
      'svwb-card://list/',
      `svwb-card://list/${HASH}/../../etc/passwd`,
      'svwb-card://list/..%2F..%2Fsecret',
      `svwb-card://list/${HASH.replace('a', 'z')}`
    ]) {
      expect(parseCardImageUrl(bad), bad).toBeNull()
    }
  })

  it('refuses unknown variants and other schemes', () => {
    expect(parseCardImageUrl(`svwb-card://full/${HASH}`)).toBeNull()
    expect(parseCardImageUrl(`svwb-card://../${HASH}`)).toBeNull()
    expect(parseCardImageUrl(`https://shadowverse-wb.com/list/${HASH}`)).toBeNull()
    expect(parseCardImageUrl('not a url')).toBeNull()
  })
})

describe('paths and urls', () => {
  it('splits the cache by language, because the art differs per language', () => {
    const a = cacheFilePath(root, { variant: 'list', hash: HASH }, 'cht')
    const b = cacheFilePath(root, { variant: 'list', hash: HASH }, 'ja')
    expect(a).not.toBe(b)
    expect(a.endsWith(path.join('cht', 'list', `${HASH}.png`))).toBe(true)
  })

  it('refuses to build a path from a language it does not recognise', () => {
    expect(() => cacheFilePath(root, { variant: 'list', hash: HASH }, '../..' as never)).toThrow()
  })

  it('keeps the two variants on their own portal paths', () => {
    expect(portalImageUrl({ variant: 'list', hash: HASH }, 'cht')).toContain(
      `/uploads/card_image/cht/list/${HASH}.png`
    )
    expect(portalImageUrl({ variant: 'card', hash: HASH }, 'cht')).toContain('/cht/card/')
  })
})

describe('resolveCardImage', () => {
  it('downloads on a miss and serves from disk afterwards', async () => {
    let calls = 0
    setCardImageFetchForTests(async () => {
      calls++
      return png(1024)
    })

    const first = await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    expect(first).toBeTruthy()
    expect((await fs.stat(first!)).size).toBe(1024)

    const second = await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  it('collapses concurrent requests for the same image into one download', async () => {
    let calls = 0
    setCardImageFetchForTests(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return png(512)
    })

    // A deck view mounts many images at once, several of them the same card.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
      )
    )

    expect(new Set(results).size).toBe(1)
    expect(calls).toBe(1)
  })

  it('returns null instead of throwing when the portal refuses', async () => {
    setCardImageFetchForTests(async () => new Response('', { status: 403 }))
    expect(
      await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    ).toBeNull()
  })

  it('returns null when the network fails, leaving no partial file behind', async () => {
    setCardImageFetchForTests(async () => {
      throw new Error('offline')
    })
    expect(
      await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    ).toBeNull()
    expect(await cardImageCacheStats(root)).toEqual({ files: 0, bytes: 0 })
  })

  it('ignores an empty body rather than caching a zero-byte image', async () => {
    setCardImageFetchForTests(async () => png(0))
    expect(
      await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    ).toBeNull()
    expect((await cardImageCacheStats(root)).files).toBe(0)
  })

  it('touches a cache hit so it counts as recently used', async () => {
    setCardImageFetchForTests(async () => png(256))
    const file = (await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' }))!

    const old = new Date(Date.now() - 60_000)
    await fs.utimes(file, old, old)
    const before = (await fs.stat(file)).mtimeMs

    await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(before)
  })
})

describe('eviction', () => {
  async function seed(name: string, size: number, ageMs: number): Promise<string> {
    const file = path.join(root, 'cht', 'list', `${name}.png`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, Buffer.alloc(size, 1))
    const when = new Date(Date.now() - ageMs)
    await fs.utimes(file, when, when)
    return file
  }

  it('does nothing while the cache is under the cap', async () => {
    await seed(HASH, 1000, 0)
    expect(await evictCardImages(root, 10_000)).toEqual({ deleted: 0, bytes: 0 })
    expect((await cardImageCacheStats(root)).files).toBe(1)
  })

  it('deletes the least recently used first', async () => {
    const oldest = await seed('a'.repeat(32), 1000, 90_000)
    const middle = await seed('b'.repeat(32), 1000, 60_000)
    const newest = await seed('c'.repeat(32), 1000, 0)

    const result = await evictCardImages(root, 2000)
    expect(result.deleted).toBeGreaterThan(0)

    // Evicts past the cap on purpose, so the next write does not evict again.
    expect((await cardImageCacheStats(root)).bytes).toBeLessThanOrEqual(2000 * 0.85)
    await expect(fs.access(oldest)).rejects.toThrow()
    await expect(fs.access(newest)).resolves.toBeUndefined()
    void middle
  })

  it('bounds the directory when downloads keep coming', async () => {
    setCardImageFetchForTests(async () => png(400))
    for (let i = 0; i < 12; i++) {
      const hash = i.toString(16).padStart(32, '0')
      await resolveCardImage({ variant: 'list', hash }, { root, lang: 'cht', maxBytes: 2000 })
    }
    expect((await cardImageCacheStats(root)).bytes).toBeLessThanOrEqual(2000)
  })

  it('has a sane default ceiling', () => {
    expect(DEFAULT_CACHE_LIMIT_BYTES).toBe(600 * 1024 * 1024)
  })
})

describe('clearing', () => {
  it('empties the cache but leaves a usable directory', async () => {
    setCardImageFetchForTests(async () => png(128))
    await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    await resolveCardImage({ variant: 'card', hash: OTHER }, { root, lang: 'ja' })
    expect((await cardImageCacheStats(root)).files).toBe(2)

    await clearCardImageCache(root)
    expect(await cardImageCacheStats(root)).toEqual({ files: 0, bytes: 0 })

    // Still writable afterwards - "clear" must not break the feature.
    const again = await resolveCardImage({ variant: 'list', hash: HASH }, { root, lang: 'cht' })
    expect(again).toBeTruthy()
  })

  it('reports zero for a directory that does not exist', async () => {
    expect(await cardImageCacheStats(path.join(root, 'nope'))).toEqual({ files: 0, bytes: 0 })
  })
})
