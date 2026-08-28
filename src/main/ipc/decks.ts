import { ipcMain } from 'electron'
import type { Kysely, Transaction } from 'kysely'
import type { ClassName, Deck, DeckCategory, GameMode } from '../../shared/domain.js'
import {
  type Database,
  deckCategoryFromRow,
  deckFromRow,
  getDb,
  newCategoryId,
  nowMs,
  toMs
} from '../data/db/client.js'
import { broadcast } from '../utils/broadcast.js'
import { RangeKey } from './helper.js'

/* ================================
 * 型別
 * ================================ */

type DeckCreateInput = {
  name: string
  class: ClassName
  categoryId?: string | null
  isDefault?: boolean
}

type DeckUpdateInput = {
  id: number
  name?: string
  categoryId?: string | null
  // 避免語意混亂，不在 update 中改職業；若有需要另開 API。
  isDefault?: boolean
}

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Res<T> = Ok<T> | Err

type Db = Kysely<Database> | Transaction<Database>
type DeckStatsRow = {
  deckId: number
  total: number
  wins: number
  winRate: number
}
type ReferenceDataScope = 'decks' | 'tags' | 'categories' | 'all'

// The 3s stats cache that used to sit here existed to hide the Prisma engine's
// per-call overhead. An in-process better-sqlite3 aggregate over this data size
// is microseconds, so the cache - and the version bookkeeping that kept it
// honest - is gone rather than ported.

function notifyReferenceDataChanged(scope: ReferenceDataScope): void {
  broadcast('reference-data:changed', { scope })
}

/* ================================
 * 小工具：統一錯誤處理 / 資料驗證 / 輔助
 * ================================ */

