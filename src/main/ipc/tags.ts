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

  ipcMain.handle('tags:create', async (_e, name: string) => {
    return prisma.tag.create({ data: { name } })
  })

  ipcMain.handle('tags:rename', async (_e, id: number, name: string) => {
    return prisma.tag.update({ where: { id }, data: { name } })
  })

  ipcMain.handle('tags:delete', async (_e, id: number) => {
    // 先刪樞紐
    await prisma.matchTag.deleteMany({ where: { tagId: id } })
    await prisma.tag.delete({ where: { id } })
    return true
  })
}
