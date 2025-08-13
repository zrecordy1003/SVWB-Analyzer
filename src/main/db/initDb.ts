/* eslint-disable @typescript-eslint/no-explicit-any */
import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync, unlinkSync } from 'fs'
import { PrismaClient } from '@prisma/client'

function getMigrationsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'migrations')
    : path.join(__dirname, '../../resources/migrations')
}

function getDbDir(): string {
  const dir = path.join(app.getPath('userData'), 'db')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getDbPath(): string {
  return path.join(getDbDir(), 'app.db')
}

function toDbUrl(p: string): string {
  return `file:${p.replace(/\\/g, '/')}`
}

async function ensurePragmas(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRawUnsafe<{ journal_mode: string }[]>(`PRAGMA journal_mode = WAL;`)
  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys = ON;`)
}

async function getAppliedVersions(prisma: PrismaClient): Promise<number[]> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT,
      applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT version FROM schema_migrations ORDER BY version;`
  )
  return rows.map((r) => Number(r.version))
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*[\r\n]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function runOneMigration(
  prisma: PrismaClient,
  version: number,
  name: string,
  sql: string
): Promise<void> {
  const stmts = splitSql(sql)
  await prisma.$transaction(async (tx) => {
    for (const s of stmts) {
      const stmt = s.trim()
      if (/^select\b/i.test(stmt) || /^pragma\s+journal_mode\b/i.test(stmt)) {
        await tx.$queryRawUnsafe(stmt)
      } else {
        await tx.$executeRawUnsafe(stmt)
      }
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO schema_migrations(version, name) VALUES(${version}, ${
        name ? `'${name.replace(/'/g, "''")}'` : 'NULL'
      })`
    )
  })
}

/** 只在需要時備份，並保留最近 5 份 */
function backupDb(dbPath: string): void {
  if (!existsSync(dbPath)) return
  try {
    const size = statSync(dbPath).size
    if (size === 0) return
  } catch (e) {
    console.log('initDb.ts => backupDb: ', e)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = dbPath.replace(/\.db$/i, `.${stamp}.bak.db`)
  copyFileSync(dbPath, bak)

  // 保留最近 5 份
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath).replace(/\.db$/i, '')
  const baks = readdirSync(dir)
    .filter((f) => f.startsWith(base + '.') && f.endsWith('.bak.db'))
    .sort() // 依檔名時間排序
  const excess = baks.length - 5
  for (let i = 0; i < excess; i++) {
    try {
      unlinkSync(path.join(dir, baks[i]))
    } catch (e) {
      console.log('initDb.ts => backupDb: ', e)
    }
  }
}

export async function initDatabase(): Promise<void> {
  // 1) 決定 DB 路徑與 URL，並設到 env（確保之後 import 的 client 也用同一路徑）
  const dbPath = getDbPath()
  const dbUrl = toDbUrl(dbPath)
  process.env.DATABASE_URL = dbUrl

  // 2) 僅在這裡建立「唯一」的 PrismaClient
  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } }
  })

  // 3) 檢查 migrations 檔案
  const dir = getMigrationsDir()
  const files = await fs.readdir(dir)
  const migrations = files
    .filter((f) => /^\d{3}_.+\.sql$/i.test(f))
    .map((f) => ({
      file: f,
      version: parseInt(f.slice(0, 3), 10),
      name: f.replace(/^\d{3}_/, '').replace(/\.sql$/i, '')
    }))
    .sort((a, b) => a.version - b.version)

  // 4) 先連線、設定 PRAGMA（確保 WAL 啟用）
  await ensurePragmas(prisma)

  // 5) 取得已套用版本
  const applied = new Set(await getAppliedVersions(prisma))

  // 6) 只在「有未套用的 migration」時備份
  const hasPending = migrations.some((m) => !applied.has(m.version))
  if (hasPending) backupDb(dbPath)

  // 7) 逐一套用未套用的 migration
  for (const m of migrations) {
    if (applied.has(m.version)) continue
    const sql = await fs.readFile(path.join(dir, m.file), 'utf8')
    await runOneMigration(prisma, m.version, m.name, sql)
  }

  await prisma.$disconnect()
}
