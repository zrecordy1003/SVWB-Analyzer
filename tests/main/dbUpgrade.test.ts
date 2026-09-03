/**
 * Upgrading a database that already has someone's history in it.
 *
 * `dbMigration.test.ts` applies every migration to a FRESH file, which is the
 * new-install path. This is the other one, and it is the one that can break
 * every existing user at once: a v1.2.0 install has migrations 001-007, and
 * launching this version runs 008-012 over whatever is already in there.
 * Nothing tested that until now - the failure mode is an app that will not
 * start, for people who were using it happily yesterday.
 *
 * The v1.2.0 schema is not reconstructed by hand. It is the migrations from
 * that tag, read out of git, so this cannot drift from what shipped:
 *
 *     git show v1.2.0:resources/migrations/00N_*.sql
 *
 * Then real rows go in - matches with and without decks, tags and their pivot
 * rows, categories, a default deck - and the SHIPPED engine migrates the file
 * the same way it does on a user's machine. What is asserted is that it
 * succeeds, that the rows are all still there and unchanged, and that the new
 * columns arrived nullable rather than as a `NOT NULL` that a populated table
 * cannot take.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ENGINE_BINARY } from '../../src/shared/engineBinary'

const ROOT = process.cwd()
const ENGINE = path.join(ROOT, 'tools', 'target', 'release', ENGINE_BINARY)
const MIGRATIONS = path.join(ROOT, 'resources', 'migrations')

/** The release this upgrade path starts from. */
const FROM_TAG = 'v1.2.0'

let dir: string
let dbPath: string

/**
 * The engine's bookkeeping table, copied from `apply_migrations`.
 *
 * `CREATE TABLE IF NOT EXISTS`, so the engine is happy to find it already
 * there - which is exactly what a real upgrade looks like.
 */
const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT,
  applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`

/** `007_add_match_list_filter_indexes.sql` -> 7. */
const versionOf = (name: string): number => Number(name.slice(0, name.indexOf('_')))

/**
 * The migration files as they were at `FROM_TAG`, in order.
 *
 * This needs the tag to be IN the checkout, which is not free: actions/checkout
 * fetches one commit and no tags, so the first CI run of this test failed with
 * a bare `fatal: Not a valid object name v1.2.0`. ci.yml's rust job now fetches
 * the tags (shallow) before `pnpm test`.
 *
 * The absence is turned into a message rather than a skip on purpose. A test
 * that quietly passes when it cannot find its input is worse than one that
 * fails, and this is the only check standing between an existing user and an
 * app that will not start.
 */
function migrationsAtTag(): { name: string; sql: string }[] {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${FROM_TAG}^{commit}`], {
      cwd: ROOT,
      stdio: 'ignore'
    })
  } catch {
    throw new Error(
      `${FROM_TAG} is not in this checkout, so the upgrade path cannot be tested ` +
        `against what shipped.\nFetch them: git fetch --depth=1 <remote> ` +
        `"+refs/tags/*:refs/tags/*"  (this clone's remote is not necessarily ` +
        `named origin - CI's is, because actions/checkout creates it)`
    )
  }
  const listing = execFileSync(
    'git',
    ['ls-tree', '--name-only', FROM_TAG, 'resources/migrations/'],
    {
      cwd: ROOT,
      encoding: 'utf8'
    }
  )
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.sql'))
    .sort()
    .map((file) => ({
      name: path.basename(file),
      sql: execFileSync('git', ['show', `${FROM_TAG}:${file}`], { cwd: ROOT, encoding: 'utf8' })
    }))
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svtool-upgrade-'))
  dbPath = path.join(dir, 'app.db')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/**
 * A minute, against vitest's 5s default, and this one IS the machine rather
 * than a smell.
 *
 * Each case applies seven migrations synchronously and then spawns the real
 * `svwb-engine` - twice, in the idempotency case, because running it again is
 * the thing being asserted. Locally that is ~600ms; on a cold CI runner with
 * Defender in the path it went over 5s and the second case failed on time
 * alone, having done nothing wrong.
 *
 * Worth naming the difference from the classIcons flake, which was also "a
 * test that times out" and was NOT this: there the code polled for a promise
 * nobody held, so raising the limit only bought a longer wait for the same
 * race, and the fix was an await seam. Here there is no seam to add - a
 * subprocess takes as long as the host takes - and the limit is what should
 * move. It stays finite so a genuine hang still fails rather than hanging CI.
 */
const SPAWNS_THE_ENGINE = { timeout: 60_000 }

