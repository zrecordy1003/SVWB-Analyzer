import type { Expression, ExpressionBuilder, SqlBool } from 'kysely'

import { ClassName, GameMode, PlayOrder } from '../../shared/domain.js'
import { getDb, type Database } from '../data/db/client.js'
import type { RangeKey, RankedWinrateByOpponent } from '../../shared/types.js'

export type { RangeKey, RankedWinrateByOpponent } from '../../shared/types.js'

type Stat = { wins: number; total: number; winRate: number }
type SideStats = { first: Stat; second: Stat; all: Stat }

// The 3s TTL cache and its version bookkeeping used to live here, hiding the
// Prisma engine's per-call overhead. An in-process better-sqlite3 GROUP BY over
// this data size is microseconds, so the cache is deleted rather than ported -
// removing it is also the acceptance test that the overhead really left.

/** 取得 ranked 對戰：指定 myClass、可選日期區間；依對手職業 × 先/後手 統計勝率 */
export async function getRankedWinrateByOpponent(params: {
  myClass: ClassName
  /** `'all'` drops the mode filter entirely; omitted still means ranked. */
  gameMode?: GameMode | 'all'
  rangeKey?: RangeKey
  start?: Date | number | string // inclusive；不給=不限
  end?: Date | number | string // inclusive；不給=不限
  myDeckIds?: number[]
  tagIds?: number[]
  crMin?: number
  crMax?: number
  /** Keep only the `limit` most recent matches that pass every other filter. */
  limit?: number
}): Promise<RankedWinrateByOpponent> {
  const db = getDb()
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

  // 3) 每個條件寫成一顆述詞，因為 limit 分支要把同一組條件再套一次到子查詢上。
  const conditions = (eb: ExpressionBuilder<Database, 'Match'>): Expression<SqlBool>[] => {
    const list: Expression<SqlBool>[] = [eb('my_class', '=', myClass)]

    if (params.gameMode !== 'all') {
      list.push(eb('mode', '=', params.gameMode ?? GameMode.ranked))
    }
    if (startDate) list.push(eb('playedAt', '>=', startDate.getTime()))
    if (endDateExclusive) list.push(eb('playedAt', '<', endDateExclusive.getTime()))
    if (params.myDeckIds?.length) list.push(eb('my_deckId', 'in', params.myDeckIds))
    if (params.tagIds?.length) {
      // 任一符合 (OR within selected tags)
      const ids = params.tagIds
      list.push(
        eb.exists(
          eb
            .selectFrom('MatchTag')
            .select('MatchTag.matchId')
            .whereRef('MatchTag.matchId', '=', 'Match.id')
            .where('MatchTag.tagId', 'in', ids)
        )
      )
    }
    if (typeof params.crMin === 'number') list.push(eb('current_cr', '>=', params.crMin))
    if (typeof params.crMax === 'number') list.push(eb('current_cr', '<=', params.crMax))

    return list
  }

  // 4) 一次 groupBy 取得總場數與勝場數，避免 totals/wins 分成兩次查詢。
  let query = db
    .selectFrom('Match')
    .select(({ fn }) => ['oppo_class', 'play_order', 'result', fn.countAll<number>().as('count')])
    .where((eb) => eb.and(conditions(eb)))
    .groupBy(['oppo_class', 'play_order', 'result'])

  // 5)「最近 N 場」不是另一組條件，而是把同一組條件的結果由新到舊截斷後再統計。
  // id 是 playedAt 相同時的決勝鍵，否則同一秒內的幾場會在兩次查詢間換位。
  const limit = normaliseLimit(params.limit)
  if (limit !== undefined) {
    query = query.where(
      'id',
      'in',
      db
        .selectFrom('Match')
        .select('id')
        .where((eb) => eb.and(conditions(eb)))
        .orderBy('playedAt', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
    )
  }

  const grouped = await query.execute()

  const empty: Stat = { wins: 0, total: 0, winRate: 0 }
  /**
   * Seeded with every class, not just the ones that turned up in the results.
   * Letting the shape follow the data made the chart grow and shrink between
   * filters and silently dropped the "never faced this class" case, which is
   * itself information. Consumers already treat a zeroed bucket and a missing
   * one the same way, so this only ever adds rows.
   */
  const byOpponent: Record<string, SideStats> = Object.fromEntries(
    Object.values(ClassName).map((name) => [
      String(name),
      { first: { ...empty }, second: { ...empty }, all: { ...empty } }
    ])
  )
  const overall: SideStats = { first: { ...empty }, second: { ...empty }, all: { ...empty } }

  for (const r of grouped) {
    const opp = String(r.oppo_class)
    const side = r.play_order === PlayOrder.first ? ('first' as const) : ('second' as const)
    const total = Number(r.count)
    // result is stored 0/1; 1 is a win.
    const w = r.result === 1 ? total : 0

    // A row whose class is not in the enum (older data, hand-edited db) still
    // gets a bucket rather than being dropped.
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
    const decks = await db
      .selectFrom('Deck')
      .select(['id', 'name'])
      .where('id', 'in', params.myDeckIds)
      .execute()
    myDecks = decks
      .filter((d) => order.has(d.id)) // 忽略不存在的 id
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }

  // ---- 將 tagIds 轉成名稱（可選）----
  let tags: { id: number; name: string }[] | undefined
  if (params.tagIds?.length) {
    const order = new Map(params.tagIds.map((id, i) => [id, i]))
    const tagRows = await db
      .selectFrom('Tag')
      .select(['id', 'name'])
      .where('id', 'in', params.tagIds)
      .execute()
    tags = tagRows
      .filter((t) => order.has(t.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }

  return {
    myClass,
    start: startDate ? startDate.getTime() : null,
    end: endDateExclusive ? endDateExclusive.getTime() - 1 : null,
    byOpponent,
    overall,
    myDecks,
    tags,
    crMin: typeof params.crMin === 'number' ? params.crMin : null,
    crMax: typeof params.crMax === 'number' ? params.crMax : null,
    limit: limit ?? null
  }
}

/* ---------- helpers ---------- */

/** `undefined` means "no cap". Anything below one match would return nothing at
 *  all, which reads as an empty database rather than as a bad filter. */
function normaliseLimit(value?: number | null): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  return n >= 1 ? n : undefined
}

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
