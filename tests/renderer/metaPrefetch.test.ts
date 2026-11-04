/**
 * 環境頁「我的職業」的預設值。
 *
 * 存過的選擇永遠優先；沒存過才看最近一場打的職業，一場都沒有（或查不到）就
 * 不填，讓頁面用自己的預設。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { withPlayedClass } from '../../src/renderer/src/components/Meta/metaPrefetch'

const stubRecent = (impl: () => Promise<unknown>): ReturnType<typeof vi.fn> => {
  const fetchRecent = vi.fn(impl)
  vi.stubGlobal('window', { matches: { fetchRecent } })
  return fetchRecent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withPlayedClass', () => {
  it('keeps a saved class and does not look anything up', async () => {
    const fetchRecent = stubRecent(async () => [{ my_class: 'witch' }])
    expect(await withPlayedClass({ myClass: 'royal', days: 7 })).toEqual({
      myClass: 'royal',
      days: 7
    })
    expect(fetchRecent).not.toHaveBeenCalled()
  })

  it('falls back to the class of the latest match, across every mode', async () => {
    const fetchRecent = stubRecent(async () => [{ my_class: 'witch' }])
    expect(await withPlayedClass({ days: 30 })).toEqual({ myClass: 'witch', days: 30 })
    expect(fetchRecent).toHaveBeenCalledWith(1, 'all')
  })

  it('leaves the class unset with no matches, a bad class, or a failed lookup', async () => {
    stubRecent(async () => [])
    expect(await withPlayedClass({})).toEqual({})
    stubRecent(async () => [{ my_class: 'not-a-class' }])
    expect(await withPlayedClass({})).toEqual({})
    stubRecent(async () => {
      throw new Error('ipc down')
    })
    expect(await withPlayedClass({})).toEqual({})
  })
})
