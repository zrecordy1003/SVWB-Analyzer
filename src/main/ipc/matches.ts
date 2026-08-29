import { ipcMain } from 'electron'
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import type { ClassName, Deck, GameMode, Match, Tag } from '../../shared/domain.js'
import {
  deckFromRow,
  getDb,
  matchFromRow,
  nowMs,
  tagFromRow,
  toMs,
  type Database,
  type MatchRow
} from '../data/db/client.js'
import { getRankedWinrateByOpponent, RangeKey } from './helper.js'
import { broadcast } from '../utils/broadcast.js'

/**
 * Tell every window the match data moved.
 *
 * The engine broadcasts this for its own writes (see recognition/engine.ts),
 * but user edits went out silently: the match list patched its own card and
 * the analyzer, deck performance table and HUD kept showing pre-edit numbers
 * until something else made them re-query. Same channel, so every surface that
 * already listens picks these up too.
 */
function notifyMatchesChanged(): void {
  broadcast('matches:needRefetch')
}

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
  cursor?: { playedAt: string; id: number } | null

  // for getPage
  pageIndex?: number
  pageSize?: number
}

/** The match plus its relations, tags flattened. `queryList`/`getExtras` shape. */
type MatchWithRelations = Match & {
  my_deck: Deck | null
  oppo_deck: Deck | null
  tags: Tag[]
}

/**
 * The pivot-row shape Prisma's `include: { tags: { include: { tag } } }`
 * produced. The detail/edit handlers all returned it, and the renderer's edit
 * dialog reads `tags[].tag` - so the shape is part of the IPC contract, pinned
 * by `tests/main/ipcSmoke.test.ts`, and must not be "cleaned up" here.
 */
function toPivotShape(record: MatchWithRelations): Omit<MatchWithRelations, 'tags'> & {
  tags: { matchId: number; tagId: number; tag: Tag }[]
} {
  return {
    ...record,
    tags: record.tags.map((tag) => ({ matchId: record.id, tagId: tag.id, tag }))
  }
}

function toDateSafe(v: unknown): Date | null {
  if (v == null) return null
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const d = new Date(Number(v))
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(v as string | Date)
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

/**
 * The one place the list filters become SQL. Every list surface - count, the
 * keyset page, the offset pages - goes through this, so a filter cannot mean
 * one thing in the count and another in the rows it counts. Returned as
 * expressions so each call site keeps its own SELECT shape.
 */
function filterExpressions(
  eb: ExpressionBuilder<Database, 'Match'>,
  p: QueryPayload
): Expression<SqlBool>[] {
  const exprs: Expression<SqlBool>[] = []

  if (p.myClassIds?.length) exprs.push(eb('my_class', 'in', p.myClassIds))
  if (p.oppoClassIds?.length) exprs.push(eb('oppo_class', 'in', p.oppoClassIds))
  if (p.mode) exprs.push(eb('mode', '=', p.mode))

  const { start, end } = computeDateRangeByKey(p)
  if (start) exprs.push(eb('playedAt', '>=', toMs(start)))
  if (end) exprs.push(eb('playedAt', '<=', toMs(end)))

  if (p.myDeckIds?.length) exprs.push(eb('my_deckId', 'in', p.myDeckIds))
  // 若要「我方或對方任一」命中，改成 or([my_deckId in, oppo_deckId in])

  if (p.tagIds?.length) {
    exprs.push(
      eb.exists(
        eb
          .selectFrom('MatchTag')
          .select('MatchTag.matchId')
          .whereRef('MatchTag.matchId', '=', 'Match.id')
          .where('MatchTag.tagId', 'in', p.tagIds)
      )
    )
  }

  if (p.note === 'with') {
    exprs.push(eb('note', 'is not', null))
    exprs.push(eb('note', '!=', ''))
  } else if (p.note === 'without') {
    exprs.push(eb.or([eb('note', 'is', null), eb('note', '=', '')]))
  }

  if (typeof p.crMin === 'number') exprs.push(eb('current_cr', '>=', p.crMin))
  if (typeof p.crMax === 'number') exprs.push(eb('current_cr', '<=', p.crMax))

  return exprs
}

/** 將「舊版位置參數」或「新版物件」統一轉成 QueryPayload */
function normalizeCountArgs(args: unknown[]): QueryPayload {
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
  ] = args as [ClassName[], ClassName[], string, RangeKey, unknown, unknown, object]
  const payload: QueryPayload = {
    myClassIds: filterMy,
    oppoClassIds: filterOppo,
    mode: (filterModes || null) as GameMode | null,
    rangeKey,
    start: startDate as QueryPayload['start'],
    end: endDate as QueryPayload['end']
  }
  // 允許把新欄位放在最後一個 extra 物件（可選）
  if (extra && typeof extra === 'object') Object.assign(payload, extra)
  return payload
}

