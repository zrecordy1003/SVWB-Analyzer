import { ipcMain } from 'electron'
import { PrismaClient, Deck } from '@prisma/client'
import { getPrisma } from '../db/prismaClient.js'

export function registerDecksIpc(): void {
  const prisma: PrismaClient = getPrisma()

  // 列出所有牌組（可視需求過濾 class）
  ipcMain.handle('decks:list', async (): Promise<Deck[]> => {
    return prisma.deck.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
  })

  // 建立新牌組（可帶分類）
  ipcMain.handle(
    'decks:create',
    async (
      _e,
      payload: { name: string; class: string; categoryId?: string | null }
    ): Promise<Deck> => {
      const name = (payload.name ?? '').trim()
      if (!name) throw new Error('Deck name is required')
      return prisma.deck.create({
        data: {
          name,
          class: payload.class,
          categoryId: payload.categoryId ?? null
        }
      })
    }
  )
}