describe(`upgrading from ${FROM_TAG}`, () => {
  it('keeps every row, and adds the new columns as nullable', SPAWNS_THE_ENGINE, () => {
    if (!existsSync(ENGINE)) {
      throw new Error(`svwb-engine is not built at ${ENGINE}\nRun: pnpm engine:build`)
    }

    const old = migrationsAtTag()
    expect(old.length, `no migrations found at ${FROM_TAG}`).toBeGreaterThan(0)

    // ---- build the v1.2.0 database, schema and bookkeeping both
    const db = new SQLite(dbPath)
    db.pragma('journal_mode = WAL')
    // The engine's own bookkeeping shape: keyed on the numeric VERSION, not
    // the filename (`apply_migrations` in tools/engine/src/store.rs). Getting
    // that wrong is how the first run of this test failed - the engine's
    // `SELECT version FROM schema_migrations` found no such column.
    db.exec(SCHEMA_MIGRATIONS_DDL)
    for (const migration of old) {
      db.exec(migration.sql)
      // The engine skips versions it already lists, so a real upgrade starts
      // from a file that claims 001-007 are done. Without this it would re-run
      // them and this would be testing a fresh install.
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
        versionOf(migration.name),
        migration.name
      )
    }

    // ---- and someone's history in it
    const now = Date.now()
    db.prepare(
      `INSERT INTO DeckCategory (id, name, sort, createdAt, updatedAt)
       VALUES ('cat-1', '主力', 0, ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT INTO Deck (id, name, class, createdAt, updatedAt, isDefault, categoryId)
       VALUES (1, '妖精速攻', 'elf', ?, ?, 1, 'cat-1')`
    ).run(now, now)
    db.prepare('INSERT INTO Tag (id, name, createdAt, updatedAt) VALUES (1, ?, ?, ?)').run(
      '練習',
      now,
      now
    )
    const insertMatch = db.prepare(
      `INSERT INTO Match
         (id, result, play_order, my_class, oppo_class, my_deckId, mode, bp, mp, current_cr,
          playedAt, year, month, day, note, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // One with a deck and every number, one with neither - the second is the
    // shape that catches a migration assuming a column is populated.
    insertMatch.run(
      1,
      1,
      'first',
      'elf',
      'dragon',
      1,
      'ranked',
      10,
      24000,
      1400,
      now,
      2026,
      9,
      3,
      '好',
      now
    )
    insertMatch.run(
      2,
      null,
      'second',
      'witch',
      'bishop',
      null,
      null,
      null,
      null,
      null,
      now,
      2026,
      9,
      3,
      null,
      now
    )
    db.prepare('INSERT INTO MatchTag (matchId, tagId) VALUES (1, 1)').run()
    db.close()

    // ---- upgrade it the way the app does
    const out = execFileSync(ENGINE, ['migrate', '--db', dbPath, '--migrations', MIGRATIONS], {
      encoding: 'utf8',
      windowsHide: true
    })
    // Only the new ones ran: 012 - 007 = 5.
    expect(JSON.parse(out.trim())).toEqual({ applied: 5 })

    // ---- and nothing was lost
    const after = new SQLite(dbPath, { readonly: true })
    expect(after.prepare('SELECT COUNT(*) AS n FROM Match').get()).toEqual({ n: 2 })
    expect(after.prepare('SELECT COUNT(*) AS n FROM Deck').get()).toEqual({ n: 1 })
    expect(after.prepare('SELECT COUNT(*) AS n FROM MatchTag').get()).toEqual({ n: 1 })

    const first = after
      .prepare('SELECT result, my_class, oppo_class, my_deckId, bp, note FROM Match WHERE id = 1')
      .get()
    expect(first).toEqual({
      result: 1,
      my_class: 'elf',
      oppo_class: 'dragon',
      my_deckId: 1,
      bp: 10,
      note: '好'
    })

    /**
     * The new columns arrived, and arrived NULL.
     *
     * `source` being null on an old row is load-bearing rather than
     * incidental: `rollup.ts` reads it as the `legacy` tier, meaning
     * "provenance unknown" rather than assuming the engine wrote it. A
     * migration that defaulted it would silently relabel every pre-1.3 match
     * as engine-recorded.
     */
    const provenance = after
      .prepare(
        'SELECT source, observed, edited_fields, mode_confidence, recog_flags FROM Match WHERE id = 1'
      )
      .get() as Record<string, unknown>
    for (const [column, value] of Object.entries(provenance)) {
      expect(value, `${column} should be null on a row that predates it`).toBeNull()
    }

    /**
     * 011 BACKFILLS the family, and that is the important half.
     *
     * `familyId = id` for every existing deck - 011 says so out loud
     * («既有牌組各自成家»), and it has to: `decks:all` derives "the current
     * version of each live family" by grouping on `familyId ?? id`, and the
     * version UI reads it directly. A deck left with a null family would still
     * list today, but the whole versioning model would be resting on a
     * fallback rather than on data.
     *
     * (This case first asserted null, which was my assumption and not the
     * migration's. The migration was right.)
     */
    const deck = after.prepare('SELECT familyId, archivedAt FROM Deck WHERE id = 1').get()
    expect(deck).toEqual({ familyId: 1, archivedAt: null })

    // 009/010/012's tables exist and are empty, which is what a user who has
    // never imported a deck or sent a statistic should have.
    for (const table of ['DeckCard', 'Card', 'CardPool', 'CardPoolSync', 'TelemetryState']) {
      expect(
        after.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
        `${table} should exist and be empty`
      ).toEqual({ n: 0 })
    }
    after.close()
  })

  it('is idempotent: running the upgrade twice changes nothing', SPAWNS_THE_ENGINE, () => {
    const old = migrationsAtTag()
    const db = new SQLite(dbPath)
    db.exec(SCHEMA_MIGRATIONS_DDL)
    for (const migration of old) {
      db.exec(migration.sql)
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
        versionOf(migration.name),
        migration.name
      )
    }
    db.close()

    const args = ['migrate', '--db', dbPath, '--migrations', MIGRATIONS]
    expect(JSON.parse(execFileSync(ENGINE, args, { encoding: 'utf8' }).trim())).toEqual({
      applied: 5
    })
    // Which is what a second launch does, and what a crash mid-upgrade leaves
    // behind for the next one.
    expect(JSON.parse(execFileSync(ENGINE, args, { encoding: 'utf8' }).trim())).toEqual({
      applied: 0
    })
  })
})
