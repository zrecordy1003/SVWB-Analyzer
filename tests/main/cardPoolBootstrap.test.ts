/**
 * The startup card-pool bootstrap.
 *
 * What matters here is restraint, not throughput: it must fetch only what is
 * missing, stop rather than hammer a portal that is not answering, and never be
 * something the user waits on. Those are the properties a background job that
 * talks to somebody else's server has to keep.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { bootstrapCardPool } from '../../src/main/data/cardPoolBootstrap'
import { missingCardPoolSlices, syncCardPoolSlice } from '../../src/main/data/cardPool'
import { setPortalFetchForTests } from '../../src/main/data/svwbApi'
import { createMigratedTestDb, removeTestDb, testDb, type TestDb } from '../helpers/db'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

const POOL = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/deck-import/witch-pool.json'), 'utf8')
)

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

/** 7 classes across the 2 playable formats. */
const EXPECTED_SLICES = 14

let db: TestDb | undefined

beforeAll(async () => {
  db = await createMigratedTestDb()
})

afterAll(async () => {
  await removeTestDb(db)
  db = undefined
})

beforeEach(async () => {
  await testDb().deleteFrom('CardPool').execute()
  await testDb().deleteFrom('CardPoolSync').execute()
  await testDb().deleteFrom('Card').execute()
})

afterEach(() => {
  setPortalFetchForTests(null)
})

describe('bootstrapCardPool', () => {
  it('fetches every class in both formats on a cold start', async () => {
    const urls: string[] = []
    setPortalFetchForTests(async (url) => {
      urls.push(url)
      return json(POOL)
    })

    const result = await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })

    expect(result).toEqual({ done: EXPECTED_SLICES, total: EXPECTED_SLICES })
    expect(urls).toHaveLength(EXPECTED_SLICES)

    const synced = await testDb().selectFrom('CardPoolSync').selectAll().execute()
    expect(synced).toHaveLength(EXPECTED_SLICES)
    expect(synced.every((s) => s.lang === 'cht')).toBe(true)
  })

  it('asks for one class at a time, because the endpoint refuses all of them', async () => {
    const urls: string[] = []
    setPortalFetchForTests(async (url) => {
      urls.push(url)
      return json(POOL)
    })

    await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })
    expect(urls.every((u) => /class=0,\d(&|$)/.test(u))).toBe(true)
  })

  it('does nothing at all on the second launch', async () => {
    setPortalFetchForTests(async () => json(POOL))
    await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })

    let secondRun = 0
    setPortalFetchForTests(async () => {
      secondRun++
      return json(POOL)
    })

    // The whole point: this runs on every launch, so it has to be free once the
    // pool is there.
    expect(await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })).toEqual({ done: 0, total: 0 })
    expect(secondRun).toBe(0)
  })

  it('fetches only what is missing after a partial run', async () => {
    await syncCardPoolSlice(testDb(), { classId: 3, battleFormat: 2 }, 'cht').catch(() => {})
    setPortalFetchForTests(async () => json(POOL))
    await syncCardPoolSlice(testDb(), { classId: 3, battleFormat: 2 }, 'cht')

    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      return json(POOL)
    })

    const result = await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })
    expect(result.total).toBe(EXPECTED_SLICES - 1)
    expect(calls).toBe(EXPECTED_SLICES - 1)
  })

  it('treats another language as a cold start, because the text differs', async () => {
    setPortalFetchForTests(async () => json(POOL))
    await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })

    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      return json(POOL)
    })

    const result = await bootstrapCardPool(testDb(), 'ja', { gapMs: 0 })
    expect(result.total).toBe(EXPECTED_SLICES)
    expect(calls).toBe(EXPECTED_SLICES)
  })

  it('stops after consecutive failures instead of hammering the portal', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      throw new Error('offline')
    })

    const result = await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })

    expect(result.stopped).toBe(true)
    // Two slices attempted, each of which retries once inside fetchCardPool -
    // far short of fourteen. The number matters less than the ceiling.
    expect(calls).toBeLessThanOrEqual(4)
    expect(await testDb().selectFrom('CardPoolSync').selectAll().execute()).toHaveLength(0)
  })

  it('keeps going through a single blip', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      if (calls === 1) throw new Error('one bad connection')
      return json(POOL)
    })

    const result = await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })
    expect(result.stopped).toBeUndefined()
    expect(result.done).toBe(EXPECTED_SLICES)
  })

  it('stops on a shape change rather than repeating it fourteen times', async () => {
    let calls = 0
    setPortalFetchForTests(async () => {
      calls++
      // The portal answered, but with nothing we can read - retrying will not
      // help and thirteen more identical failures help nobody.
      return json({ data_headers: { result_code: 1 }, data: { card_details: {} } })
    })

    const result = await bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })
    expect(result.stopped).toBe(true)
    expect(calls).toBe(1)
  })

  it('refuses to run twice at once', async () => {
    setPortalFetchForTests(async () => json(POOL))
    const [first, second] = await Promise.all([
      bootstrapCardPool(testDb(), 'cht', { gapMs: 0 }),
      bootstrapCardPool(testDb(), 'cht', { gapMs: 0 })
    ])
    const runs = [first, second]
    expect(runs.filter((r) => r.total === EXPECTED_SLICES)).toHaveLength(1)
    expect(runs.filter((r) => r.total === 0 && r.stopped)).toHaveLength(1)
  })
})

describe('missingCardPoolSlices', () => {
  it('reports everything before any sync, and nothing after', async () => {
    const wanted = [
      { classId: 1, battleFormat: 2 },
      { classId: 2, battleFormat: 2 }
    ]
    expect(await missingCardPoolSlices(testDb(), wanted, 'cht')).toHaveLength(2)

    setPortalFetchForTests(async () => json(POOL))
    await syncCardPoolSlice(testDb(), wanted[0], 'cht')

    const missing = await missingCardPoolSlices(testDb(), wanted, 'cht')
    expect(missing).toEqual([wanted[1]])
  })
})
