/**
 * The class emblem cache.
 *
 * Three things here carry weight: that `parseClassIconUrl` admits nothing but
 * the eight known names (it is the only place a renderer string becomes both a
 * file path and an outbound URL), that a stale copy survives a failed
 * revalidation, and that a 200 carrying the portal's HTML error page is not
 * cached as if it were an emblem.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLASS_ICON_NAMES,
  classIconCacheStats,
  classIconFilePath,
  classIconRevalidationsSettledForTests,
  clearClassIconCache,
  parseClassIconUrl,
  portalClassIconUrl,
  resolveClassIcon,
  setClassIconFetchForTests
} from '../../src/main/data/classIcons'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-class-icons-'))
})

afterEach(async () => {
  setClassIconFetchForTests(null)
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * Age a cached emblem by `days`, so the 30-day window can be crossed without
 * the test waiting a month or the production constant being made testable.
 */
const backdate = async (file: string, days: number): Promise<void> => {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  await fs.utimes(file, when, when)
}

const svg = (fill = '#439159'): Response =>
  new Response(`<svg xmlns="http://www.w3.org/2000/svg"><path fill="${fill}"/></svg>`, {
    status: 200,
    headers: { 'content-type': 'image/svg+xml' }
  })

describe('parseClassIconUrl', () => {
  it('reads every class the portal draws', () => {
    for (const name of CLASS_ICON_NAMES) {
      expect(parseClassIconUrl(`svwb-card://class/${name}.svg`)).toBe(name)
    }
  })

  it('tolerates a missing suffix and mixed case', () => {
    expect(parseClassIconUrl('svwb-card://class/elf')).toBe('elf')
    expect(parseClassIconUrl('svwb-card://class/NIGHTMARE.SVG')).toBe('nightmare')
  })

  it('admits nothing outside the eight names', () => {
    for (const bad of [
      'svwb-card://class/',
      'svwb-card://class/forestcraft',
      'svwb-card://class/elf.png',
      'svwb-card://class/elf/../../etc/passwd',
      'svwb-card://class/..%2F..%2Fsecret',
      'svwb-card://class/elf%00.svg',
      'not a url'
    ]) {
      expect(parseClassIconUrl(bad), bad).toBeNull()
    }
  })

  it('leaves card art to the card parser, and other schemes to nobody', () => {
    expect(parseClassIconUrl('svwb-card://list/0a8181b6031d489c9b3d1d14466bef44')).toBeNull()
    expect(
      parseClassIconUrl(
        'https://shadowverse-wb.com/assets/images/common/common/class/class_elf.svg'
      )
    ).toBeNull()
  })
})

describe('paths and urls', () => {
  it('keeps one file per class, with no language in the path', () => {
    // Card art is per-language; an emblem is the same picture in all five, and
    // splitting it by language would mean fetching the same bytes five times.
    expect(path.basename(classIconFilePath(root, 'elf'))).toBe('class_elf.svg')
    expect(path.dirname(classIconFilePath(root, 'elf'))).toBe(root)
  })

  it('points at the portal path that is NOT content-hashed', () => {
    expect(portalClassIconUrl('nemesis')).toBe(
      'https://shadowverse-wb.com/assets/images/common/common/class/class_nemesis.svg'
    )
  })
})

describe('resolveClassIcon', () => {
  it('downloads once and serves the cached copy after', async () => {
    const fetchMock = vi.fn(async () => svg())
    setClassIconFetchForTests(fetchMock)

    const first = await resolveClassIcon('elf', { root })
    expect(first).toBe(classIconFilePath(root, 'elf'))
    expect(await fs.readFile(first!, 'utf8')).toContain('#439159')

    const second = await resolveClassIcon('elf', { root })
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces the seven requests a dropdown makes at once', async () => {
    const fetchMock = vi.fn(async () => svg())
    setClassIconFetchForTests(fetchMock)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveClassIcon('witch', { root }))
    )
    expect(new Set(results).size).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-fetches once the copy on disk is older than the window', async () => {
    setClassIconFetchForTests(async () => svg('#535fa3'))
    const file = await resolveClassIcon('witch', { root })
    await backdate(file!, 60)

    const fetchMock = vi.fn(async () => svg('#111111'))
    setClassIconFetchForTests(fetchMock)
    // The stale copy is handed back immediately rather than blocking on the
    // revalidation - the point is that an <img> never waits on one - so the
    // fresh bytes land a tick later.
    expect(await resolveClassIcon('witch', { root })).toBe(file)
    // Awaited, not polled. The revalidation is a promise no caller holds, so
    // this used to wait for the bytes to appear on disk with a timeout - and
    // the length of that wait was set by how busy the machine was, not by
    // anything here. It went red in a full parallel run twice and never on its
    // own, and widening the timeout the first time only made it rarer.
    await classIconRevalidationsSettledForTests()
    expect(await fs.readFile(file!, 'utf8')).toContain('#111111')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a fresh copy alone', async () => {
    const fetchMock = vi.fn(async () => svg())
    setClassIconFetchForTests(fetchMock)
    await resolveClassIcon('witch', { root })
    await resolveClassIcon('witch', { root })
    // Not merely "cached": a read must not touch mtime either, or an emblem in
    // daily use would reset its own clock and never be revalidated.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps serving a stale copy when revalidation fails', async () => {
    setClassIconFetchForTests(async () => svg('#a05a12'))
    const file = await resolveClassIcon('dragon', { root })
    await backdate(file!, 60)

    const fetchMock = vi.fn(async () => {
      throw new Error('offline')
    })
    setClassIconFetchForTests(fetchMock)
    expect(await resolveClassIcon('dragon', { root })).toBe(file)
    // Same seam, same reason - this one was waiting on the call count of a
    // fetch started by that unheld promise.
    await classIconRevalidationsSettledForTests()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(file!, 'utf8')).toContain('#a05a12')
  })

  it('gives up rather than caching anything when there is nothing on disk', async () => {
    setClassIconFetchForTests(async () => new Response('', { status: 404 }))
    expect(await resolveClassIcon('bishop', { root })).toBeNull()
    expect(await classIconCacheStats(root)).toEqual({ files: 0, bytes: 0 })
  })

  it('refuses an HTML error page wearing a 200', async () => {
    // A wrong asset path on the portal answers with the site's 29KB error
    // document. Caching that would pin a broken emblem for a month.
    setClassIconFetchForTests(
      async () =>
        new Response('<!DOCTYPE html>\n<html lang="en"><head>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
    )
    expect(await resolveClassIcon('royal', { root })).toBeNull()
    expect(await classIconCacheStats(root)).toEqual({ files: 0, bytes: 0 })
  })

  it('refuses a body far too large to be an emblem', async () => {
    setClassIconFetchForTests(
      async () => new Response(`<svg>${'x'.repeat(70 * 1024)}</svg>`, { status: 200 })
    )
    expect(await resolveClassIcon('nemesis', { root })).toBeNull()
  })
})

describe('cache bookkeeping', () => {
  it('counts what has been fetched, and clear takes it all back', async () => {
    setClassIconFetchForTests(async () => svg())
    await resolveClassIcon('elf', { root })
    await resolveClassIcon('royal', { root })

    const stats = await classIconCacheStats(root)
    expect(stats.files).toBe(2)
    expect(stats.bytes).toBeGreaterThan(0)

    await clearClassIconCache(root)
    expect(await classIconCacheStats(root)).toEqual({ files: 0, bytes: 0 })
  })
})
