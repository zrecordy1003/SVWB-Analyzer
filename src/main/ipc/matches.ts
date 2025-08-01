import { ipcMain } from 'electron'
import { ClassName, GameMode, Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// count handler：接受 filterMy, filterOppo
ipcMain.handle('matches:count', async (_e, filterMy = '', filterOppo = '', filterModes = '') => {
  const where: Prisma.MatchWhereInput = {}

  if (filterMy) {
    where.my_class = { equals: filterMy as ClassName }
  }

  if (filterOppo) {
    where.oppo_class = { equals: filterOppo as ClassName }
  }
  if (filterModes) {
    where.mode = { equals: filterModes as GameMode }
  }

  return prisma.match.count({ where })
})

// getAll handler：接受篩選，並套用 cursor-based pagination
ipcMain.handle(
  'matches:getAll',
  async (
    _e,
    take: number,
    cursorId?: number | null,
    filterMy = '',
    filterOppo = '',
    filterModes = ''
  ) => {
    const where: Prisma.MatchWhereInput = {}

    if (filterMy) {
      where.my_class = { equals: filterMy as ClassName }
    }

    if (filterOppo) {
      where.oppo_class = { equals: filterOppo as ClassName }
    }

    if (filterModes) {
      where.mode = { equals: filterModes as GameMode }
    }

    return prisma.match.findMany({
      where,
      orderBy: { playedAt: 'desc' },
      take,
      ...(cursorId
        ? {
            cursor: { id: cursorId },
            skip: 1
          }
        : {})
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
