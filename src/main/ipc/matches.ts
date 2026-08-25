/* eslint-disable @typescript-eslint/no-explicit-any */
import { BrowserWindow, ipcMain } from 'electron'
import { ClassName, GameMode, Match, Prisma, Tag } from '@prisma/client'
import { getPrisma } from '../db/prismaClient.js'
import { getRankedWinrateByOpponent, RangeKey } from './helper.js'

export type QueryPayload = {
  myClassIds?: ClassName[]
  oppoClassIds?: ClassName[]
  mode?: GameMode | null
  rangeKey?: RangeKey
  start?: string | number | Date | null
  end?: string | number | Date | null
  myDeckIds?: number[] // 只篩我方牌組；若要同時含對方，改 OR
  tagIds?: number[]
  note?: 'any' | 'with' | 'without'
  crMin?: number | null
  crMax?: number | null

  // for getPage
  pageIndex?: number
  pageSize?: number
}

function toDateSafe(v: unknown): Date | null {
  if (v == null) return null
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const d = new Date(Number(v))
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(v as any)
  return isNaN(d.getTime()) ? null : d
}

function computeDateRangeByKey(p: Pick<QueryPayload, 'rangeKey' | 'start' | 'end'>): {
  start: Date | undefined
  end: Date | undefined
} {
  // 明確 start/end 優先（custom）
  const s = toDateSafe(p.start)
  const e = toDateSafe(p.end)
  if (s || e) return { start: s ?? undefined, end: e ?? undefined }

  const key = p.rangeKey
  if (!key || key === 'all') return { start: undefined, end: undefined }

  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)

  if (key === 'today') return { start, end }
  if (key === '7d') {
    const s7 = new Date(start)
    s7.setDate(s7.getDate() - 6)
    return { start: s7, end }
  }
  if (key === '30d') {
    const s30 = new Date(start)
    s30.setDate(s30.getDate() - 29)
    return { start: s30, end }
  }
  return { start: undefined, end: undefined }
}

function buildWhereFromPayload(p: QueryPayload): Prisma.MatchWhereInput {
  const AND: Prisma.MatchWhereInput[] = []

  if (p.myClassIds?.length) AND.push({ my_class: { in: p.myClassIds } })
  if (p.oppoClassIds?.length) AND.push({ oppo_class: { in: p.oppoClassIds } })
  if (p.mode) AND.push({ mode: p.mode })

  const { start, end } = computeDateRangeByKey(p)
  if (start && end) AND.push({ playedAt: { gte: start, lte: end } })
  else if (start) AND.push({ playedAt: { gte: start } })
  else if (end) AND.push({ playedAt: { lte: end } })

  if (p.myDeckIds?.length) {
    AND.push({ my_deckId: { in: p.myDeckIds } })
    // 若要「我方或對方任一」命中，改成：
    // AND.push({ OR: [{ my_deckId: { in: p.myDeckIds } }, { oppo_deckId: { in: p.myDeckIds } }] })
  }

  if (p.tagIds?.length) {
    AND.push({ tags: { some: { tagId: { in: p.tagIds } } } })
  }

  if (p.note === 'with') {
    AND.push({ AND: [{ note: { not: null } }, { note: { not: '' } }] })
  } else if (p.note === 'without') {
    AND.push({ OR: [{ note: null }, { note: '' }] })
  }

  if (typeof p.crMin === 'number' || typeof p.crMax === 'number') {
    const gte = typeof p.crMin === 'number' ? p.crMin : undefined
    const lte = typeof p.crMax === 'number' ? p.crMax : undefined
    AND.push({ current_cr: { ...(gte != null ? { gte } : {}), ...(lte != null ? { lte } : {}) } })
  }

  return AND.length ? { AND } : {}
}

/** 將「舊版位置參數」或「新版物件」統一轉成 QueryPayload */
function normalizeCountArgs(args: any[]): QueryPayload {
  // 新版：第一個就是物件
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    return args[0] as QueryPayload
  }

  // 舊版：filterMy, filterOppo, filterModes, rangeKey, startDate, endDate [, extraObj]
  const [
    filterMy = [],
    filterOppo = [],
    filterModes = '',
    rangeKey = 'today',
    startDate = null,
    endDate = null,
    extra = {}
  ] = args
  const payload: QueryPayload = {
    myClassIds: filterMy,
    oppoClassIds: filterOppo,
    mode: filterModes || null,
    rangeKey,
    start: startDate,
    end: endDate
  }
  // 允許把新欄位放在最後一個 extra 物件（可選）
  if (extra && typeof extra === 'object') Object.assign(payload, extra)
  return payload
}

