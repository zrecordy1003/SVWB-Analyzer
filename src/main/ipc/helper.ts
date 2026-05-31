import { ClassName, GameMode, PlayOrder } from '@prisma/client'
import { getPrisma } from '../db/prismaClient.js'
import { getStatsCacheVersion } from '../statsCache.js'
import type { RangeKey, RankedWinrateByOpponent } from '../../shared/types.js'

export type { RangeKey, RankedWinrateByOpponent } from '../../shared/types.js'

type Stat = { wins: number; total: number; winRate: number }
type SideStats = { first: Stat; second: Stat; all: Stat }

const STATS_CACHE_TTL_MS = 3000
const rankedWinrateCache = new Map<string, { expiresAt: number; value: RankedWinrateByOpponent }>()

function statsCacheKey(params: Record<string, unknown>): string {
  return JSON.stringify(params, (_key, value) => {
    if (value instanceof Date) return value.getTime()
    if (Array.isArray(value)) return [...value].sort()
    return value
  })
}

/** 取得 ranked 對戰：指定 myClass、可選日期區間；依對手職業 × 先/後手 統計勝率 */
export async function getRankedWinrateByOpponent(params: {
  myClass: ClassName
  gameMode?: GameMode
  rangeKey?: RangeKey
  start?: Date | number | string // inclusive；不給=不限
  end?: Date | number | string // inclusive；不給=不限
  myDeckIds?: number[]
  tagIds?: number[]
  crMin?: number
  crMax?: number
}): Promise<RankedWinrateByOpponent> {
  const prisma = getPrisma()
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

  if (params.myDeckIds?.length) {
    whereBase.my_deckId = { in: params.myDeckIds }
  }
  if (params.tagIds?.length) {
    // 任一符合 (OR within selected tags)
    whereBase.tags = { some: { tagId: { in: params.tagIds } } }

    // 若想改成「必須同時包含所有所選標籤（AND）」：
    // whereBase.AND = [
    //   ...(whereBase.AND ?? []),
    //   ...params.tagIds.map((tid) => ({ tags: { some: { tagId: tid } } }))
    // ]
  }

  if (typeof params.crMin === 'number' || typeof params.crMax === 'number') {
    whereBase.current_cr = {}
    if (typeof params.crMin === 'number') whereBase.current_cr.gte = params.crMin
    if (typeof params.crMax === 'number') whereBase.current_cr.lte = params.crMax
  }

  const cacheKey = statsCacheKey({
    version: getStatsCacheVersion(),
    myClass,
    gameMode: params.gameMode ?? GameMode.ranked,
    start: startDate?.getTime() ?? null,
    end: endDateExclusive?.getTime() ?? null,
    myDeckIds: params.myDeckIds ?? [],
    tagIds: params.tagIds ?? [],
    crMin: params.crMin ?? null,
    crMax: params.crMax ?? null
  })
  const cached = rankedWinrateCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  // 4) 一次 groupBy 取得總場數與勝場數，避免 totals/wins 分成兩次查詢。
  const grouped = await prisma.match.groupBy({
    by: ['oppo_class', 'play_order', 'result'],
    where: whereBase,
    _count: { _all: true } as const
  })

  const empty: Stat = { wins: 0, total: 0, winRate: 0 }
  const byOpponent: Record<string, SideStats> = {}
  const overall: SideStats = { first: { ...empty }, second: { ...empty }, all: { ...empty } }

  for (const r of grouped) {
    const opp = String(r.oppo_class)
    const side = r.play_order === PlayOrder.first ? ('first' as const) : ('second' as const)
    const total = Number((r._count as any)?._all ?? 0)
    const w = r.result === true ? total : 0

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

  let myDecks: { id: number; name: string }[] | undefined
  if (params.myDeckIds?.length) {
    const order = new Map(params.myDeckIds.map((id, i) => [id, i]))
    const decks = await prisma.deck.findMany({
      where: { id: { in: params.myDeckIds } },
      select: { id: true, name: true }
    })
    myDecks = decks
      .filter((d) => order.has(d.id)) // 忽略不存在的 id
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }

  // ---- 將 tagIds 轉成名稱（可選）----
  let tags: { id: number; name: string }[] | undefined
  if (params.tagIds?.length) {
    const order = new Map(params.tagIds.map((id, i) => [id, i]))
    const tagRows = await prisma.tag.findMany({
      where: { id: { in: params.tagIds } },
      select: { id: true, name: true }
    })
    tags = tagRows
      .filter((t) => order.has(t.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }

  const result = {
    myClass,
    start: startDate ? startDate.getTime() : null,
    end: endDateExclusive ? endDateExclusive.getTime() - 1 : null,
    byOpponent,
    overall,
    myDecks,
    tags,
    crMin: typeof params.crMin === 'number' ? params.crMin : null,
    crMax: typeof params.crMax === 'number' ? params.crMax : null
  }
  rankedWinrateCache.set(cacheKey, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, value: result })
  return result
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
    default: {
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
