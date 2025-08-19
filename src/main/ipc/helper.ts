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

/** 取得 ranked 對戰：指定 myClass、可選日期區間；依對手職業 × 先/後手 統計勝率 */
export async function getRankedWinrateByOpponent(params: {
  myClass: ClassName
  gameMode?: GameMode
  start?: Date | number | string // inclusive；不給=不限
  end?: Date | number | string // inclusive；不給=不限
}): Promise<RankedWinrateByOpponent> {
  const prisma = new PrismaClient()

  const { myClass } = params
  const startMs = toMillisOptional(params.start)
  const endMsExclusive = endExclusiveOptional(params.end) // < 下一天 00:00

  // 動態 where（沒給日期就不加 playedAt）
  const whereBase: any = {
    mode: params.gameMode ? params.gameMode : GameMode.ranked,
    my_class: myClass
  }
  if (startMs !== undefined || endMsExclusive !== undefined) {
    whereBase.playedAt = {}
    if (startMs !== undefined) whereBase.playedAt.gte = startMs
    if (endMsExclusive !== undefined) whereBase.playedAt.lt = endMsExclusive
  }

  // 1) 各對手 × 先/後手 的總場數
  const totals = await prisma.match.groupBy({
    by: ['oppo_class', 'play_order'],
    where: whereBase,
    _count: { _all: true } as const
  })

  // 2) 各對手 × 先/後手 的勝場數（result: true）
  const wins = await prisma.match.groupBy({
    by: ['oppo_class', 'play_order'],
    where: { ...whereBase, result: true },
    _count: { _all: true } as const
  })

  // 建 wins map：key = "oppo|side"
  const winMap = new Map<string, number>()
  for (const r of wins) {
    const side = r.play_order === PlayOrder.first ? 'first' : 'second'
    winMap.set(`${r.oppo_class}|${side}`, Number((r._count as any)?._all ?? 0))
  }

  // 組裝結果
  const empty: Stat = { wins: 0, total: 0, winRate: 0 }
  const byOpponent: Record<string, SideStats> = {}
  const overall: SideStats = { first: { ...empty }, second: { ...empty }, all: { ...empty } }

  for (const r of totals) {
    const opp = String(r.oppo_class)
    const side = r.play_order === PlayOrder.first ? ('first' as const) : ('second' as const)
    const total = Number((r._count as any)?._all ?? 0)
    const w = winMap.get(`${opp}|${side}`) ?? 0

    byOpponent[opp] ??= { first: { ...empty }, second: { ...empty }, all: { ...empty } }

    // side
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
    start: startMs ?? null,
    end: endMsExclusive ? endMsExclusive - 1 : null, // 回傳「含當天」
    byOpponent,
    overall
  }
}

/* ---------- helpers ---------- */
function toMillisOptional(v?: Date | number | string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  const ms = new Date(v).getTime()
  return Number.isNaN(ms) ? undefined : ms
}
function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function endExclusiveOptional(v?: Date | number | string): number | undefined {
  const ms = toMillisOptional(v)
  if (ms === undefined) return undefined
  return startOfDay(ms) + 86400000
}
function pct(wins: number, total: number): number {
  return total === 0 ? 0 : Math.round((wins / total) * 1000) / 10 // 1 decimal
}
