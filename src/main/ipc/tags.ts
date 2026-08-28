import { ipcMain } from 'electron'
import { getDb, nowMs, tagFromRow } from '../data/db/client.js'
import { broadcast } from '../utils/broadcast.js'

export function registerTagsIpc(): void {
  const db = getDb()

  ipcMain.handle('tags:list', async () => {
    const rows = await db.selectFrom('Tag').selectAll().orderBy('name', 'asc').execute()
    return rows.map(tagFromRow)
  })

  ipcMain.handle('tags:create', async (_e, name: string) => {
    const n = (name ?? '').trim()
    if (!n) throw new Error('Name required')
    const now = nowMs()
    const row = await db
      .insertInto('Tag')
      .values({ name: n, createdAt: now, updatedAt: now })
      .returningAll()
      .executeTakeFirstOrThrow()
    broadcast('reference-data:changed', { scope: 'tags' })
    return tagFromRow(row)
  })

  ipcMain.handle('tags:update', async (_e, { id, name }: { id: number; name: string }) => {
    const n = (name ?? '').trim()
    if (!id || !n) throw new Error('Invalid params')
    const row = await db
      .updateTable('Tag')
      .set({ name: n, updatedAt: nowMs() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()
    broadcast('reference-data:changed', { scope: 'tags' })
    return tagFromRow(row)
  })

  ipcMain.handle('tags:delete', async (_e, id: number) => {
    if (!id) throw new Error('Invalid id')
    // One transaction, as before: a tag must not vanish while its pivot rows
    // survive, or the match list would show links to nothing.
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('MatchTag').where('tagId', '=', id).execute()
      await tx.deleteFrom('Tag').where('id', '=', id).execute()
    })
    broadcast('reference-data:changed', { scope: 'tags' })
    return { ok: true }
  })
}
