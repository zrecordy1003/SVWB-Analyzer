import { ipcMain } from 'electron'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// count handler：接受 filterMy, filterOppo
ipcMain.handle('matches:count', async (_e, filterMy = '', filterOppo = '') => {
  return prisma.match.count({
    where: {
      my_class: { contains: filterMy },
      oppo_class: { contains: filterOppo }
    }
  })
})

// getAll handler：接受篩選，並套用 cursor-based pagination
ipcMain.handle(
  'matches:getAll',
  async (_e, take: number, cursorId?: number | null, filterMy = '', filterOppo = '') => {
    const where = {
      my_class: { contains: filterMy },
      oppo_class: { contains: filterOppo }
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
interface MatchDTO {
  result: 1 | 0 | null
  play_order: 'first' | 'second'
  my_class: string
  oppo_class: string
  playedAt: number
  endedAt: number
}

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
      orderBy: { playedAt: 'asc' }
    })

    // 轉成前端需要的簡化物件
    const payload: MatchDTO[] = recs.map((m) => ({
      result: m.result === null ? null : m.result,
      play_order: m.play_order,
      my_class: m.my_class,
      oppo_class: m.oppo_class,
      playedAt: m.playedAt.getTime(),
      endedAt: m.endedAt ? m.endedAt.getTime() : m.playedAt.getTime()
    }))
    return payload
  } catch (err) {
    console.error('IPC matches:fetchAll error', err)
    // 在前端會拋出一個 Error 可以 try/catch
    throw new Error('Failed to fetch matches')
  }
})
