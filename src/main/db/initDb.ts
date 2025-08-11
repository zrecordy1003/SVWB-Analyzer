/* eslint-disable @typescript-eslint/no-explicit-any */
import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { PrismaClient } from '@prisma/client'

function getMigrationsDir(): string {
  // packaged：process.resourcesPath/migrations
  // dev：對應你的專案結構調整
  return app.isPackaged
    ? path.join(process.resourcesPath, 'migrations')
    : path.join(__dirname, '../../../resources/migrations')
}

function getDbPath(): string {
  const dbDir = path.join(app.getPath('userData'), 'db')
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })
  return path.join(dbDir, 'app.db')
}

function toDbUrl(p: string): string {
  // Prisma SQLite URL 需 "file:" 前綴；Windows 路徑用 / 分隔
  return `file:${p.replace(/\\/g, '/')}`
}

async function ensurePragmas(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL;')
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;')
}

function backupDbIfExists(dbPath: string): void {
  if (!existsSync(dbPath)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = dbPath.replace(/\.db$/i, `.${stamp}.bak.db`)
  copyFileSync(dbPath, bak)
}

async function getAppliedVersions(prisma: PrismaClient): Promise<number[]> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT,
      applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`)
  // 用 raw 查詢（Prisma 不支援 schema_migrations 的 model 也沒關係）
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT version FROM schema_migrations ORDER BY version;`
  )
  return rows.map((r) => Number(r.version))
}

// 簡單的 SQL 分段器：以分號結尾切分，多行註解不支援複雜情境（可自行加強）
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
      await tx.$executeRawUnsafe(s)
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO schema_migrations(version, name) VALUES(${version}, ${name ? `'${name.replace(/'/g, "''")}'` : 'NULL'})`
    )
  })
}

export async function initDatabase(): Promise<void> {
  const dbPath = getDbPath()
  const dbUrl = toDbUrl(dbPath)

  // 讓 Prisma 指到 userData 的 DB
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })

  // 第一次裝 & 之後每次啟動都跑（有新遷移檔就會套用）
  if (!existsSync(dbPath)) {
    // 初次安裝也先產生空檔，確保有 DB
    await fs.writeFile(dbPath, '')
  } else {
    backupDbIfExists(dbPath)
  }

  await ensurePragmas(prisma)

  const applied = new Set(await getAppliedVersions(prisma))
  const dir = getMigrationsDir()
  const files = await fs.readdir(dir)
  // 像 001_init.sql 這種命名
  const migrations = files
    .filter((f) => /^\d{3}_.+\.sql$/i.test(f))
    .map((f) => ({
      file: f,
      version: parseInt(f.slice(0, 3), 10),
      name: f.replace(/^\d{3}_/, '').replace(/\.sql$/i, '')
    }))
    .sort((a, b) => a.version - b.version)

  for (const m of migrations) {
    if (applied.has(m.version)) continue
    const sql = await fs.readFile(path.join(dir, m.file), 'utf8')
    await runOneMigration(prisma, m.version, m.name, sql)
  }

  await prisma.$disconnect()

  // 把 URL 放到環境變數（如果你其他地方要用）
  process.env.DATABASE_URL = dbUrl
}
