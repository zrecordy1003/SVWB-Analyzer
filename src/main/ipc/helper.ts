/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaClient, ClassName, GameMode, PlayOrder } from '@prisma/client'

type Stat = { wins: number; total: number; winRate: number }
type SideStats = { first: Stat; second: Stat; all: Stat }
export type RankedWinrateByOpponent = {
  myClass: ClassName
  start: number | null // 傳回毫秒（若有給）
  end: number | null // 傳回「含當天」的結束毫秒（若有給）
  byOpponent: Record<string, SideStats>
  overall: SideStats
}
export type RangeKey = 'today' | '7d' | '30d' | 'all'

// 建議在模組層共用 PrismaClient（或你有既有單例就用你的）
const prisma = new PrismaClient()

/** 取得 ranked 對戰：指定 myClass、可選日期區間；依對手職業 × 先/後手 統計勝率 */
export async function getRankedWinrateByOpponent(params: {
  myClass: ClassName
  gameMode?: GameMode
  rangeKey?: RangeKey
  start?: Date | number | string // inclusive；不給=不限
  end?: Date | number | string // inclusive；不給=不限
}): Promise<RankedWinrateByOpponent> {
  const { myClass, rangeKey } = params

  // 1) 先把顧客傳入的 start/end 轉成 Date（若有）
  let startDate = toDateOptional(params.start)
  let endDateExclusive = endExclusiveDateOptional(params.end)

  // 2) 若 start/end 都沒給，且有 rangeKey，則由 rangeKey 推導
  if (!startDate && !endDateExclusive && rangeKey) {
    const { start, endExclusive } = resolveRangeDates(rangeKey, new Date())
    startDate = start
    endDateExclusive = endExclusive
  }

  // 3) 組 where
  const whereBase: any = {
    mode: params.gameMode ? params.gameMode : GameMode.ranked,
    my_class: myClass
  }
  if (startDate || endDateExclusive) {
    whereBase.playedAt = {}
    if (startDate) whereBase.playedAt.gte = startDate
    if (endDateExclusive) whereBase.playedAt.lt = endDateExclusive
  }

  // 4) groupBy：總場數
  const totals = await prisma.match.groupBy({
    by: ['oppo_class', 'play_order'],
    where: whereBase,
    _count: { _all: true } as const
  })

  // 5) groupBy：勝場數
  const wins = await prisma.match.groupBy({
    by: ['oppo_class', 'play_order'],
    where: { ...whereBase, result: true },
    _count: { _all: true } as const
  })

  // 6) 彙整
  const winMap = new Map<string, number>()
  for (const r of wins) {
    const side = r.play_order === PlayOrder.first ? 'first' : 'second'
    winMap.set(`${r.oppo_class}|${side}`, Number((r._count as any)?._all ?? 0))
  }

  const empty: Stat = { wins: 0, total: 0, winRate: 0 }
  const byOpponent: Record<string, SideStats> = {}
  const overall: SideStats = { first: { ...empty }, second: { ...empty }, all: { ...empty } }

  for (const r of totals) {
    const opp = String(r.oppo_class)
    const side = r.play_order === PlayOrder.first ? ('first' as const) : ('second' as const)
    const total = Number((r._count as any)?._all ?? 0)
    const w = winMap.get(`${opp}|${side}`) ?? 0

    byOpponent[opp] ??= { first: { ...empty }, second: { ...empty }, all: { ...empty } }

    // side 統計
    const bucket = byOpponent[opp][side]
    bucket.total += total
    bucket.wins += w
    bucket.winRate = pct(bucket.wins, bucket.total)

    // per-opponent all
    const all = byOpponent[opp].all
    all.total += total
    all.wins += w
    all.winRate = pct(all.wins, all.total)

    // overall
    const oSide = overall[side]
    oSide.total += total
    oSide.wins += w
    oSide.winRate = pct(oSide.wins, oSide.total)

    overall.all.total += total
    overall.all.wins += w
    overall.all.winRate = pct(overall.all.wins, overall.all.total)
  }

  return {
    myClass,
    start: startDate ? startDate.getTime() : null,
    end: endDateExclusive ? endDateExclusive.getTime() - 1 : null, // 回傳「含當天」
    byOpponent,
    overall
  }
}

/* ---------- helpers ---------- */

// 將 rangeKey 轉為 Date 區間（endExclusive 為下一天 00:00）
function resolveRangeDates(
  rangeKey: RangeKey,
  now: Date
): { start: Date | undefined; endExclusive: Date | undefined } {
  const todayStart = startOfDayDate(now)
  const tomorrowStart = new Date(todayStart.getTime() + 86400000)

  switch (rangeKey) {
    case 'today': {
      return { start: todayStart, endExclusive: tomorrowStart }
    }
    case '7d': {
      const s = new Date(todayStart)
      s.setDate(s.getDate() - 6) // 含今天共 7 天
      return { start: s, endExclusive: tomorrowStart }
    }
    case '30d': {
      const s = new Date(todayStart)
      s.setDate(s.getDate() - 29) // 含今天共 30 天
      return { start: s, endExclusive: tomorrowStart }
    }
    case 'all': {
      return { start: undefined, endExclusive: undefined }
    }
  }
}

function toDateOptional(v?: Date | number | string): Date | undefined {
  if (v === undefined || v === null) return undefined
  if (v instanceof Date) return v
  if (typeof v === 'number') return new Date(v)
  const d = new Date(v)
  return isNaN(d.getTime()) ? undefined : d
}
function startOfDayDate(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function endExclusiveDateOptional(v?: Date | number | string): Date | undefined {
  const d = toDateOptional(v)
  if (!d) return undefined
  const s = startOfDayDate(d)
  return new Date(s.getTime() + 86400000) // 下一天 00:00（exclusive）
}
function pct(wins: number, total: number): number {
  return total === 0 ? 0 : Math.round((wins / total) * 1000) / 10 // 1 decimal
}