function normalizePageArgs(args: unknown[]): QueryPayload {
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
  ] = args as [number, number, ClassName[], ClassName[], string, RangeKey, unknown, unknown, object]

  const payload: QueryPayload = {
    pageIndex,
    pageSize,
    myClassIds: filterMy,
    oppoClassIds: filterOppo,
    mode: (filterModes || null) as GameMode | null,
    rangeKey,
    start: startDate as QueryPayload['start'],
    end: endDate as QueryPayload['end']
  }
  if (extra && typeof extra === 'object') Object.assign(payload, extra)
  return payload
}

export function registerMatchesIpc(): void {
  const db = getDb()

  /**
   * Load matches with their decks and tags, shaped as Prisma's `include` shaped
   * them. Returned in the order of `ids`, so a keyset page keeps its ordering
   * without re-sorting. Three queries total regardless of page size - the same
   * bound the old `include` compiled to.
   */
  async function loadWithRelations(ids: number[]): Promise<MatchWithRelations[]> {
    if (ids.length === 0) return []

    const [matchRows, deckRows, tagLinks] = await Promise.all([
      db.selectFrom('Match').selectAll().where('id', 'in', ids).execute(),
      db
        .selectFrom('Deck')
        .selectAll()
        .where(({ eb, or, selectFrom }) =>
          or([
            eb('id', 'in', selectFrom('Match').select('my_deckId as id').where('id', 'in', ids)),
            eb('id', 'in', selectFrom('Match').select('oppo_deckId as id').where('id', 'in', ids))
          ])
        )
        .execute(),
      db
        .selectFrom('MatchTag')
        .innerJoin('Tag', 'Tag.id', 'MatchTag.tagId')
        .select(['MatchTag.matchId', 'Tag.id', 'Tag.name', 'Tag.createdAt', 'Tag.updatedAt'])
        .where('MatchTag.matchId', 'in', ids)
        .execute()
    ])

    const decksById = new Map(deckRows.map((row) => [row.id, deckFromRow(row)]))
    const tagsByMatch = new Map<number, Tag[]>()
    for (const link of tagLinks) {
      const list = tagsByMatch.get(link.matchId) ?? []
      list.push(
        tagFromRow({
          id: link.id,
          name: link.name,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt
        })
      )
      tagsByMatch.set(link.matchId, list)
    }

    const byId = new Map(
      matchRows.map((row) => {
        const match = matchFromRow(row)
        return [
          row.id,
          {
            ...match,
            my_deck: row.my_deckId != null ? (decksById.get(row.my_deckId) ?? null) : null,
            oppo_deck: row.oppo_deckId != null ? (decksById.get(row.oppo_deckId) ?? null) : null,
            tags: tagsByMatch.get(row.id) ?? []
          } satisfies MatchWithRelations
        ]
      })
    )
    return ids.flatMap((id) => {
      const record = byId.get(id)
      return record ? [record] : []
    })
  }

  async function countMatches(p: QueryPayload): Promise<number> {
    const row = await db
      .selectFrom('Match')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where((eb) => eb.and(filterExpressions(eb, p)))
      .executeTakeFirstOrThrow()
    return Number(row.n)
  }

  ipcMain.handle('matches:count', async (_e, ...args: unknown[]) => {
    return countMatches(normalizeCountArgs(args))
  })

  /**
   * Match list's hot path: keyset pagination on the (playedAt, id) index.
   *
   * The row-value comparison seeks straight into the index; the OR-expansion
   * equivalent is semantically identical but degrades to an index scan, which is
   * why the old code dropped to raw SQL here. It stays raw for the same reason.
   */
  ipcMain.handle('matches:queryList', async (_e, ...args: unknown[]) => {
    const p = normalizePageArgs(args)
    const requestedPageSize =
      Number.isFinite(p.pageSize) && (p.pageSize ?? 10) > 0 ? Math.floor(p.pageSize!) : 10
    const pageSize = Math.min(requestedPageSize, 100)

    const cursorPlayedAt = toDateSafe(p.cursor?.playedAt)
    const cursorId = p.cursor?.id
    const hasCursor =
      cursorPlayedAt != null && Number.isSafeInteger(cursorId) && (cursorId as number) > 0

    const ids = (
      await db
        .selectFrom('Match')
        .select('id')
        .where((eb) => {
          const exprs = filterExpressions(eb, p)
          if (hasCursor) {
            // Row-value comparison seeks straight into the (playedAt, id)
            // index; the OR-expansion equivalent degrades to a scan, which is
            // why this stays raw SQL.
            exprs.push(sql<SqlBool>`("playedAt", "id") < (${toMs(cursorPlayedAt!)}, ${cursorId})`)
          }
          return eb.and(exprs)
        })
        .orderBy('playedAt', 'desc')
        .orderBy('id', 'desc')
        .limit(pageSize + 1)
        .execute()
    ).map((row) => row.id)

    const [records, total] = await Promise.all([
      loadWithRelations(ids),
      hasCursor ? Promise.resolve(null) : countMatches(p)
    ])

    const hasMore = records.length > pageSize
    const pageRecords = hasMore ? records.slice(0, pageSize) : records
    const last = pageRecords[pageRecords.length - 1]

    return {
      rows: pageRecords.map((record) => ({
        ...record,
        // The old select shipped only {id,name} per tag; the cards read nothing
        // else, and the shape is pinned by ipcSmoke.
        tags: record.tags.map(({ id, name }) => ({ id, name })),
        tagCount: record.tags.length
      })),
      total,
      hasMore,
      nextCursor: hasMore && last ? { playedAt: last.playedAt.toISOString(), id: last.id } : null
    }
  })

  ipcMain.handle('matches:getExtras', async (_e, id: number) => {
    const [match] = await loadWithRelations([id])
    return {
      note: match?.note ?? null,
      tags: (match?.tags ?? []).map(({ id: tagId, name }) => ({ id: tagId, name }))
    }
  })

  ipcMain.handle('matches:getPage', async (_e, ...args: unknown[]) => {
    try {
      const p = normalizePageArgs(args)
      const pageIndex =
        Number.isFinite(p.pageIndex) && (p.pageIndex ?? 0) >= 0 ? Math.floor(p.pageIndex!) : 0
      const pageSize =
        Number.isFinite(p.pageSize) && (p.pageSize ?? 10) > 0 ? Math.floor(p.pageSize!) : 10

      const ids = (
        await db
          .selectFrom('Match')
          .select('id')
          .where((eb) => eb.and(filterExpressions(eb, p)))
          .orderBy('playedAt', 'desc')
          .orderBy('id', 'desc')
          .offset(pageIndex * pageSize)
          .limit(pageSize)
          .execute()
      ).map((row) => row.id)

      return (await loadWithRelations(ids)).map(toPivotShape)
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
        const safePageIndex =
          Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : 0
        const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 10

        const asClassArray = (arr: unknown[]): ClassName[] =>
          Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as ClassName[]) : []

        // 舊參數形狀，直接映射到共用的 payload。
        // 舊版 end 若是零點整，補到當天最後一毫秒的行為由 toDateSafe + 呼叫端保持。
        const endDate = toDateSafe(end)
        if (
          endDate &&
          endDate.getHours() === 0 &&
          endDate.getMinutes() === 0 &&
          endDate.getSeconds() === 0 &&
          endDate.getMilliseconds() === 0
        ) {
          endDate.setHours(23, 59, 59, 999)
        }

        const p: QueryPayload = {
          myClassIds: asClassArray(myIds as unknown[]),
          oppoClassIds: asClassArray(oppoIds as unknown[]),
          mode: ((typeof mode === 'string' ? mode : '') || null) as GameMode | null,
          rangeKey,
          start: toDateSafe(start),
          end: endDate
        }

        const ids = (
          await db
            .selectFrom('Match')
            .select('id')
            .where((eb) => eb.and(filterExpressions(eb, p)))
            .orderBy('playedAt', 'desc')
            .orderBy('id', 'desc')
            .offset(safePageIndex * safePageSize)
            .limit(safePageSize)
            .execute()
        ).map((row) => row.id)

        return (await loadWithRelations(ids)).map(toPivotShape)
      } catch (err) {
        console.error('[ipc] matches:getPageWithExtras failed:', err)
        // 不破壞前端預期型別，錯誤時回傳空陣列
        return []
      }
    }
  )

  // HUD 先只抓階級對戰
  ipcMain.handle(
    'matches:fetchRecent',
    async (_e, n: number = 5, mode?: GameMode | 'all' | null) => {
      let query = db
        .selectFrom('Match')
        .selectAll()
        // `mode` is absent on older rows, so filtering by it also drops those;
        // that is intended - an unrecognised mode is not a match of any mode.
        .where('result', 'is not', null)
      if (mode && mode !== 'all') query = query.where('mode', '=', mode)
      const rows = await query.orderBy('playedAt', 'desc').limit(n).execute()
      return rows.map(matchFromRow)
    }
  )

  /**
   * The mode of the most recently recorded match, unfiltered.
   *
   * Deliberately NOT derived from `matches:fetchRecent`: that query is itself
   * scoped by the HUD's mode filter, so reading the newest row of its result to
   * decide the filter is circular - once the HUD is showing 2Pick, every row it
   * can see is 2Pick, and it could never learn that the next match was ranked.
   *
   * `null` when there are no completed matches, or when the newest one has no
   * recognised mode. Both mean the same thing to the caller: nothing to follow.
   */
  ipcMain.handle('matches:latestMode', async () => {
    const row = await db
      .selectFrom('Match')
      .select('mode')
      .where('result', 'is not', null)
      .orderBy('playedAt', 'desc')
      .limit(1)
      .executeTakeFirst()
    return (row?.mode ?? null) as GameMode | null
  })

  ipcMain.handle(
    'stats:getRankedWinrateByOpponent',
    async (
      _e,
      args: {
        myClass: ClassName
        gameMode: GameMode | 'all'
        rangeKey?: RangeKey
        start?: string | number | Date
        end?: string | number | Date
        myDeckIds?: number[]
        tagIds?: number[]
        crMin?: number
        crMax?: number
        limit?: number
      }
    ) => {
      return getRankedWinrateByOpponent(args)
    }
  )

  /** One scalar-column update plus the relation-shaped reload every editor expects. */
  async function updateAndReload(
    matchId: number,
    values: Partial<Omit<MatchRow, 'id'>>
  ): Promise<ReturnType<typeof toPivotShape>> {
    await db
      .updateTable('Match')
      // Prisma's @updatedAt bumped this implicitly on every update; the
      // optimistic lock in updateWithExtras depends on that, so it stays.
      .set({ ...values, updatedAt: nowMs() })
      .where('id', '=', matchId)
      .execute()
    const [reloaded] = await loadWithRelations([matchId])
    if (!reloaded) throw new Error('Match not found')
    notifyMatchesChanged()
    return toPivotShape(reloaded)
  }

  ipcMain.handle('matches:updateBP', async (_e, matchId: number, bp: number | null) => {
    // 注意：不要用 if(bp)；0 要能過
    return updateAndReload(matchId, { bp })
  })

  // 更新備註（null/空字串 => 設為 null）
  ipcMain.handle('matches:updateNote', async (_e, matchId: number, note: string | null) => {
    const clean = (note ?? '').trim()
    return updateAndReload(matchId, { note: clean.length ? clean : null })
  })

  // 設定單邊牌組：對局卡片上就地改牌組走這條，不必開編輯視窗
  ipcMain.handle(
    'matches:updateDeck',
    async (_e, matchId: number, side: 'my' | 'oppo', deckId: number | null) => {
      return updateAndReload(
        matchId,
        side === 'my' ? { my_deckId: deckId } : { oppo_deckId: deckId }
      )
    }
  )

  // 套用標籤清單（全量覆蓋）：傳入字串陣列，會 upsert Tag 並重建 MatchTag
  ipcMain.handle('matches:setTags', async (_e, matchId: number, tagNames: string[]) => {
    const names = Array.from(
      new Set(
        (tagNames ?? [])
          .map((s) => (s ?? '').trim())
          .filter(Boolean)
          .slice(0, 20) // 限制最多 20 個，避免濫用
      )
    )

    await db.transaction().execute(async (tx) => {
      // 找到/建立 tags（Tag.name 有 unique 索引，衝突即已存在）
      const tagIds: number[] = []
      for (const name of names) {
        await tx
          .insertInto('Tag')
          .values({ name, createdAt: nowMs(), updatedAt: nowMs() })
          .onConflict((oc) => oc.column('name').doNothing())
          .execute()
        const tag = await tx
          .selectFrom('Tag')
          .select('id')
          .where('name', '=', name)
          .executeTakeFirstOrThrow()
        tagIds.push(tag.id)
      }

      // 先清掉舊的，再建立新的
      await tx.deleteFrom('MatchTag').where('matchId', '=', matchId).execute()
      if (tagIds.length) {
        await tx
          .insertInto('MatchTag')
          .values(tagIds.map((tagId) => ({ matchId, tagId })))
          .execute()
      }
    })

    const [reloaded] = await loadWithRelations([matchId])
    if (!reloaded) throw new Error('Match not found')
    notifyMatchesChanged()
    return toPivotShape(reloaded)
  })

  ipcMain.handle('matches:getById', async (_e, id: number) => {
    const [match] = await loadWithRelations([id])
    return match ? toPivotShape(match) : null
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

    const exists = await db.selectFrom('Match').select('id').where('id', '=', id).executeTakeFirst()
    if (!exists) throw new Error('Match not found')

    const values: Partial<Omit<MatchRow, 'id'>> = {}
    if (typeof result !== 'undefined') values.result = result === null ? null : result ? 1 : 0
    if (typeof play_order !== 'undefined') values.play_order = play_order
    if (typeof my_class !== 'undefined') values.my_class = my_class
    if (typeof oppo_class !== 'undefined') values.oppo_class = oppo_class
    if (typeof mode !== 'undefined') values.mode = mode
    if (typeof bp !== 'undefined') values.bp = bp
    if (typeof durationTime !== 'undefined') values.durationTime = durationTime
    if (typeof note !== 'undefined') values.note = note
    if (typeof my_deckId !== 'undefined') values.my_deckId = my_deckId ?? null
    if (typeof oppo_deckId !== 'undefined') values.oppo_deckId = oppo_deckId ?? null

    if (typeof playedAt !== 'undefined' && playedAt !== null) {
      const dt = new Date(playedAt)
      values.playedAt = dt.getTime()
      values.year = dt.getFullYear()
      values.month = dt.getMonth() + 1
      values.day = dt.getDate()
    }

    // 樂觀鎖：以 updatedAt 為條件的原子更新；epoch 毫秒比對，等價於舊版的 Date 比對
    const prevTs = prevUpdatedAt ? toMs(prevUpdatedAt as string | Date) : null

    await db.transaction().execute(async (tx) => {
      let update = tx
        .updateTable('Match')
        .set({ ...values, updatedAt: nowMs() })
        .where('id', '=', id)
      update =
        prevTs === null
          ? update.where('updatedAt', 'is', null)
          : update.where('updatedAt', '=', prevTs)
      const res = await update.executeTakeFirst()

      if (res.numUpdatedRows === 0n) {
        const err = new Error('CONFLICT_UPDATED_AT')
        ;(err as Error & { code?: string }).code = 'CONFLICT'
        throw err
      }

      // 同步 Tags（樞紐表）：差集增刪，不動沒變的
      if (Array.isArray(tagIds)) {
        const existing = await tx
          .selectFrom('MatchTag')
          .select('tagId')
          .where('matchId', '=', id)
          .execute()
        const existSet = new Set(existing.map((x) => x.tagId))
        const nextSet = new Set(tagIds as number[])

        const toDel = [...existSet].filter((tid) => !nextSet.has(tid))
        const toAdd = [...nextSet].filter((tid) => !existSet.has(tid))

        if (toDel.length) {
          await tx
            .deleteFrom('MatchTag')
            .where('matchId', '=', id)
            .where('tagId', 'in', toDel)
            .execute()
        }
        if (toAdd.length) {
          await tx
            .insertInto('MatchTag')
            .values(toAdd.map((tid) => ({ matchId: id, tagId: tid })))
            .execute()
        }
      }
    })

    const [reloaded] = await loadWithRelations([id])
    notifyMatchesChanged()
    return reloaded ? toPivotShape(reloaded) : null
  })

  // 刪除（連動刪樞紐由外鍵級聯）
  ipcMain.handle('matches:delete', async (_e, id: number) => {
    await db.deleteFrom('Match').where('id', '=', id).execute()
    notifyMatchesChanged()
    return true
  })
}
