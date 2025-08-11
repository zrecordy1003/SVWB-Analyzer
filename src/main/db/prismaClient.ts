// src/main/db/prismaClient.ts
import { PrismaClient } from '@prisma/client'
import path from 'path'
import { app } from 'electron'

function getDbUrl(): string {
  // 如果 initDatabase() 已設定，直接用環境變數；否則兜 userData 路徑
  const url = process.env.DATABASE_URL
  if (url) return url
  const dbPath = path.join(app.getPath('userData'), 'db', 'app.db')
  return `file:${dbPath.replace(/\\/g, '/')}`
}

export const prisma = new PrismaClient({
  datasources: { db: { url: getDbUrl() } }
})
