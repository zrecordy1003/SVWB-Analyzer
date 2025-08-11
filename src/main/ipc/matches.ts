import { ipcMain } from 'electron'
import { ClassName, GameMode, Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// 共用 where 條件
function buildMatchWhere(
  filterMy: ClassName[] = [],
  filterOppo: ClassName[] = [],
  filterModes: string = '',
  startDate: Date | null = null,
  endDate: Date | null = null
): Prisma.MatchWhereInput {
  const where: Prisma.MatchWhereInput = {}

  if (Array.isArray(filterMy) && filterMy.length > 0) {
    where.my_class = { in: filterMy }
  }
  if (Array.isArray(filterOppo) && filterOppo.length > 0) {
    where.oppo_class = { in: filterOppo }
  }
  if (filterModes) {
    where.mode = { equals: filterModes as GameMode }
  }

  // 正規化日期（含括 end-of-day）
  let start: Date | undefined
  let end: Date | undefined
  if (startDate instanceof Date && !isNaN(startDate.getTime())) {
    start = new Date(startDate)
  }
  if (endDate instanceof Date && !isNaN(endDate.getTime())) {
    const e = new Date(endDate)
    // 若來的是純日期 00:00，補到當天最後一毫秒
    if (
      e.getHours() === 0 &&
      e.getMinutes() === 0 &&
      e.getSeconds() === 0 &&
      e.getMilliseconds() === 0
    ) {
      e.setHours(23, 59, 59, 999)
    }
    end = e
  }

  if (start && end) {
    where.playedAt = { gte: start, lte: end }
  } else if (start) {
    where.playedAt = { gte: start }
  } else if (end) {
    where.playedAt = { lte: end }
  }

  return where
}

ipcMain.handle(
  'matches:count',
  async (
    _e,
    filterMy: ClassName[] = [],
    filterOppo: ClassName[] = [],
    filterModes: string = '',
    startDate: Date | null = null,
    endDate: Date | null = null
  ) => {
    const where = buildMatchWhere(filterMy, filterOppo, filterModes, startDate, endDate)
    return prisma.match.count({ where })
  }
)

ipcMain.handle(
  'matches:getPage',
  async (
    _e,
    pageIndex: number,
    pageSize: number,
    filterMy: ClassName[] = [],
    filterOppo: ClassName[] = [],
    filterModes: string = '',
    startDate: Date | null = null,
    endDate: Date | null = null
  ) => {
    const where = buildMatchWhere(filterMy, filterOppo, filterModes, startDate, endDate)
    return prisma.match.findMany({
      where,
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }], // stable ordering for pagination
      skip: pageIndex * pageSize,
      take: pageSize
    })
  }
)
/**
 * matches:fetchAll
 *  - 不帶參數時回傳全部
 *  - 可帶 { start?: number; end?: number } 來做日期範圍篩選 (ms timestamp)
 */
ipcMain.handle('matches:fetchAll', async (_event, args?: { start?: number; end?: number }) => {
  try {
    const where: any = {}
    if (args?.start || args?.end) {
      where.playedAt = {}
      if (args.start) where.playedAt.gte = new Date(args.start)
      if (args.end) where.playedAt.lte = new Date(args.end)
    }
    const recs = await prisma.match.findMany({
      where,
      orderBy: { playedAt: 'desc' }
    })

    // 轉成前端需要的簡化物件
    // const payload: Match[] = recs.map((m) => ({
    //   result: m.result === null ? null : m.result,
    //   play_order: m.play_order,
    //   my_class: m.my_class,
    //   oppo_class: m.oppo_class,
    //   my_deckId: m.my_deckId,
    //   durationTime: m.durationTime,
    //   mode: m.mode,
    //   bp: m.bp,
    //   year: m.year,
    //   month: m.month,
    //   day: m.day,
    //   playedAt: m.playedAt.getTime(),
    //   endedAt: m.endedAt ? m.endedAt.getTime() : null
    // }))
    const payload = recs
    return payload
  } catch (err) {
    console.error('IPC matches:fetchAll error', err)
    // 在前端會拋出一個 Error 可以 try/catch
    throw new Error('Failed to fetch matches')
  }
})

ipcMain.handle('get-chart-data', async (_event, params) => {
  const { metrics, classes, decks, startDate, endDate } = params as {
    metrics: string[]
    classes: string[]
    decks: string[]
    startDate: string | null
    endDate: string | null
  }

  // 構建查詢條件
  const baseWhere: any = {}
  if (startDate || endDate) {
    baseWhere.playedAt = {}
    if (startDate) baseWhere.playedAt.gte = new Date(startDate)
    if (endDate) baseWhere.playedAt.lte = new Date(endDate)
  }
  if (classes.length) {
    baseWhere.OR = [{ my_class: { in: classes } }, { oppo_class: { in: classes } }]
  }
  if (decks.length) {
    baseWhere.my_deckId = { in: decks.map((d) => Number(d)) }
  }

  const labels: string[] = []
  const datasets: { label: string; data: number[] }[] = []

  for (const metric of metrics) {
    switch (metric) {
      case 'winRateOverall': {
        // 各職業勝率 = 勝場數 / 總場數
        const totalStats = await prisma.match.groupBy({
          by: ['my_class'],
          where: baseWhere,
          _count: { _all: true }
        })
        const winStats = await prisma.match.groupBy({
          by: ['my_class'],
          where: { ...baseWhere, result: true },
          _count: { _all: true }
        })
        const classesList = totalStats.map((s) => s.my_class)
        labels.push(...classesList)
        const data = classesList.map((cls) => {
          const total = totalStats.find((s) => s.my_class === cls)?._count._all || 0
          const win = winStats.find((s) => s.my_class === cls)?._count._all || 0
          return total > 0 ? +((win / total) * 100).toFixed(2) : 0
        })
        datasets.push({ label: '各職業勝率 (%)', data })
        break
      }
      case 'winRateFirst': {
        // 先攻勝率：play_order = 'first'
        const totalFirst = await prisma.match.count({
          where: { ...baseWhere, play_order: 'first' }
        })
        const winFirst = await prisma.match.count({
          where: { ...baseWhere, play_order: 'first', result: true }
        })
        labels.push('先攻勝率')
        const rate = totalFirst > 0 ? +((winFirst / totalFirst) * 100).toFixed(2) : 0
        datasets.push({ label: '先攻勝率 (%)', data: [rate] })
        break
      }
      // 可依此模式補充其他指標，如 winRateSecond、matchupWinRate 等
      default:
        break
    }
  }

  return { labels, datasets }
})
