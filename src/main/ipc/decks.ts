/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipcMain } from 'electron'
import { PrismaClient } from '@prisma/client'
import { getPrisma } from '../db/prismaClient.js'

export function registerDecksIpc(): void {
  const prisma: PrismaClient = getPrisma()

  ipcMain.handle('decks:list', async () => {
    try {
      const [categories, decks] = await Promise.all([
        prisma.deckCategory.findMany({ orderBy: { createdAt: 'asc' } }),
        prisma.deck.findMany({ orderBy: { createdAt: 'desc' } })
      ])
      return { categories, decks }
    } catch (err) {
      return { error: err ?? 'Failed to list decks' } // 統一回傳錯誤物件
    }
  })

  ipcMain.handle(
    'decks:create',
    async (_e, input: { name: string; classId: string; categoryId?: string | null }) => {
      try {
        if (input.categoryId) {
          const exists = await prisma.deckCategory.findUnique({ where: { id: input.categoryId } })
          if (!exists) return { error: 'Category not found' }
        }
        const created = await prisma.deck.create({
          data: {
            name: input.name,
            class: input.classId, // ⚠️ 存到欄位 class
            categoryId: input.categoryId ?? null
          }
        })
        return created
      } catch (err) {
        return { error: err ?? 'Failed to create deck' }
      }
    }
  )

  // 建立分類（如果前端要有 UI）
  ipcMain.handle('deckCategories:create', async (_e, input: { name: string }) => {
    const created = await prisma.deckCategory.create({
      data: { name: input.name }
    })
    return created
  })

  ipcMain.handle(
    'decks:update',
    async (
      _e,
      input: {
        id: number
        name?: string
        categoryId?: string | null
        classId?: string // 可選
      }
    ) => {
      try {
        const data: any = {}
        if (typeof input.name === 'string') data.name = input.name
        if (typeof input.categoryId !== 'undefined') {
          if (input.categoryId) {
            const exists = await prisma.deckCategory.findUnique({ where: { id: input.categoryId } })
            if (!exists) return { error: 'Category not found' }
            data.categoryId = input.categoryId
          } else {
            data.categoryId = null
          }
        }
        if (typeof input.classId === 'string') {
          data.class = input.classId
        }

        const updated = await prisma.deck.update({
          where: { id: input.id },
          data
        })
        return updated
      } catch (err: any) {
        return { error: err?.message ?? 'Failed to update deck' }
      }
    }
  )

  ipcMain.handle('decks:delete', async (_e, { id }) => {
    try {
      await prisma.deck.delete({ where: { id } })
      return { success: true }
    } catch (err: any) {
      return { error: err.message }
    }
  })
}
