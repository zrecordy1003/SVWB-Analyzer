/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipcMain } from 'electron'
import type { Prisma, PrismaClient, ClassName, Deck, DeckCategory } from '@prisma/client'
import { getPrisma } from '../db/prismaClient.js'

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
  // class?: ClassName
  isDefault?: boolean
}

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Res<T> = Ok<T> | Err

type Tx = Prisma.TransactionClient
type Db = PrismaClient | Tx

/* ================================
 * 小工具：統一錯誤處理 / 資料驗證 / 輔助
 * ================================ */

// 統一 try/catch 包裝，回傳 Res<T>
const wrap = async <T>(fn: () => Promise<T>): Promise<Res<T>> => {
  try {
    const data = await fn()
    return { ok: true, data }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Unknown error' }
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
  const exists = await db.deckCategory.findUnique({ where: { id: cid } })
  if (!exists) throw new Error('NOT_FOUND:Category')
}

// 不分大小寫重名檢查（同職業 + 同分類）
const norm = (s: string): string => s.trim().toLocaleLowerCase()
async function hasNameDuplicateCI(
  db: Db,
  params: { cls: ClassName; categoryId: string | null; name: string; excludeId?: number }
): Promise<boolean> {
  const rows = await db.deck.findMany({
    where: { class: params.cls, categoryId: params.categoryId },
    select: { id: true, name: true }
  })
  const target = norm(params.name)
  return rows.some(
    (r) => (params.excludeId ? r.id !== params.excludeId : true) && norm(r.name) === target
  )
}

/* ================================
 * IPC
 * ================================ */

export function registerDecksIpc(): void {
  const prisma: PrismaClient = getPrisma()

  // 取全部分類（穩定排序）
  ipcMain.handle(
    'deckCategories:all',
    async (): Promise<Res<DeckCategory[]>> =>
      wrap(() =>
        prisma.deckCategory.findMany({
          orderBy: [{ sort: 'asc' }, { name: 'asc' }]
        })
      )
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
      wrap(() =>
        prisma.deck.findMany({
          orderBy: [
            { class: 'asc' },
            { isDefault: 'desc' },
            { updatedAt: 'desc' },
            { name: 'asc' }
          ],
          select: {
            id: true,
            name: true,
            class: true,
            categoryId: true,
            isDefault: true,
            createdAt: true,
            updatedAt: true
          }
        })
      )
  )

  // 建立分類（如需）
  ipcMain.handle(
    'deckCategories:create',
    async (_e, input: { name: string }): Promise<Res<DeckCategory>> =>
      wrap(async () => {
        const name = assertValidName(input?.name)
        return prisma.deckCategory.create({ data: { name } })
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

        return prisma.$transaction(async (tx) => {
          await ensureCategoryExists(tx, categoryId)

          // 不分大小寫重名檢查（同職業 + 同分類）
          const dup = await hasNameDuplicateCI(tx, {
            cls: input.class,
            categoryId,
            name
          })
          if (dup) throw new Error('DUPLICATE_NAME')

          if (input.isDefault) {
            await tx.deck.updateMany({ where: { class: input.class }, data: { isDefault: false } })
          }

          const created = await tx.deck.create({
            data: {
              name,
              class: input.class,
              categoryId,
              isDefault: !!input.isDefault
            }
          })
          return created
        })
      })
  )

  // 更新牌組：名稱/分類/isDefault（同樣維持單一預設的不變量）
  ipcMain.handle(
    'decks:update',
    async (_e, input: DeckUpdateInput): Promise<Res<Deck>> =>
      wrap(async () => {
        const { id } = input
        if (!id) throw new Error('INVALID_INPUT:ID is required')

        return prisma.$transaction(async (tx) => {
          const current = await tx.deck.findUnique({ where: { id } })
          if (!current) throw new Error('NOT_FOUND:Deck')

          const data: Partial<Pick<Deck, 'name' | 'categoryId' | 'isDefault'>> = {}

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
              cls: current.class as ClassName,
              categoryId: nextCatId ?? null,
              name: nextName,
              excludeId: id
            })
            if (dup) throw new Error('DUPLICATE_NAME')
          }

          // isDefault 調整（同職業僅能有一個）
          if (typeof input.isDefault === 'boolean') {
            if (input.isDefault) {
              await tx.deck.updateMany({
                where: { class: current.class },
                data: { isDefault: false }
              })
              data.isDefault = true
            } else {
              data.isDefault = false
            }
          }

          const updated = await tx.deck.update({
            where: { id },
            data
          })
          return updated
        })
      })
  )

  // 刪除牌組（若 schema 設定 FK onDelete: SetNull/Restrict，這裡會依設定表現）
  ipcMain.handle(
    'decks:delete',
    async (_e, { id }: { id: number }): Promise<Res<{ success: true }>> =>
      wrap(async () => {
        await prisma.deck.delete({ where: { id } })
        return { success: true }
      })
  )

  // 設為某職業預設：給某個 deckId 設預設，並清除此職業其他預設
  ipcMain.handle(
    'decks:setDefaultForClass',
    async (_e, { deckId }: { deckId: number }): Promise<Res<Deck>> =>
      wrap(async () => {
        return prisma.$transaction(async (tx) => {
          const deck = await tx.deck.findUnique({ where: { id: deckId } })
          if (!deck) throw new Error('NOT_FOUND:Deck')
          await tx.deck.updateMany({ where: { class: deck.class }, data: { isDefault: false } })
          const updated = await tx.deck.update({ where: { id: deckId }, data: { isDefault: true } })
          return updated
        })
      })
  )

  // （可選）查詢某職業的預設牌組
  // ipcMain.handle(
  //   'decks:getDefault',
  //   async (_e, { class: cls }: { class: ClassName }): Promise<Res<Deck | null>> =>
  //     wrap(() =>
  //       prisma.deck.findFirst({
  //         where: { class: cls, isDefault: true }
  //       })
  //     )
  // )
}
