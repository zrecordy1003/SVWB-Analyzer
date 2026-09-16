/**
 * 環境頁的算術。
 *
 * 這頁畫的是別人的資料，使用者無從驗證，所以「佔比的分母是什麼」「勝率是誰的
 * 勝率」只能由測試守著 - 兩個方向對調以後畫面完全正常，只是每個數字都在回答
 * 另一個問題。
 */
import { describe, expect, it } from 'vitest'

import {
  metaClassRows,
  metaClassesWithData,
  metaFirstTurnAdvantage,
  metaMatchup
} from '../../src/renderer/src/components/Meta/metaModel'

import type { MetaCell, MetaDocument } from '../../src/shared/meta'

const cell = (
  myClass: string,
  oppoClass: string,
  playOrder: string,
  wins: number,
  total: number,
  installs = 5
): MetaCell => ({
  myClass,
  oppoClass,
  playOrder,
  wins,
  total,
  installs,
  rawWins: wins,
  rawTotal: total
})

const doc = (cells: MetaCell[], byClass: MetaDocument['byClass'] = []): MetaDocument => ({
  generatedAt: '2026-09-14T10:00:00.000Z',
  window: { since: '2026-09-01', days: 14 },
  mode: 'ranked',
  tiers: ['clean'],
  installs: 12,
  matches: cells.reduce((n, c) => n + c.total, 0),
  cells,
  byClass,
  sampling: {
    maxPerInstallPerCell: 20,
    minInstallsPerCell: 4,
    suppressedCells: 0,
    suppressedMatches: 0
  },
  caveats: []
})

describe('metaClassRows', () => {
  it('counts share on the opponent side, not the recorder side', () => {
    // 記錄者全部是巫師，遇到的是龍族和精靈。佔比若拿 `myClass` 去數，巫師會是
    // 100% - 那是「使用者愛用什麼」，不是環境。
    const rows = metaClassRows(
      doc(
        [
          cell('witch', 'dragon', 'first', 6, 10),
          cell('witch', 'elf', 'first', 2, 10),
          cell('witch', 'elf', 'second', 5, 20)
        ],
        [{ myClass: 'witch', wins: 13, total: 40, installs: 7 }]
      )
    )

    const by = Object.fromEntries(rows.map((row) => [row.id, row]))
    expect(by.elf.encounters).toBe(30)
    expect(by.elf.share).toBeCloseTo(75, 5)
    expect(by.dragon.share).toBeCloseTo(25, 5)
    expect(by.witch.share).toBe(0)
  })

  it('takes the win rate from byClass rather than re-summing the cells', () => {
    // 伺服器已經在同一組門檻下算過一次。兩邊各算各的，遲早會對不起來。
    const rows = metaClassRows(
      doc(
        [cell('witch', 'elf', 'first', 6, 10)],
        [{ myClass: 'witch', wins: 30, total: 50, installs: 9 }]
      )
    )
    const witch = rows.find((row) => row.id === 'witch')
    expect(witch?.total).toBe(50)
    expect(witch?.rate).toBeCloseTo(60, 5)
    expect(witch?.installs).toBe(9)
  })

  it('says "no data" rather than 0% for a class nobody played', () => {
    const rows = metaClassRows(doc([cell('witch', 'elf', 'first', 6, 10)]))
    const dragon = rows.find((row) => row.id === 'dragon')
    expect(dragon?.rate).toBeNull()
    // 沒有資料時區間是整段，不是一個點。
    expect(dragon?.interval).toEqual({ low: 0, high: 100 })
  })

  it('lists every class even when the document mentions none of them', () => {
    expect(metaClassRows(null)).toHaveLength(7)
  })

  it('splits first/second by summing cells over the opponent, on the recorder side', () => {
    // 巫師先攻對兩個對手、後攻對一個。兩側各自加總；另一個職業的格子不漏進來。
    const rows = metaClassRows(
      doc(
        [
          cell('witch', 'dragon', 'first', 6, 10),
          cell('witch', 'elf', 'first', 2, 10),
          cell('witch', 'elf', 'second', 5, 20),
          cell('dragon', 'witch', 'first', 9, 10)
        ],
        [{ myClass: 'witch', wins: 13, total: 40, installs: 7 }]
      )
    )
    const witch = rows.find((row) => row.id === 'witch')
    expect(witch?.first).toEqual({ wins: 8, total: 20, rate: 40 })
    expect(witch?.second).toEqual({ wins: 5, total: 20, rate: 25 })
    expect(witch?.swing).toBeCloseTo(15, 5)
    expect(witch?.withheld).toBe(0)
  })

  it('keeps byClass for the total and the cell sum for the split when they disagree', () => {
    // 伺服器替巫師記到 50 場，但格子裡只公開了 30 場：有對位被 k-匿名門檻壓掉。
    // 兩個分母各報各的，差額進 `withheld`，誰都不去覆寫誰。
    const rows = metaClassRows(
      doc(
        [cell('witch', 'elf', 'first', 6, 10), cell('witch', 'elf', 'second', 8, 20)],
        [{ myClass: 'witch', wins: 30, total: 50, installs: 9 }]
      )
    )
    const witch = rows.find((row) => row.id === 'witch')
    expect(witch?.total).toBe(50)
    expect(witch?.rate).toBeCloseTo(60, 5)
    expect((witch?.first.total ?? 0) + (witch?.second.total ?? 0)).toBe(30)
    expect(witch?.first.rate).toBeCloseTo(60, 5)
    expect(witch?.second.rate).toBeCloseTo(40, 5)
    expect(witch?.withheld).toBe(20)
  })

  it('reports null - not 0% - for a side or a class with no cells', () => {
    const rows = metaClassRows(
      doc(
        [cell('witch', 'elf', 'first', 6, 10)],
        [{ myClass: 'witch', wins: 6, total: 10, installs: 5 }]
      )
    )
    const witch = rows.find((row) => row.id === 'witch')
    // 有先攻沒後攻：後攻是「沒有」，差距也就算不出來。
    expect(witch?.second).toEqual({ wins: 0, total: 0, rate: null })
    expect(witch?.swing).toBeNull()

    const dragon = rows.find((row) => row.id === 'dragon')
    expect(dragon?.first).toEqual({ wins: 0, total: 0, rate: null })
    expect(dragon?.second).toEqual({ wins: 0, total: 0, rate: null })
    expect(dragon?.swing).toBeNull()
    expect(dragon?.withheld).toBe(0)
  })
})

