import { PrismaClient } from '@prisma/client'

let _prisma: PrismaClient | null = null

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set. Call initDatabase() first.')
    }
    _prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } }
    })
  }
  return _prisma
}
