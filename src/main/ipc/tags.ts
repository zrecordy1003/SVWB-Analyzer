import { ipcMain } from 'electron'
import { PrismaClient, Tag } from '@prisma/client'
import { getPrisma } from '../db/prismaClient.js'

export function registerTagsIpc(): void {
  const prisma: PrismaClient = getPrisma()

  ipcMain.handle('tags:list', async (_e, query?: string): Promise<Tag[]> => {
    const q = (query ?? '').trim()
    return prisma.tag.findMany({
      where: q ? { name: { contains: q } } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100
    })
  })
}