describe('metaMatchup', () => {
  const source = doc([
    cell('witch', 'elf', 'first', 7, 10),
    cell('witch', 'elf', 'second', 3, 10),
    cell('witch', 'dragon', 'first', 1, 4),
    // 另一個職業的格子不該漏進來。
    cell('dragon', 'elf', 'first', 9, 10)
  ])

  it('keeps only the chosen class and splits by play order', () => {
    const result = metaMatchup(source, 'witch')
    expect(result.byOpponent.elf.first).toEqual({ wins: 7, total: 10, winRate: 70 })
    expect(result.byOpponent.elf.second).toEqual({ wins: 3, total: 10, winRate: 30 })
    expect(result.byOpponent.elf.all).toEqual({ wins: 10, total: 20, winRate: 50 })
    expect(result.byOpponent.dragon.all.total).toBe(4)
    expect(result.overall.all).toEqual({ wins: 11, total: 24, winRate: 45.83 })
  })

  it('seeds every class, so an unplayed matchup is a row rather than a gap', () => {
    const result = metaMatchup(source, 'witch')
    expect(Object.keys(result.byOpponent)).toHaveLength(7)
    expect(result.byOpponent.nemesis.all).toEqual({ wins: 0, total: 0, winRate: 0 })
  })

  it('reports the document window as the period, with no match cap', () => {
    const result = metaMatchup(source, 'witch')
    expect(result.start).toBe(Date.parse('2026-09-01T00:00:00Z'))
    expect(result.end).toBe(Date.parse('2026-09-14T10:00:00.000Z'))
    expect(result.limit).toBeNull()
  })

  it('survives an empty document', () => {
    const result = metaMatchup(null, 'elf')
    expect(result.overall.all.total).toBe(0)
    expect(result.start).toBeNull()
  })
})

describe('metaFirstTurnAdvantage', () => {
  it('compares the two sides by their own totals', () => {
    const advantage = metaFirstTurnAdvantage(
      doc([cell('witch', 'elf', 'first', 11, 20), cell('witch', 'elf', 'second', 9, 20)])
    )
    expect(advantage).toBeCloseTo(10, 5)
  })

  it('is unknown - not zero - when one side has no games', () => {
    expect(metaFirstTurnAdvantage(doc([cell('witch', 'elf', 'first', 11, 20)]))).toBeNull()
  })
})

describe('metaClassesWithData', () => {
  it('lists the classes that actually have published cells', () => {
    const present = metaClassesWithData(
      doc([cell('witch', 'elf', 'first', 1, 2), cell('dragon', 'elf', 'first', 0, 0)])
    )
    expect([...present]).toEqual(['witch'])
  })
})
