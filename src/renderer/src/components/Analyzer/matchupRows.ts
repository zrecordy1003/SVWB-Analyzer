/**
 * 對戰組合的一列資料，以及所有「多少算多」的門檻。
 *
 * 熱圖和長條圖看的是同一份東西，只是畫法不同。行數、排序、樣本夠不夠、差距算
 * 不算大，這些判斷只能有一份 - 兩個畫面對同一場資料給出不同的說法，比畫得醜
 * 嚴重得多。
 */
import { useEffect, useRef, useState } from 'react'

import { classes, classesMap } from '@renderer/map/classMap'
import { readSetting } from './filterState'

import type { RankedWinrateByOpponent, SideStats, Stat } from '@shared/types'

/**
 * 低於這個場數就標記樣本偏少：數字照給，可信度不給。
 *
 * 用 10 而不是公開統計站常見的 30 - 這裡的範圍是單一玩家自己的最近 N 場，
 * 100 場打散到七個職業時，30 場的門檻會讓整張表都掛上警告，標記也就不再有
 * 意義。低於十場時一場就能讓勝率跳十個百分點以上，那是誠實的那條線。
 */
export const LOW_SAMPLE_GAMES = 10

/** 先後攻差到這個幅度才值得標出來，否則每一列都掛徽章等於沒有徽章。 */
export const SWING_THRESHOLD = 8

/** 長條圖上那行「先攻 +x」的門檻。比徽章鬆一點，因為那裡本來就在講差距。 */
export const DELTA_LABEL_THRESHOLD = 5

/** 對這個職業算好打還是難打。50% 上下五個百分點內都當成五五開。 */
export const FAVORED_RATE = 55
export const UNFAVORED_RATE = 45

/**
 * 勝率的顏色：50% 兩邊各分三階。
 *
 * 這兩個色相和熱圖的格子底色是同一組，所以「綠＝我贏面大」在兩張圖裡是同一
 * 件事。飽和度壓過的紅綠在暗底上會把七列變成紅綠燈，所以強度是靠透明度爬，
 * 而不是換更鮮的顏色。
 */
export const WIN_RGB = '86, 168, 120'
export const LOSS_RGB = '201, 96, 96'

/** 這個範圍內算五五開，不上色 - 49% 不是劣勢對局。 */
export const RATE_DEAD_BAND = 2
/** 上色的三階：微幅、明顯、一面倒。 */
const RATE_TIERS = [5, 10] as const

export function rateColor(rate: number | null | undefined): string | undefined {
  if (rate === null || rate === undefined) return undefined
  const delta = rate - 50
  const magnitude = Math.abs(delta)
  if (magnitude < RATE_DEAD_BAND) return undefined
  const rgb = delta > 0 ? WIN_RGB : LOSS_RGB
  const alpha = magnitude >= RATE_TIERS[1] ? 1 : magnitude >= RATE_TIERS[0] ? 0.88 : 0.7
  return `rgba(${rgb}, ${alpha})`
}

export type MatchupVerdict = 'favored' | 'even' | 'unfavored'

export function verdictOf(rate: number | null): MatchupVerdict | null {
  if (rate === null) return null
  if (rate >= FAVORED_RATE) return 'favored'
  if (rate <= UNFAVORED_RATE) return 'unfavored'
  return 'even'
}

export const VERDICT_LABELS: Record<MatchupVerdict, string> = {
  favored: '優勢',
  even: '五五開',
  unfavored: '劣勢'
}

/** 一個 `Stat` 加上「沒打過就是沒有」，而不是 0%。 */
export type Rate = Stat & { rate: number | null; losses: number }

export type MatchupRow = {
  key: string
  label: string
  color: string
  games: number
  wins: number
  losses: number
  overall: number | null
  first: Rate
  second: Rate
  all: Rate
  /** 先攻減後攻，單位是百分點；任一邊沒打過就是 null。 */
  swing: number | null
  lowSample: boolean
}

const CLASS_ORDER_INDEX = new Map<string, number>(classes.map((c, i) => [String(c.id), i]))

function toRate(stat: Stat): Rate {
  const total = Number(stat?.total ?? 0)
  const wins = Number(stat?.wins ?? 0)
  return {
    total,
    wins,
    losses: Math.max(0, total - wins),
    winRate: Number(stat?.winRate ?? 0),
    rate: total > 0 ? Number(stat?.winRate ?? 0) : null
  }
}

