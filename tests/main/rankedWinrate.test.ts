import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClassName } from '../../src/shared/domain'
import { getRankedWinrateByOpponent } from '../../src/main/ipc/helper'
import { createMigratedTestDb, insertMatch, removeTestDb, type TestDb } from '../helpers/db'

let testDb: TestDb | undefined

type SeedRow = {
  oppo: string
  first: boolean
  win: boolean
  mode: string
  cr?: number | null
}

async function seed(rows: SeedRow[]): Promise<void> {
  const playedAt = new Date('2026-05-10T12:00:00Z')
  for (const r of rows) {
    await insertMatch({
      result: r.win,
      play_order: r.first ? 'first' : 'second',
      my_class: 'elf',
      oppo_class: r.oppo,
      mode: r.mode,
      current_cr: r.cr ?? null,
      playedAt
    })
  }
}

describe('getRankedWinrateByOpponent', () => {
  beforeEach(async () => {
    testDb = await createMigratedTestDb()
  })

  afterEach(async () => {
    await removeTestDb(testDb)
    testDb = undefined
  })

  it('returns a bucket for every class, not only the ones that were faced', async () => {
    // The chart used to grow and shrink between filters because the result
    // shape followed the data. A class never faced is information too.
    await seed([
      { oppo: 'royal', first: true, win: true, mode: 'ranked' },
      { oppo: 'dragon', first: false, win: false, mode: 'ranked' }
    ])

    const stats = await getRankedWinrateByOpponent({ myClass: 'elf' as ClassName, rangeKey: 'all' })
    const allClasses = Object.values(ClassName).map(String)

    expect(Object.keys(stats.byOpponent).sort()).toEqual([...allClasses].sort())
    expect(stats.byOpponent.witch).toEqual({
      first: { wins: 0, total: 0, winRate: 0 },
      second: { wins: 0, total: 0, winRate: 0 },
      all: { wins: 0, total: 0, winRate: 0 }
    })
  })

  it('splits wins by play order and rolls them into the overall figures', async () => {
    await seed([
      { oppo: 'royal', first: true, win: true, mode: 'ranked' },
      { oppo: 'royal', first: true, win: false, mode: 'ranked' },
      { oppo: 'royal', first: false, win: true, mode: 'ranked' }
    ])

    const stats = await getRankedWinrateByOpponent({ myClass: 'elf' as ClassName, rangeKey: 'all' })

    expect(stats.byOpponent.royal.first).toEqual({ wins: 1, total: 2, winRate: 50 })
    expect(stats.byOpponent.royal.second).toEqual({ wins: 1, total: 1, winRate: 100 })
    expect(stats.byOpponent.royal.all.total).toBe(3)
    expect(stats.overall.all).toEqual(stats.byOpponent.royal.all)
  })

  it('counts every mode when asked for all of them', async () => {
    await seed([
      { oppo: 'royal', first: true, win: true, mode: 'ranked', cr: 1800 },
      { oppo: 'royal', first: true, win: true, mode: 'twoPick' },
      { oppo: 'royal', first: false, win: false, mode: 'unknown' }
    ])

    const ranked = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      gameMode: 'ranked',
      rangeKey: 'all'
    })
    const all = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      gameMode: 'all',
      rangeKey: 'all'
    })

    expect(ranked.overall.all.total).toBe(1)
    expect(all.overall.all.total).toBe(3)
  })

  it('keeps guessed modes out of the free-play bucket', async () => {
    // `unknown` exists precisely so a recognition failure does not inflate the
    // 自由對戰 statistics.
    await seed([
      { oppo: 'royal', first: true, win: true, mode: 'unranked' },
      { oppo: 'royal', first: true, win: false, mode: 'unknown' },
      { oppo: 'royal', first: true, win: false, mode: 'unknown' }
    ])

    const unranked = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      gameMode: 'unranked',
      rangeKey: 'all'
    })
    const unrecognised = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      gameMode: 'unknown',
      rangeKey: 'all'
    })

    expect(unranked.overall.all).toEqual({ wins: 1, total: 1, winRate: 100 })
    expect(unrecognised.overall.all.total).toBe(2)
  })

  it('counts only the most recent N matches when a limit is given', async () => {
    // Ten losses, then two wins. A limit of 2 must see the two wins - the cap
    // is applied to the newest matches, not to whichever rows SQLite hands back.
    const base = new Date('2026-05-10T12:00:00Z').getTime()
    for (let i = 0; i < 12; i++) {
      await insertMatch({
        result: i >= 10,
        play_order: 'first',
        my_class: 'elf',
        oppo_class: 'royal',
        mode: 'ranked',
        playedAt: new Date(base + i * 60_000)
      })
    }

    const capped = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      rangeKey: 'all',
      limit: 2
    })
    const uncapped = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      rangeKey: 'all'
    })

    expect(capped.overall.all).toEqual({ wins: 2, total: 2, winRate: 100 })
    expect(capped.limit).toBe(2)
    expect(uncapped.overall.all.total).toBe(12)
    expect(uncapped.limit).toBeNull()
  })

  it('applies the limit after the other filters, not before them', async () => {
    // The cap counts the newest matches that already pass the mode filter;
    // taking the newest 2 matches overall would have found only twoPick rows.
    const base = new Date('2026-05-10T12:00:00Z').getTime()
    const rows: Array<{ mode: string; win: boolean }> = [
      { mode: 'ranked', win: false },
      { mode: 'ranked', win: true },
      { mode: 'ranked', win: true },
      { mode: 'twoPick', win: false },
      { mode: 'twoPick', win: false }
    ]
    for (const [i, r] of rows.entries()) {
      await insertMatch({
        result: r.win,
        play_order: 'first',
        my_class: 'elf',
        oppo_class: 'royal',
        mode: r.mode,
        playedAt: new Date(base + i * 60_000)
      })
    }

    const stats = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      gameMode: 'ranked',
      rangeKey: 'all',
      limit: 2
    })

    expect(stats.overall.all).toEqual({ wins: 2, total: 2, winRate: 100 })
  })

  it('treats a limit below one match as no limit at all', async () => {
    await seed([
      { oppo: 'royal', first: true, win: true, mode: 'ranked' },
      { oppo: 'royal', first: true, win: false, mode: 'ranked' }
    ])

    const stats = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      rangeKey: 'all',
      limit: 0
    })

    expect(stats.overall.all.total).toBe(2)
    expect(stats.limit).toBeNull()
  })

  it('matches nothing when a CR range is applied to a mode without CR', async () => {
    // Documents why the UI disables the CR switch outside ranked: only ranked
    // matches carry `current_cr`, so the filter would silently empty the chart.
    await seed([{ oppo: 'royal', first: true, win: true, mode: 'twoPick' }])

    const stats = await getRankedWinrateByOpponent({
      myClass: 'elf' as ClassName,
      gameMode: 'twoPick',
      rangeKey: 'all',
      crMin: 0,
      crMax: 3000
    })

    expect(stats.overall.all.total).toBe(0)
  })
})
