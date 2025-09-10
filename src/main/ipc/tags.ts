import { ipcMain } from 'electron'
import { PrismaClient } from '@prisma/client'
import { getPrisma } from '../db/prismaClient.js'

export function registerTagsIpc(): void {
  const prisma: PrismaClient = getPrisma()

  ipcMain.handle('tags:list', async () => prisma.tag.findMany({ orderBy: { name: 'asc' } }))

  ipcMain.handle('tags:create', async (_e, name: string) => {
    const n = (name ?? '').trim()
    if (!n) throw new Error('Name required')
    return prisma.tag.create({ data: { name: n } })
  })

  ipcMain.handle('tags:update', async (_e, { id, name }: { id: number; name: string }) => {
    const n = (name ?? '').trim()
    if (!id || !n) throw new Error('Invalid params')
    return prisma.tag.update({ where: { id }, data: { name: n } })
  })

  ipcMain.handle('tags:delete', async (_e, id: number) => {
    if (!id) throw new Error('Invalid id')
    await prisma.$transaction([
      prisma.matchTag.deleteMany({ where: { tagId: id } }),
      prisma.tag.delete({ where: { id } })
    ])
    return { ok: true }
  })
}