export function buildMatchupRows(data: RankedWinrateByOpponent | null | undefined): MatchupRow[] {
  if (!data?.byOpponent) return []

  return Object.entries(data.byOpponent).map(([key, value]) => {
    const side = value as SideStats
    const meta = classesMap[key as keyof typeof classesMap]
    const first = toRate(side.first)
    const second = toRate(side.second)
    const all = toRate(side.all)
    return {
      key,
      label: meta?.label ?? key,
      color: meta?.color ?? '#9e9e9e',
      games: all.total,
      wins: all.wins,
      losses: all.losses,
      overall: all.rate,
      first,
      second,
      all,
      swing: first.rate !== null && second.rate !== null ? first.rate - second.rate : null,
      lowSample: all.total > 0 && all.total < LOW_SAMPLE_GAMES
    }
  })
}

export type MatchupSortKey = 'class' | 'first' | 'second' | 'overall' | 'games' | 'swing'

export const MATCHUP_SORT_KEYS: readonly MatchupSortKey[] = [
  'class',
  'first',
  'second',
  'overall',
  'games',
  'swing'
]

export const MATCHUP_SORT_LABELS: Record<MatchupSortKey, string> = {
  overall: '總勝率',
  first: '先攻勝率',
  second: '後攻勝率',
  games: '對局數',
  swing: '先後差',
  class: '職業順序'
}

export function sortMatchupRows(
  rows: MatchupRow[],
  sortKey: MatchupSortKey,
  descending: boolean
): MatchupRow[] {
  const direction = descending ? -1 : 1

  // 沒打過不是 0%，所以那幾列沉到最後，而不是假裝自己是最爛的對局。
  const rank = (row: MatchupRow): number | null => {
    switch (sortKey) {
      case 'games':
        return row.games
      case 'first':
        return row.first.rate
      case 'second':
        return row.second.rate
      case 'overall':
        return row.overall
      case 'swing':
        return row.swing
      default:
        return null
    }
  }

  return [...rows].sort((a, b) => {
    if (sortKey === 'class') {
      return (
        (CLASS_ORDER_INDEX.get(a.key) ?? 9999) - (CLASS_ORDER_INDEX.get(b.key) ?? 9999) ||
        a.label.localeCompare(b.label)
      )
    }
    const av = rank(a)
    const bv = rank(b)
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    return (av - bv) * direction || a.label.localeCompare(b.label)
  })
}

/**
 * 排序對使用者來說就是一種篩選：挑一次「最難打的排前面」，明天回來還要是那樣。
 * 和分析器其他選擇存在一起，也讓兩種圖表共用同一個排序 - 換個畫法不該把順序
 * 換掉。
 */
const SORT_SETTINGS_KEYS = {
  sortKey: 'analyzer.matchupSortKey',
  sortDesc: 'analyzer.matchupSortDesc'
} as const

export function useMatchupSort(): {
  sortKey: MatchupSortKey
  descending: boolean
  setSortKey: (key: MatchupSortKey) => void
  setDescending: (desc: boolean) => void
} {
  // 預設是總勝率而不是職業順序：這張圖回答的第一個問題是「我打誰最好打」，
  // 那是一份排名。存起來的選擇一讀回來就會取代它。
  const [sortKey, setSortKey] = useState<MatchupSortKey>('overall')
  const [descending, setDescending] = useState(true)

  /** 寫入的閘門：讀回存檔以後才打開，否則還原會被它要取代的預設值蓋掉。 */
  const loadedRef = useRef(false)

  useEffect(() => {
    let mounted = true
    void window.settings
      .getAll()
      .then((raw) => {
        if (!mounted || !raw) return
        // 和篩選器踩過的同一個坑：路徑式與扁平鍵，見 readSetting。
        const storedKey = readSetting(raw, SORT_SETTINGS_KEYS.sortKey)
        if (
          typeof storedKey === 'string' &&
          (MATCHUP_SORT_KEYS as readonly string[]).includes(storedKey)
        ) {
          setSortKey(storedKey as MatchupSortKey)
        }
        const storedDesc = readSetting(raw, SORT_SETTINGS_KEYS.sortDesc)
        if (typeof storedDesc === 'boolean') setDescending(storedDesc)
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) loadedRef.current = true
      })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    void window.settings
      .setMany({
        [SORT_SETTINGS_KEYS.sortKey]: sortKey,
        [SORT_SETTINGS_KEYS.sortDesc]: descending
      })
      .catch(() => {})
  }, [descending, sortKey])

  return { sortKey, descending, setSortKey, setDescending }
}