function normalizePageArgs(args: any[]): QueryPayload {
  // 新版：單一物件
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    return args[0] as QueryPayload
  }

  // 舊版：pageIndex, pageSize, filterMy, filterOppo, filterModes, rangeKey, startDate, endDate [, extraObj]
  const [
    pageIndex = 0,
    pageSize = 10,
    filterMy = [],
    filterOppo = [],
    filterModes = '',
    rangeKey = 'today',
    startDate = null,
    endDate = null,
    extra = {}
  ] = args

  const payload: QueryPayload = {
    pageIndex,
    pageSize,
    myClassIds: filterMy,
    oppoClassIds: filterOppo,
    mode: filterModes || null,
    rangeKey,
    start: startDate,
    end: endDate
  }
  if (extra && typeof extra === 'object') Object.assign(payload, extra)
  return payload
}

export function registerMatchesIpc(): void {
  const prisma = getPrisma()

  // 共用 where 條件
  function buildMatchWhere(
    filterMy: ClassName[] = [],
    filterOppo: ClassName[] = [],
    filterModes: string = '',
    rangeKey: RangeKey, // <— 新增
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

    // ---- 日期處理：優先使用 startDate/endDate；若都沒給但有 rangeKey，就由 rangeKey 推導 ----
    let start: Date | undefined
    let endInclusive: Date | undefined

    // 先吃明確的 start/end
    if (startDate instanceof Date && !isNaN(startDate.getTime())) {
      start = new Date(startDate)
    }
    if (endDate instanceof Date && !isNaN(endDate.getTime())) {
      const e = new Date(endDate)
      // 若是 00:00:00.000，就補到當天最後一毫秒
      if (
        e.getHours() === 0 &&
        e.getMinutes() === 0 &&
        e.getSeconds() === 0 &&
        e.getMilliseconds() === 0
      ) {
        e.setHours(23, 59, 59, 999)
      }
      endInclusive = e
    }

    // 若沒有明確 start/end，且提供了 rangeKey，則用 rangeKey 來算
    if (!start && !endInclusive && rangeKey) {
      const now = new Date()
      const s = new Date(now)
      s.setHours(0, 0, 0, 0)
      const e = new Date(now)
      e.setHours(23, 59, 59, 999)

      switch (rangeKey) {
        case 'today':
          start = s
          endInclusive = e
          break
        case '7d': {
          const s7 = new Date(s)
          s7.setDate(s7.getDate() - 6) // 含今天共 7 天
          start = s7
          endInclusive = e
          break
        }
        case '30d': {
          const s30 = new Date(s)
          s30.setDate(s30.getDate() - 29) // 含今天共 30 天
          start = s30
          endInclusive = e
          break
        }
        case 'all':
        default:
          break
      }
    }

    if (start && endInclusive) {
      where.playedAt = { gte: start, lte: endInclusive }
    } else if (start) {
      where.playedAt = { gte: start }
    } else if (endInclusive) {
      where.playedAt = { lte: endInclusive }
    }

    return where
  }

  ipcMain.handle('matches:count', async (_e, ...args: any[]) => {
    const payload = normalizeCountArgs(args)
    const where = buildWhereFromPayload(payload)
    return prisma.match.count({ where })
  })

  ipcMain.handle('matches:getPage', async (_e, ...args: any[]) => {
    try {
      const p = normalizePageArgs(args)
      const pageIndex =
        Number.isFinite(p.pageIndex) && (p.pageIndex ?? 0) >= 0 ? Math.floor(p.pageIndex!) : 0
      const pageSize =
        Number.isFinite(p.pageSize) && (p.pageSize ?? 10) > 0 ? Math.floor(p.pageSize!) : 10
      const where = buildWhereFromPayload(p)

      const rows = await prisma.match.findMany({
        where,
        orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
        skip: pageIndex * pageSize,
        take: pageSize,
        include: {
          my_deck: { select: { id: true, name: true, class: true } },
          oppo_deck: { select: { id: true, name: true, class: true } },
          tags: { select: { tag: { select: { id: true, name: true } } } }
        }
      })
      return rows
    } catch (error) {
      console.log('[ipc] matches:getPage failed:', error)
      return []
    }
  })

  ipcMain.handle(
    'matches:getPageWithExtras',
    async (
      _e,
      pageIndex: number,
      pageSize: number,
      myIds: ClassName[] = [],
      oppoIds: ClassName[] = [],
      mode: string | null = null,
      rangeKey: RangeKey = 'today',
      start?: string | number | Date | null,
      end?: string | number | Date | null
    ) => {
      try {
        // ---- 安全轉型 ----
        const toDate = (v: unknown): Date | null => {
          if (v == null) return null
          if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
            const d = new Date(Number(v))
            return isNaN(d.getTime()) ? null : d
          }
          const d = new Date(v as any)
          return isNaN(d.getTime()) ? null : d
        }

        const safePageIndex =
          Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : 0
        const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 10
        const safeMode = typeof mode === 'string' ? mode : ''

        const asClassArray = (arr: unknown[]): ClassName[] =>
          Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as ClassName[]) : []

        const filterMy = asClassArray(myIds as unknown as unknown[])
        const filterOppo = asClassArray(oppoIds as unknown as unknown[])
        const startDate = toDate(start)
        const endDate = toDate(end)

        // ---- 條件 ----
        const where = buildMatchWhere(filterMy, filterOppo, safeMode, rangeKey, startDate, endDate)

        // ---- 查詢 ----
        const rows = await prisma.match.findMany({
          where,
          orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
          skip: safePageIndex * safePageSize,
          take: safePageSize,
          include: {
            my_deck: { select: { id: true, name: true, class: true } },
            oppo_deck: { select: { id: true, name: true, class: true } },
            tags: { select: { tag: { select: { id: true, name: true } } } }
          }
        })

        return rows
      } catch (err) {
        console.error('[ipc] matches:getPageWithExtras failed:', err)
        // 不破壞前端預期型別，錯誤時回傳空陣列
        return []
      }
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

  // HUD 先只抓階級對戰
  ipcMain.handle('matches:fetchRecent', async (_e, n: number = 5) => {
    return prisma.match.findMany({
      where: { result: { not: null } },
      orderBy: { playedAt: 'desc' },
      take: n
    })
  })

  ipcMain.handle(
    'stats:getRankedWinrateByOpponent',
    async (
      _e,
      args: {
        myClass: ClassName
        gameMode: GameMode
        rangeKey?: RangeKey
        start?: string | number | Date
        end?: string | number | Date
        myDeckIds?: number[]
        tagIds?: number[]
        crMin?: number
        crMax?: number
      }
    ) => {
      return getRankedWinrateByOpponent(args)
    }
  )

  ipcMain.handle(
    'matches:updateBP',
    async (_e, matchId: number, bp: number | null): Promise<Match> => {
      // 注意：不要用 if(bp)；0 要能過
      return prisma.match.update({
        where: { id: matchId },
        data: { bp },
        include: { my_deck: true, oppo_deck: true, tags: { include: { tag: true } } }
      })
    }
  )

  // 更新備註（null/空字串 => 設為 null）
  ipcMain.handle(
    'matches:updateNote',
    async (_e, matchId: number, note: string | null): Promise<Match> => {
      const clean = (note ?? '').trim()
      return prisma.match.update({
        where: { id: matchId },
        data: { note: clean.length ? clean : null },
        include: { my_deck: true, oppo_deck: true, tags: { include: { tag: true } } }
      })
    }
  )

  // 設定我的牌組
  ipcMain.handle(
    'matches:updateMyDeck',
    async (_e, matchId: number, deckId: number | null): Promise<Match> => {
      return prisma.match.update({
        where: { id: matchId },
        data: { my_deckId: deckId },
        include: { my_deck: true, oppo_deck: true, tags: { include: { tag: true } } }
      })
    }
  )

  // 套用標籤清單（全量覆蓋）：傳入字串陣列，會 upsert Tag 並重建 MatchTag
  ipcMain.handle(
    'matches:setTags',
    async (_e, matchId: number, tagNames: string[]): Promise<Match> => {
      const names = Array.from(
        new Set(
          (tagNames ?? [])
            .map((s) => (s ?? '').trim())
            .filter(Boolean)
            .slice(0, 20) // 限制最多 20 個，避免濫用
        )
      )

      return await prisma.$transaction(async (tx) => {
        // 找到/建立 tags
        const tags: Tag[] = []
        for (const name of names) {
          const tag = await tx.tag.upsert({
            where: { name },
            update: {},
            create: { name }
          })
          tags.push(tag)
        }

        // 先清掉舊的，再建立新的
        await tx.matchTag.deleteMany({ where: { matchId } })
        if (tags.length) {
          await tx.matchTag.createMany({
            data: tags.map((t) => ({ matchId, tagId: t.id }))
          })
        }

        // 回傳含 tag 的 match
        return tx.match.findUniqueOrThrow({
          where: { id: matchId },
          include: { my_deck: true, oppo_deck: true, tags: { include: { tag: true } } }
        })
      })
    }
  )

  ipcMain.handle('matches:getById', async (_e, id: number) => {
    const m = await prisma.match.findUnique({
      where: { id },
      include: {
        tags: { include: { tag: true } },
        my_deck: true,
        oppo_deck: true
      }
    })
    return m
  })

  // 編輯（含 tags，同步集合；內含樂觀鎖）
  ipcMain.handle('matches:updateWithExtras', async (_e, payload) => {
    const {
      id,
      prevUpdatedAt, // 來自前端的上一版 updatedAt（ISO 字串或 Date）
      tagIds,
      result,
      play_order,
      my_class,
      oppo_class,
      mode,
      bp,
      durationTime,
      my_deckId,
      oppo_deckId,
      note,
      playedAt
    } = payload

    // 1) 先抓目前的 updatedAt（用於前端錯誤訊息/除錯）
    const prev = await prisma.match.findUnique({
      where: { id },
      select: { updatedAt: true }
    })
    if (!prev) throw new Error('Match not found')

    // 2) 準備 updateMany 可用的資料（只能放標量欄位、不能放 nested relation）
    const dataMany: Prisma.MatchUncheckedUpdateManyInput = {}

    if (typeof result !== 'undefined') dataMany.result = result
    if (typeof play_order !== 'undefined') dataMany.play_order = play_order
    if (typeof my_class !== 'undefined') dataMany.my_class = my_class
    if (typeof oppo_class !== 'undefined') dataMany.oppo_class = oppo_class
    if (typeof mode !== 'undefined') dataMany.mode = mode
    if (typeof bp !== 'undefined') dataMany.bp = bp
    if (typeof durationTime !== 'undefined') dataMany.durationTime = durationTime
    if (typeof note !== 'undefined') dataMany.note = note

    // ✅ 用外鍵欄位，而不是 my_deck / oppo_deck 的 connect/disconnect
    if (typeof my_deckId !== 'undefined') dataMany.my_deckId = my_deckId ?? null
    if (typeof oppo_deckId !== 'undefined') dataMany.oppo_deckId = oppo_deckId ?? null

    if (typeof playedAt !== 'undefined' && playedAt !== null) {
      const dt = new Date(playedAt)
      dataMany.playedAt = dt
      dataMany.year = dt.getFullYear()
      dataMany.month = dt.getMonth() + 1
      dataMany.day = dt.getDate()
    }

    // 樂觀鎖：把 updatedAt 轉成 Date，允許 null 的情況
    const prevTs = prevUpdatedAt ? new Date(prevUpdatedAt) : null

    const updated = await prisma.$transaction(async (tx) => {
      // 3) 先嘗試更新（用 updateMany + updatedAt 做條件，確保原子性）
      const whereLock: Prisma.MatchWhereInput = {
        id,
        // 如果 updatedAt 可能為 null，要分兩種條件
        ...(prevTs === null ? { updatedAt: null } : { updatedAt: prevTs })
      }

      const res = await tx.match.updateMany({
        where: whereLock,
        data: dataMany
      })

      if (res.count === 0) {
        const err = new Error('CONFLICT_UPDATED_AT')
        ;(err as any).code = 'CONFLICT'
        throw err
      }

      // 4) 同步 Tags（樞紐表）
      if (Array.isArray(tagIds)) {
        const existing = await tx.matchTag.findMany({ where: { matchId: id } })
        const existSet = new Set(existing.map((x) => x.tagId))
        const nextSet = new Set(tagIds)

        const toDel = [...existSet].filter((tid) => !nextSet.has(tid))
        const toAdd = [...nextSet].filter((tid) => !existSet.has(tid))

        if (toDel.length) {
          await tx.matchTag.deleteMany({ where: { matchId: id, tagId: { in: toDel } } })
        }
        if (toAdd.length) {
          await tx.matchTag.createMany({
            data: toAdd.map((tid) => ({ matchId: id, tagId: tid }))
          })
        }
      }

      // 5) 回傳最新資料（帶關聯）
      return tx.match.findUnique({
        where: { id },
        include: {
          tags: { include: { tag: true } },
          my_deck: true,
          oppo_deck: true
        }
      })
    })

    return updated
  })

  // 刪除（連動刪樞紐由外鍵級聯）
  ipcMain.handle('matches:delete', async (_e, id: number) => {
    await prisma.match.delete({ where: { id } })
    return true
  })
}

export function broadcastNewMatch(match?: any): void {
  // 對 HUD 與主視窗都可以發
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('matches:new', match))
}