// 統一 try/catch 包裝，回傳 Res<T>
const wrap = async <T>(fn: () => Promise<T>): Promise<Res<T>> => {
  try {
    const data = await fn()
    return { ok: true, data }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// 把 '' 視為 null（未分類）
const coerceCategoryId = (v?: string | null): string | null => {
  if (v === '' || v == null) return null
  return v
}

// 名稱校驗（後端底線：不可為空；若你想限制長度，調整 MAX_NAME_LEN）
const MAX_NAME_LEN = 64
const assertValidName = (name?: string): string => {
  const n = (name ?? '').trim()
  if (!n) throw new Error('INVALID_INPUT:Name is required')
  if (n.length > MAX_NAME_LEN) throw new Error('INVALID_INPUT:Name too long')
  return n
}

// 分類存在性確認
async function ensureCategoryExists(db: Db, categoryId?: string | null): Promise<void> {
  const cid = coerceCategoryId(categoryId)
  if (!cid) return
  const exists = await db
    .selectFrom('DeckCategory')
    .select('id')
    .where('id', '=', cid)
    .executeTakeFirst()
  if (!exists) throw new Error('NOT_FOUND:Category')
}

// 不分大小寫重名檢查（同職業 + 同分類）
const norm = (s: string): string => s.trim().toLocaleLowerCase()
async function hasNameDuplicateCI(
  db: Db,
  params: { cls: string; categoryId: string | null; name: string; excludeId?: number }
): Promise<boolean> {
  let query = db.selectFrom('Deck').select(['id', 'name']).where('class', '=', params.cls)
  query =
    params.categoryId === null
      ? query.where('categoryId', 'is', null)
      : query.where('categoryId', '=', params.categoryId)
  const rows = await query.execute()
  const target = norm(params.name)
  return rows.some(
    (r) => (params.excludeId ? r.id !== params.excludeId : true) && norm(r.name) === target
  )
}

const toDateSafe = (v: unknown): Date | null => {
  if (v == null) return null
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const d = new Date(Number(v))
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(v as string | Date)
  return isNaN(d.getTime()) ? null : d
}

const computeRange = (p: {
  rangeKey?: RangeKey
  start?: unknown
  end?: unknown
}): {
  start?: Date
  end?: Date
} => {
  const start = toDateSafe(p.start)
  const end = toDateSafe(p.end)
  if (start || end) return { start: start ?? undefined, end: end ?? undefined }

  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now)
  todayEnd.setHours(23, 59, 59, 999)

  if (p.rangeKey === 'today' || !p.rangeKey) return { start: todayStart, end: todayEnd }
  if (p.rangeKey === 'all') return {}

  if (p.rangeKey === '7d') {
    const s7 = new Date(todayStart)
    s7.setDate(s7.getDate() - 6)
    return { start: s7, end: todayEnd }
  }
  if (p.rangeKey === '30d') {
    const s30 = new Date(todayStart)
    s30.setDate(s30.getDate() - 29)
    return { start: s30, end: todayEnd }
  }
  return {}
}

/* ================================
 * IPC
 * ================================ */

export function registerDecksIpc(): void {
  const db = getDb()

  // 取全部分類（穩定排序）
  ipcMain.handle(
    'deckCategories:all',
    async (): Promise<Res<DeckCategory[]>> =>
      wrap(async () => {
        const rows = await db
          .selectFrom('DeckCategory')
          .selectAll()
          .orderBy('sort', 'asc')
          .orderBy('name', 'asc')
          .execute()
        return rows.map(deckCategoryFromRow)
      })
  )

  // 取全部牌組（給前端用的排序；回傳必要欄位）
  ipcMain.handle(
    'decks:all',
    async (): Promise<
      Res<
        Pick<
          Deck,
          'id' | 'name' | 'class' | 'categoryId' | 'isDefault' | 'createdAt' | 'updatedAt'
        >[]
      >
    > =>
      wrap(async () => {
        const rows = await db
          .selectFrom('Deck')
          .selectAll()
          .orderBy('class', 'asc')
          .orderBy('isDefault', 'desc')
          .orderBy('updatedAt', 'desc')
          .orderBy('name', 'asc')
          .execute()
        return rows.map(deckFromRow)
      })
  )

  // 牌組戰績：依我方牌組統計勝率
  ipcMain.handle(
    'decks:stats',
    async (
      _e,
      params: {
        deckIds?: number[]
        mode?: GameMode | 'all'
        rangeKey?: RangeKey
        start?: string | number | Date | null
        end?: string | number | Date | null
      } = {}
    ): Promise<Res<DeckStatsRow[]>> =>
      wrap(async () => {
        const { start, end } = computeRange(params)

        let query = db
          .selectFrom('Match')
          .select(({ fn, eb }) => [
            'my_deckId',
            fn.countAll<number>().as('total'),
            // SQLite has no FILTER-free conditional count shorter than SUM.
            eb.fn.sum<number>(eb.case().when('result', '=', 1).then(1).else(0).end()).as('wins')
          ])
          .where('my_deckId', 'is not', null)
          .where('result', 'is not', null)
          .groupBy('my_deckId')

        if (params.deckIds?.length) query = query.where('my_deckId', 'in', params.deckIds)
        if (params.mode && params.mode !== 'all') query = query.where('mode', '=', params.mode)
        if (start) query = query.where('playedAt', '>=', toMs(start))
        if (end) query = query.where('playedAt', '<=', toMs(end))

        const grouped = await query.execute()
        return grouped
          .filter((row) => row.my_deckId != null)
          .map((row) => {
            const total = Number(row.total)
            const wins = Number(row.wins ?? 0)
            return {
              deckId: row.my_deckId as number,
              total,
              wins,
              winRate: total > 0 ? +((wins / total) * 100).toFixed(2) : 0
            }
          })
      })
  )

  // 建立分類（如需）
  ipcMain.handle(
    'deckCategories:create',
    async (_e, input: { name: string }): Promise<Res<DeckCategory>> =>
      wrap(async () => {
        const name = assertValidName(input?.name)
        const now = nowMs()
        const row = await db
          .insertInto('DeckCategory')
          .values({ id: newCategoryId(), name, createdAt: now, updatedAt: now })
          .returningAll()
          .executeTakeFirstOrThrow()
        notifyReferenceDataChanged('categories')
        return deckCategoryFromRow(row)
      })
  )

  // 建立牌組：支援 isDefault；若 isDefault=true，單一交易清掉同職業其它預設
  ipcMain.handle(
    'decks:create',
    async (_e, input: DeckCreateInput): Promise<Res<Deck>> =>
      wrap(async () => {
        const name = assertValidName(input?.name)
        if (!input?.class) throw new Error('INVALID_INPUT:Class is required')

        const categoryId = coerceCategoryId(input.categoryId)

        const created = await db.transaction().execute(async (tx) => {
          await ensureCategoryExists(tx, categoryId)

          // 不分大小寫重名檢查（同職業 + 同分類）
          const dup = await hasNameDuplicateCI(tx, {
            cls: input.class,
            categoryId,
            name
          })
          if (dup) throw new Error('DUPLICATE_NAME')

          if (input.isDefault) {
            await tx
              .updateTable('Deck')
              .set({ isDefault: 0 })
              .where('class', '=', input.class)
              .execute()
          }

          const now = nowMs()
          return tx
            .insertInto('Deck')
            .values({
              name,
              class: input.class,
              categoryId,
              isDefault: input.isDefault ? 1 : 0,
              createdAt: now,
              updatedAt: now
            })
            .returningAll()
            .executeTakeFirstOrThrow()
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(created)
      })
  )

  // 更新牌組：名稱/分類/isDefault（同樣維持單一預設的不變量）
  ipcMain.handle(
    'decks:update',
    async (_e, input: DeckUpdateInput): Promise<Res<Deck>> =>
      wrap(async () => {
        const { id } = input
        if (!id) throw new Error('INVALID_INPUT:ID is required')

        const updated = await db.transaction().execute(async (tx) => {
          const current = await tx
            .selectFrom('Deck')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirst()
          if (!current) throw new Error('NOT_FOUND:Deck')

          const data: { name?: string; categoryId?: string | null; isDefault?: number } = {}

          if (typeof input.name === 'string') {
            data.name = assertValidName(input.name)
          }

          if (typeof input.categoryId !== 'undefined') {
            const nextCat = coerceCategoryId(input.categoryId)
            if (nextCat) await ensureCategoryExists(tx, nextCat)
            data.categoryId = nextCat
          }

          // 名稱唯一檢查（以「欲更新後的 class + categoryId + name」為準）
          if (typeof data.name === 'string' || typeof data.categoryId !== 'undefined') {
            const nextCatId =
              typeof data.categoryId !== 'undefined' ? data.categoryId : current.categoryId
            const nextName = typeof data.name === 'string' ? data.name : current.name
            const dup = await hasNameDuplicateCI(tx, {
              cls: current.class,
              categoryId: nextCatId ?? null,
              name: nextName,
              excludeId: id
            })
            if (dup) throw new Error('DUPLICATE_NAME')
          }

          // isDefault 調整（同職業僅能有一個）
          if (typeof input.isDefault === 'boolean') {
            if (input.isDefault) {
              await tx
                .updateTable('Deck')
                .set({ isDefault: 0 })
                .where('class', '=', current.class)
                .execute()
              data.isDefault = 1
            } else {
              data.isDefault = 0
            }
          }

          return tx
            .updateTable('Deck')
            .set({ ...data, updatedAt: nowMs() })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow()
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(updated)
      })
  )

  // 刪除牌組。FK 的 onDelete: SetNull 定義在 schema（001_init.sql），行為不變。
  ipcMain.handle(
    'decks:delete',
    async (_e, { id }: { id: number }): Promise<Res<{ success: true }>> =>
      wrap(async () => {
        const deleted = await db.deleteFrom('Deck').where('id', '=', id).executeTakeFirst()
        if (deleted.numDeletedRows === 0n) throw new Error('NOT_FOUND:Deck')
        notifyReferenceDataChanged('decks')
        return { success: true as const }
      })
  )

  // 設為某職業預設：給某個 deckId 設預設，並清除此職業其他預設
  ipcMain.handle(
    'decks:setDefaultForClass',
    async (_e, { deckId }: { deckId: number }): Promise<Res<Deck>> =>
      wrap(async () => {
        const updated = await db.transaction().execute(async (tx) => {
          const deck = await tx
            .selectFrom('Deck')
            .selectAll()
            .where('id', '=', deckId)
            .executeTakeFirst()
          if (!deck) throw new Error('NOT_FOUND:Deck')
          await tx
            .updateTable('Deck')
            .set({ isDefault: 0 })
            .where('class', '=', deck.class)
            .execute()
          return tx
            .updateTable('Deck')
            .set({ isDefault: 1, updatedAt: nowMs() })
            .where('id', '=', deckId)
            .returningAll()
            .executeTakeFirstOrThrow()
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(updated)
      })
  )
}
