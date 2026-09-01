import { clipboard, ipcMain } from 'electron'
import type { Kysely, Selectable, Transaction } from 'kysely'
import type { ClassName, Deck, DeckCategory, GameMode } from '../../shared/domain.js'
import {
  type Database,
  type DeckRow,
  deckCategoryFromRow,
  deckFromRow,
  getDb,
  newCategoryId,
  nowMs,
  toMs
} from '../data/db/client.js'
import {
  cardKindFromType,
  CLASS_ID_TO_NAME,
  CLASS_NAME_TO_ID,
  DECK_CODE_TTL_MS,
  fingerprintDeck,
  parseDeckInput,
  shareUrlForHash,
  type DeckImportPreview,
  type ParsedDeckInput,
  type StoredDeckCard
} from '../../shared/deckImport.js'
import {
  DEFAULT_PORTAL_LANG,
  fetchDeck,
  publishDeckCode,
  requestDeckHash,
  SvwbApiError,
  type PortalLang
} from '../data/svwbApi.js'
import { broadcast } from '../utils/broadcast.js'
import { RangeKey } from './helper.js'

/* ================================
 * 型別
 * ================================ */

type DeckCreateInput = {
  name: string
  class: ClassName
  categoryId?: string | null
  isDefault?: boolean
}

type DeckUpdateInput = {
  id: number
  name?: string
  categoryId?: string | null
  // 避免語意混亂，不在 update 中改職業；若有需要另開 API。
  isDefault?: boolean
}

type DeckImportCommitInput = {
  preview: DeckImportPreview
  name: string
  categoryId?: string | null
  isDefault?: boolean
  lang?: PortalLang
  /**
   * Set when the user answered a DUPLICATE_CONTENT by choosing to update the
   * deck they already had, instead of saving a second copy of the same 40 cards.
   */
  replaceDeckId?: number | null
}

type DeckSaveLocalInput = {
  /** Set to edit an existing deck in place; omit to create one. */
  deckId?: number | null
  name: string
  classId: number
  battleFormat?: number | null
  categoryId?: string | null
  isDefault?: boolean
  cards: { cardId: number; count: number }[]
}

/**
 * A deck as the list screen wants it.
 *
 * Carries two things the Deck row does not: what the deck is made of, and the
 * banner of the card that best represents it. Both are derived here rather than
 * in the renderer, because both need the card list joined to the card cache and
 * the list screen should not be issuing a query per deck to get them.
 */
type DeckListItem = Deck & {
  /** Banner of the deck's "face" card. See `pickHeroCard`. */
  heroBannerHash: string | null
  /** Null when the deck has no card list at all - distinct from three zeroes. */
  composition: { follower: number; spell: number; amulet: number } | null
}

type DeckCardFacts = {
  deckId: number
  count: number
  type: number | null
  cost: number | null
  rarity: number | null
  bannerHash: string | null
}

/**
 * The card that should represent a deck.
 *
 * Rarest first, then most expensive: legendary if the deck has one, otherwise
 * gold, then silver, then bronze. It walks the whole ladder instead of looking
 * for a legendary and giving up, because "this deck runs no legendaries" is a
 * fact about the deck and not a reason for it to be the one tile in the grid
 * with no picture on it.
 *
 * Ties break on `bannerHash` purely so the choice is stable: two cards of the
 * same rarity and cost are equally good as a face, but picking a different one
 * on each query would make the grid flicker between refreshes.
 */
function pickHeroCard(cards: DeckCardFacts[]): DeckCardFacts | null {
  const withArt = cards.filter((c) => c.bannerHash)
  if (withArt.length === 0) return null

  return withArt.sort(
    (a, b) =>
      (b.rarity ?? 0) - (a.rarity ?? 0) ||
      (b.cost ?? -1) - (a.cost ?? -1) ||
      (a.bannerHash ?? '').localeCompare(b.bannerHash ?? '')
  )[0]
}

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Res<T> = Ok<T> | Err

type Db = Kysely<Database> | Transaction<Database>
type DeckStatsRow = {
  deckId: number
  total: number
  wins: number
  winRate: number
}
type ReferenceDataScope = 'decks' | 'tags' | 'categories' | 'all'

// The 3s stats cache that used to sit here existed to hide the Prisma engine's
// per-call overhead. An in-process better-sqlite3 aggregate over this data size
// is microseconds, so the cache - and the version bookkeeping that kept it
// honest - is gone rather than ported.

/**
 * Surface an SvwbApiError as its bare code.
 *
 * The renderer picks the wording, so what has to survive the boundary is the
 * classification, not an English sentence it would have to pattern-match.
 */
function rethrowAsCode(e: unknown): never {
  if (e instanceof SvwbApiError) throw new Error(e.code)
  throw e
}

function notifyReferenceDataChanged(scope: ReferenceDataScope): void {
  broadcast('reference-data:changed', { scope })
}

/* ================================
 * 小工具：統一錯誤處理 / 資料驗證 / 輔助
 * ================================ */

// 統一 try/catch 包裝，回傳 Res<T>
const wrap = async <T>(fn: () => Promise<T>): Promise<Res<T>> => {
  try {
    const data = await fn()
    return { ok: true, data }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// 把 '' 視為 null（未分類）
const coerceCategoryId = (v?: string | null): string | null => {
  if (v === '' || v == null) return null
  return v
}

// 名稱校驗（後端底線：不可為空；若你想限制長度，調整 MAX_NAME_LEN）
const MAX_NAME_LEN = 64
const assertValidName = (name?: string): string => {
  const n = (name ?? '').trim()
  if (!n) throw new Error('INVALID_INPUT:Name is required')
  if (n.length > MAX_NAME_LEN) throw new Error('INVALID_INPUT:Name too long')
  return n
}

// 分類存在性確認
async function ensureCategoryExists(db: Db, categoryId?: string | null): Promise<void> {
  const cid = coerceCategoryId(categoryId)
  if (!cid) return
  const exists = await db
    .selectFrom('DeckCategory')
    .select('id')
    .where('id', '=', cid)
    .executeTakeFirst()
  if (!exists) throw new Error('NOT_FOUND:Category')
}

// 不分大小寫重名檢查（同職業 + 同分類）
const norm = (s: string): string => s.trim().toLocaleLowerCase()
async function hasNameDuplicateCI(
  db: Db,
  params: { cls: string; categoryId: string | null; name: string; excludeId?: number }
): Promise<boolean> {
  let query = db.selectFrom('Deck').select(['id', 'name']).where('class', '=', params.cls)
  query =
    params.categoryId === null
      ? query.where('categoryId', 'is', null)
      : query.where('categoryId', '=', params.categoryId)
  const rows = await query.execute()
  const target = norm(params.name)
  return rows.some(
    (r) => (params.excludeId ? r.id !== params.excludeId : true) && norm(r.name) === target
  )
}

/**
 * Write a deck row and its card list, creating or replacing.
 *
 * Shared by the import path and the local editor. They differ only in where the
 * cards came from and what provenance is recorded; the invariants - one default
 * per class, the card list replaced rather than merged - are identical, and
 * having them in one place is what keeps them that way.
 */
async function upsertDeckWithCards(
  tx: Transaction<Database>,
  params: {
    replaceDeckId: number | null
    cls: ClassName
    fields: Record<string, unknown>
    isDefault?: boolean
    cards: { cardId: number; count: number }[]
    now: number
  }
): Promise<Selectable<DeckRow>> {
  if (params.isDefault) {
    await tx.updateTable('Deck').set({ isDefault: 0 }).where('class', '=', params.cls).execute()
  }

  let deckRow: Selectable<DeckRow>
  if (params.replaceDeckId !== null) {
    const current = await tx
      .selectFrom('Deck')
      .select('id')
      .where('id', '=', params.replaceDeckId)
      .executeTakeFirst()
    if (!current) throw new Error('NOT_FOUND:Deck')
    deckRow = await tx
      .updateTable('Deck')
      .set(params.fields)
      .where('id', '=', params.replaceDeckId)
      .returningAll()
      .executeTakeFirstOrThrow()
    // Replaced, not merged: two copies of a card the user removed would
    // otherwise survive as a stale row.
    await tx.deleteFrom('DeckCard').where('deckId', '=', params.replaceDeckId).execute()
  } else {
    deckRow = await tx
      .insertInto('Deck')
      .values({ ...params.fields, class: params.cls, createdAt: params.now } as never)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  if (params.cards.length > 0) {
    await tx
      .insertInto('DeckCard')
      .values(params.cards.map((c) => ({ deckId: deckRow.id, cardId: c.cardId, count: c.count })))
      .execute()
  }

  return deckRow
}

/**
 * A deck's card list, joined to whatever card details we hold.
 *
 * A LEFT join, because `Card` is a cache of the portal's data: losing or never
 * having a row must cost the card's details, not the deck's contents. A card
 * with no cached details reads as `#<cardId>` and still counts.
 */
async function readDeckCards(db: Kysely<Database>, deckId: number): Promise<StoredDeckCard[]> {
  const rows = await db
    .selectFrom('DeckCard')
    .leftJoin('Card', 'Card.cardId', 'DeckCard.cardId')
    .select([
      'DeckCard.cardId',
      'DeckCard.count',
      'Card.name',
      'Card.cost',
      'Card.type',
      'Card.rarity',
      'Card.atk',
      'Card.life',
      'Card.skillText',
      'Card.imageHash',
      'Card.bannerHash',
      'Card.isToken'
    ])
    .where('DeckCard.deckId', '=', deckId)
    .execute()

  return rows
    .map((r) => ({
      cardId: r.cardId,
      count: r.count,
      name: r.name ?? `#${r.cardId}`,
      cost: r.cost ?? null,
      type: r.type ?? null,
      kind: cardKindFromType(r.type),
      rarity: r.rarity ?? null,
      atk: r.atk ?? null,
      life: r.life ?? null,
      skillText: r.skillText ?? null,
      imageHash: r.imageHash ?? null,
      bannerHash: r.bannerHash ?? null,
      isToken: r.isToken === 1
    }))
    .sort((a, b) => (a.cost ?? 99) - (b.cost ?? 99) || a.cardId - b.cardId)
}

const toDateSafe = (v: unknown): Date | null => {
  if (v == null) return null
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const d = new Date(Number(v))
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(v as string | Date)
  return isNaN(d.getTime()) ? null : d
}

const computeRange = (p: {
  rangeKey?: RangeKey
  start?: unknown
  end?: unknown
}): {
  start?: Date
  end?: Date
} => {
  const start = toDateSafe(p.start)
  const end = toDateSafe(p.end)
  if (start || end) return { start: start ?? undefined, end: end ?? undefined }

  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now)
  todayEnd.setHours(23, 59, 59, 999)

  if (p.rangeKey === 'today' || !p.rangeKey) return { start: todayStart, end: todayEnd }
  if (p.rangeKey === 'all') return {}

  if (p.rangeKey === '7d') {
    const s7 = new Date(todayStart)
    s7.setDate(s7.getDate() - 6)
    return { start: s7, end: todayEnd }
  }
  if (p.rangeKey === '30d') {
    const s30 = new Date(todayStart)
    s30.setDate(s30.getDate() - 29)
    return { start: s30, end: todayEnd }
  }
  return {}
}

/* ================================
 * IPC
 * ================================ */

export function registerDecksIpc(): void {
  const db = getDb()

  // 取全部分類（穩定排序）
  ipcMain.handle(
    'deckCategories:all',
    async (): Promise<Res<DeckCategory[]>> =>
      wrap(async () => {
        const rows = await db
          .selectFrom('DeckCategory')
          .selectAll()
          .orderBy('sort', 'asc')
          .orderBy('name', 'asc')
          .execute()
        return rows.map(deckCategoryFromRow)
      })
  )

  // 取全部牌組（給前端用的排序；回傳必要欄位）
  ipcMain.handle(
    'decks:all',
    async (): Promise<Res<DeckListItem[]>> =>
      wrap(async () => {
        // The key card's banner comes along for the ride so the deck list can
        // use it as a background. A LEFT join, because the card cache may not
        // hold that card - a deck with no picture still has to list.
        const rows = await db
          .selectFrom('Deck')
          .leftJoin('Card', 'Card.cardId', 'Deck.keyCardId')
          .selectAll('Deck')
          .select('Card.bannerHash as keyCardBannerHash')
          .orderBy('Deck.class', 'asc')
          .orderBy('Deck.isDefault', 'desc')
          .orderBy('Deck.updatedAt', 'desc')
          .orderBy('Deck.name', 'asc')
          .execute()

        // One query for every deck's cards rather than one per deck. A deck is
        // ~16 rows and a collection is tens of decks, so grouping in JS is far
        // cheaper than the round trips a per-deck query would cost.
        const facts = await db
          .selectFrom('DeckCard')
          .leftJoin('Card', 'Card.cardId', 'DeckCard.cardId')
          .select([
            'DeckCard.deckId',
            'DeckCard.count',
            'Card.type',
            'Card.cost',
            'Card.rarity',
            'Card.bannerHash'
          ])
          .execute()

        const byDeck = new Map<number, DeckCardFacts[]>()
        for (const fact of facts) {
          const list = byDeck.get(fact.deckId)
          if (list) list.push(fact)
          else byDeck.set(fact.deckId, [fact])
        }

        return rows.map(({ keyCardBannerHash, ...row }) => {
          const cards = byDeck.get(row.id) ?? []
          const composition = { follower: 0, spell: 0, amulet: 0 }
          for (const card of cards) {
            const kind = cardKindFromType(card.type)
            if (kind) composition[kind] += card.count
          }

          return {
            ...deckFromRow(row),
            // The cover card is the fallback: it is whatever the deck was
            // saved with, which is not necessarily the card that identifies it.
            heroBannerHash: pickHeroCard(cards)?.bannerHash ?? keyCardBannerHash ?? null,
            composition: cards.length > 0 ? composition : null
          }
        })
      })
  )

  // 牌組戰績：依我方牌組統計勝率
  ipcMain.handle(
    'decks:stats',
    async (
      _e,
      params: {
        deckIds?: number[]
        mode?: GameMode | 'all'
        rangeKey?: RangeKey
        start?: string | number | Date | null
        end?: string | number | Date | null
      } = {}
    ): Promise<Res<DeckStatsRow[]>> =>
      wrap(async () => {
        const { start, end } = computeRange(params)

        let query = db
          .selectFrom('Match')
          .select(({ fn, eb }) => [
            'my_deckId',
            fn.countAll<number>().as('total'),
            // SQLite has no FILTER-free conditional count shorter than SUM.
            eb.fn.sum<number>(eb.case().when('result', '=', 1).then(1).else(0).end()).as('wins')
          ])
          .where('my_deckId', 'is not', null)
          .where('result', 'is not', null)
          .groupBy('my_deckId')

        if (params.deckIds?.length) query = query.where('my_deckId', 'in', params.deckIds)
        if (params.mode && params.mode !== 'all') query = query.where('mode', '=', params.mode)
        if (start) query = query.where('playedAt', '>=', toMs(start))
        if (end) query = query.where('playedAt', '<=', toMs(end))

        const grouped = await query.execute()
        return grouped
          .filter((row) => row.my_deckId != null)
          .map((row) => {
            const total = Number(row.total)
            const wins = Number(row.wins ?? 0)
            return {
              deckId: row.my_deckId as number,
              total,
              wins,
              winRate: total > 0 ? +((wins / total) * 100).toFixed(2) : 0
            }
          })
      })
  )

  // 建立分類（如需）
  ipcMain.handle(
    'deckCategories:create',
    async (_e, input: { name: string }): Promise<Res<DeckCategory>> =>
      wrap(async () => {
        const name = assertValidName(input?.name)
        const now = nowMs()
        const row = await db
          .insertInto('DeckCategory')
          .values({ id: newCategoryId(), name, createdAt: now, updatedAt: now })
          .returningAll()
          .executeTakeFirstOrThrow()
        notifyReferenceDataChanged('categories')
        return deckCategoryFromRow(row)
      })
  )

  // 建立牌組：支援 isDefault；若 isDefault=true，單一交易清掉同職業其它預設
  ipcMain.handle(
    'decks:create',
    async (_e, input: DeckCreateInput): Promise<Res<Deck>> =>
      wrap(async () => {
        const name = assertValidName(input?.name)
        if (!input?.class) throw new Error('INVALID_INPUT:Class is required')

        const categoryId = coerceCategoryId(input.categoryId)

        const created = await db.transaction().execute(async (tx) => {
          await ensureCategoryExists(tx, categoryId)

          // 不分大小寫重名檢查（同職業 + 同分類）
          const dup = await hasNameDuplicateCI(tx, {
            cls: input.class,
            categoryId,
            name
          })
          if (dup) throw new Error('DUPLICATE_NAME')

          if (input.isDefault) {
            await tx
              .updateTable('Deck')
              .set({ isDefault: 0 })
              .where('class', '=', input.class)
              .execute()
          }

          const now = nowMs()
          return tx
            .insertInto('Deck')
            .values({
              name,
              class: input.class,
              categoryId,
              isDefault: input.isDefault ? 1 : 0,
              createdAt: now,
              updatedAt: now
            })
            .returningAll()
            .executeTakeFirstOrThrow()
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(created)
      })
  )

  // 更新牌組：名稱/分類/isDefault（同樣維持單一預設的不變量）
  ipcMain.handle(
    'decks:update',
    async (_e, input: DeckUpdateInput): Promise<Res<Deck>> =>
      wrap(async () => {
        const { id } = input
        if (!id) throw new Error('INVALID_INPUT:ID is required')

        const updated = await db.transaction().execute(async (tx) => {
          const current = await tx
            .selectFrom('Deck')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirst()
          if (!current) throw new Error('NOT_FOUND:Deck')

          const data: { name?: string; categoryId?: string | null; isDefault?: number } = {}

          if (typeof input.name === 'string') {
            data.name = assertValidName(input.name)
          }

          if (typeof input.categoryId !== 'undefined') {
            const nextCat = coerceCategoryId(input.categoryId)
            if (nextCat) await ensureCategoryExists(tx, nextCat)
            data.categoryId = nextCat
          }

          // 名稱唯一檢查（以「欲更新後的 class + categoryId + name」為準）
          if (typeof data.name === 'string' || typeof data.categoryId !== 'undefined') {
            const nextCatId =
              typeof data.categoryId !== 'undefined' ? data.categoryId : current.categoryId
            const nextName = typeof data.name === 'string' ? data.name : current.name
            const dup = await hasNameDuplicateCI(tx, {
              cls: current.class,
              categoryId: nextCatId ?? null,
              name: nextName,
              excludeId: id
            })
            if (dup) throw new Error('DUPLICATE_NAME')
          }

          // isDefault 調整（同職業僅能有一個）
          if (typeof input.isDefault === 'boolean') {
            if (input.isDefault) {
              await tx
                .updateTable('Deck')
                .set({ isDefault: 0 })
                .where('class', '=', current.class)
                .execute()
              data.isDefault = 1
            } else {
              data.isDefault = 0
            }
          }

          return tx
            .updateTable('Deck')
            .set({ ...data, updatedAt: nowMs() })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow()
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(updated)
      })
  )

  // 刪除牌組。FK 的 onDelete: SetNull 定義在 schema（001_init.sql），行為不變。
  ipcMain.handle(
    'decks:delete',
    async (_e, { id }: { id: number }): Promise<Res<{ success: true }>> =>
      wrap(async () => {
        const deleted = await db.deleteFrom('Deck').where('id', '=', id).executeTakeFirst()
        if (deleted.numDeletedRows === 0n) throw new Error('NOT_FOUND:Deck')
        notifyReferenceDataChanged('decks')
        return { success: true as const }
      })
  )

  // 設為某職業預設：給某個 deckId 設預設，並清除此職業其他預設
  ipcMain.handle(
    'decks:setDefaultForClass',
    async (_e, { deckId }: { deckId: number }): Promise<Res<Deck>> =>
      wrap(async () => {
        const updated = await db.transaction().execute(async (tx) => {
          const deck = await tx
            .selectFrom('Deck')
            .selectAll()
            .where('id', '=', deckId)
            .executeTakeFirst()
          if (!deck) throw new Error('NOT_FOUND:Deck')
          await tx
            .updateTable('Deck')
            .set({ isDefault: 0 })
            .where('class', '=', deck.class)
            .execute()
          return tx
            .updateTable('Deck')
            .set({ isDefault: 1, updatedAt: nowMs() })
            .where('id', '=', deckId)
            .returningAll()
            .executeTakeFirstOrThrow()
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(updated)
      })
  )

  /* ================================
   * 匯入
   * ================================ */

  // 兩段式：先 preview（不寫 DB），使用者確認並命名後才 commit。
  //
  // 這不只是體驗考量 —— 官方兩支端點都不回傳牌組名稱，名字一定得由使用者給，
  // 所以中間這一步本來就省不掉。
  ipcMain.handle(
    'decks:importPreview',
    async (
      _e,
      input: { text: string; lang?: PortalLang }
    ): Promise<Res<{ preview: DeckImportPreview; duplicateDeckId: number | null }>> =>
      wrap(async () => {
        const parsed: ParsedDeckInput | null = parseDeckInput(input?.text ?? '')
        if (!parsed) throw new Error('INVALID_INPUT:Not a deck code, hash or share link')

        // 把 SvwbApiError 收斂成純代碼字串。渲染層要據此挑文案（尤其是
        // 「代碼無效或已過期」），比對英文訊息比對不出來。
        const preview = await fetchDeck(parsed, {
          lang: input?.lang ?? DEFAULT_PORTAL_LANG
        }).catch((e: unknown) => {
          if (e instanceof SvwbApiError) throw new Error(e.code)
          throw e
        })

        // 先告知重複，但不代替使用者決定要覆蓋還是另存。
        const existing = await db
          .selectFrom('Deck')
          .select('id')
          .where('fingerprint', '=', preview.fingerprint)
          .executeTakeFirst()

        return { preview, duplicateDeckId: existing?.id ?? null }
      })
  )

  /**
   * 剪貼簿裡有沒有一組牌組代碼或分享連結。
   *
   * 讀取發生在 main，而且**只回傳解析後的結果**，不是剪貼簿內容。渲染層永遠
   * 拿不到使用者複製的其他東西 —— 密碼、訊息、任何剛好在剪貼簿裡的內容都不會
   * 越過這條邊界。回傳 null 就是「沒有可用的東西」，連原文長什麼樣都不說。
   *
   * 由開啟對話框這個動作觸發，不是背景輪詢。
   */
  ipcMain.handle(
    'decks:clipboardCandidate',
    async (): Promise<Res<ParsedDeckInput | null>> =>
      wrap(async () => {
        try {
          return parseDeckInput(clipboard.readText())
        } catch {
          // 剪貼簿讀不到不是錯誤，只是沒有建議可以給。
          return null
        }
      })
  )

  // commit 收的是 preview 物件，不是原始字串 —— 短碼在使用者填名字這段期間
  // 很可能已經過期，重抓一次就等於讓匯入隨機失敗。
  ipcMain.handle(
    'decks:import',
    async (_e, input: DeckImportCommitInput): Promise<Res<Deck>> =>
      wrap(async () => {
        const preview = input?.preview
        if (!preview?.cards?.length) throw new Error('INVALID_INPUT:Missing deck preview')
        if (!preview.className) throw new Error('INVALID_INPUT:Unknown class')

        const name = assertValidName(input?.name)
        const cls = preview.className
        const categoryId = coerceCategoryId(input.categoryId)
        const lang = input.lang ?? DEFAULT_PORTAL_LANG

        const saved = await db.transaction().execute(async (tx) => {
          await ensureCategoryExists(tx, categoryId)

          const replaceId = input.replaceDeckId ?? null
          if (replaceId === null) {
            const dupContent = await tx
              .selectFrom('Deck')
              .select('id')
              .where('fingerprint', '=', preview.fingerprint)
              .executeTakeFirst()
            // 帶上 id，讓 UI 能提供「改成更新那一副」而不是只說失敗。
            if (dupContent) throw new Error(`DUPLICATE_CONTENT:${dupContent.id}`)
          }

          const dupName = await hasNameDuplicateCI(tx, {
            cls,
            categoryId,
            name,
            excludeId: replaceId ?? undefined
          })
          if (dupName) throw new Error('DUPLICATE_NAME')

          const now = nowMs()
          const deckFields = {
            name,
            categoryId,
            isDefault: input.isDefault ? 1 : 0,
            sourceKind: preview.source.kind,
            sourceRef: preview.hash,
            fingerprint: preview.fingerprint,
            battleFormat: preview.battleFormat,
            keyCardId: preview.keyCardId,
            importedAt: now,
            rawJson: preview.raw,
            updatedAt: now
          }

          const deckRow = await upsertDeckWithCards(tx, {
            replaceDeckId: replaceId,
            cls,
            fields: deckFields,
            isDefault: input.isDefault,
            cards: preview.cards,
            now
          })

          // 卡片主資料是別人資料的快取，跨牌組共用；重匯時以最新一次為準。
          for (const c of preview.cards) {
            await tx
              .insertInto('Card')
              .values({
                cardId: c.cardId,
                name: c.name,
                cost: c.cost,
                type: c.type,
                // The card's own class, NOT the deck's - a nemesis deck holds
                // neutral cards, and the pool reads this column by class.
                class: c.cardClass,
                rarity: c.rarity,
                atk: c.atk,
                life: c.life,
                skillText: c.skillText,
                tribes: JSON.stringify(c.tribes),
                deckEnabledNum: c.deckEnabledNum,
                imageHash: c.imageHash,
                bannerHash: c.bannerHash,
                isToken: c.isToken ? 1 : 0,
                lang,
                updatedAt: now
              })
              .onConflict((oc) =>
                oc.column('cardId').doUpdateSet((eb) => ({
                  name: eb.ref('excluded.name'),
                  cost: eb.ref('excluded.cost'),
                  type: eb.ref('excluded.type'),
                  class: eb.ref('excluded.class'),
                  rarity: eb.ref('excluded.rarity'),
                  atk: eb.ref('excluded.atk'),
                  life: eb.ref('excluded.life'),
                  skillText: eb.ref('excluded.skillText'),
                  tribes: eb.ref('excluded.tribes'),
                  deckEnabledNum: eb.ref('excluded.deckEnabledNum'),
                  imageHash: eb.ref('excluded.imageHash'),
                  bannerHash: eb.ref('excluded.bannerHash'),
                  isToken: eb.ref('excluded.isToken'),
                  lang: eb.ref('excluded.lang'),
                  updatedAt: eb.ref('excluded.updatedAt')
                }))
              )
              .execute()
          }

          return deckRow
        })

        notifyReferenceDataChanged('decks')
        return deckFromRow(saved)
      })
  )

  // 編輯器存檔。與匯入共用同一條寫入路徑，差別只在來源標記與不需要寫 Card
  // （卡片主資料已經由卡池同步進來了）。
  ipcMain.handle(
    'decks:saveLocal',
    async (_e, input: DeckSaveLocalInput): Promise<Res<Deck>> =>
      wrap(async () => {
        const name = assertValidName(input?.name)
        const cls = CLASS_ID_TO_NAME[Number(input?.classId)]
        if (!cls) throw new Error('INVALID_INPUT:Unknown class')

        const cards = (input?.cards ?? []).filter((c) => c && c.count > 0)
        if (cards.length === 0) throw new Error('INVALID_INPUT:Deck is empty')

        const categoryId = coerceCategoryId(input.categoryId)
        const replaceId = input.deckId ?? null

        const saved = await db.transaction().execute(async (tx) => {
          await ensureCategoryExists(tx, categoryId)

          // Editing cannot change a deck's class.
          //
          // `upsertDeckWithCards` writes `class` on insert only - by design, and
          // for the same reason `decks:update` refuses to touch it: a deck's
          // class is what its recorded matches were played as. Silently keeping
          // the old class while saving another class's cards would produce a row
          // that describes a deck nobody ever played.
          if (replaceId !== null) {
            const current = await tx
              .selectFrom('Deck')
              .select('class')
              .where('id', '=', replaceId)
              .executeTakeFirst()
            if (!current) throw new Error('NOT_FOUND:Deck')
            if (current.class !== cls) throw new Error('INVALID_INPUT:Cannot change deck class')
          }

          const dupName = await hasNameDuplicateCI(tx, {
            cls,
            categoryId,
            name,
            excludeId: replaceId ?? undefined
          })
          if (dupName) throw new Error('DUPLICATE_NAME')

          const now = nowMs()
          return upsertDeckWithCards(tx, {
            replaceDeckId: replaceId,
            cls,
            isDefault: input.isDefault,
            cards,
            now,
            fields: {
              name,
              categoryId,
              isDefault: input.isDefault ? 1 : 0,
              sourceKind: 'local',
              // No hash: this deck has never been to the portal. It gets one
              // only if the user asks for a code, which is stage D.
              sourceRef: null,
              fingerprint: fingerprintDeck(cards),
              battleFormat: input.battleFormat ?? null,
              keyCardId: cards[0]?.cardId ?? null,
              // Not an import, so there is no import time and no raw payload.
              importedAt: null,
              rawJson: null,
              updatedAt: now
            }
          })
        })

        notifyReferenceDataChanged('decks')
        return deckFromRow(saved)
      })
  )

  // 一副牌組的全部資料，給編輯器載入用。
  //
  // 卡表跟著一起回，因為編輯器需要的是「這副牌現在長什麼樣」而不是兩次查詢
  // 拼起來的近似值 —— 中間隔一次 IPC 就有機會拿到不一致的兩半。
  ipcMain.handle(
    'decks:get',
    async (_e, { id }: { id: number }): Promise<Res<{ deck: Deck; cards: StoredDeckCard[] }>> =>
      wrap(async () => {
        const row = await db.selectFrom('Deck').selectAll().where('id', '=', id).executeTakeFirst()
        if (!row) throw new Error('NOT_FOUND:Deck')
        return { deck: deckFromRow(row), cards: await readDeckCards(db, id) }
      })
  )

  /* ================================
   * 回寫遊戲
   * ================================ */

  // 卡表 → 長 hash → 4 碼代碼。使用者在遊戲裡輸入代碼就拿到這副牌。
  //
  // 拿到 hash 之後會寫回 Deck.sourceRef：hash 沒有效期，所以這是這副牌第一次
  // 取得「可以長期保存、可以分享」的身分 —— 尤其是編輯器建的牌組，在此之前
  // 它從來沒去過官方站。
  ipcMain.handle(
    'decks:publishCode',
    async (
      _e,
      input: { deckId: number }
    ): Promise<Res<{ hash: string; deckCode: string; shareUrl: string; ttlMs: number }>> =>
      wrap(async () => {
        const deckId = Number(input?.deckId)
        if (!Number.isInteger(deckId)) throw new Error('INVALID_INPUT:Deck id is required')

        const deck = await db
          .selectFrom('Deck')
          .select(['id', 'class', 'battleFormat', 'keyCardId', 'sourceRef'])
          .where('id', '=', deckId)
          .executeTakeFirst()
        if (!deck) throw new Error('NOT_FOUND:Deck')

        // Ordered so the key-card fallback below is deterministic; without it
        // the same deck could publish under a different cover card each time.
        const cards = await db
          .selectFrom('DeckCard')
          .select(['cardId', 'count'])
          .where('deckId', '=', deckId)
          .orderBy('cardId', 'asc')
          .execute()
        if (cards.length === 0) throw new Error('INVALID_INPUT:Deck has no cards')

        const classId = CLASS_NAME_TO_ID[deck.class as ClassName]
        if (!classId) throw new Error('INVALID_INPUT:Unknown class')

        const lang = DEFAULT_PORTAL_LANG
        const hash = await requestDeckHash(
          {
            classId,
            // Decks that predate the format column, or were created by hand,
            // have none. Unlimited accepts everything, so it is the safe guess.
            battleFormat: deck.battleFormat ?? 2,
            keyCardId: deck.keyCardId ?? cards[0].cardId,
            cards
          },
          { lang }
        ).catch(rethrowAsCode)

        const deckCode = await publishDeckCode(hash, { lang }).catch(rethrowAsCode)

        // Only worth a write when it changed; publishing the same deck twice
        // returns the same hash.
        if (deck.sourceRef !== hash) {
          await db
            .updateTable('Deck')
            .set({ sourceRef: hash, updatedAt: nowMs() })
            .where('id', '=', deckId)
            .execute()
        }

        return { hash, deckCode, shareUrl: shareUrlForHash(hash, lang), ttlMs: DECK_CODE_TTL_MS }
      })
  )

  // 續期。官方頁面每 60 秒重打一次 publish 讓代碼不過期；我們照做，但只在
  // 使用者開著代碼畫面的時候 —— 這是唯一的常態輪詢，關掉畫面就停。
  ipcMain.handle(
    'decks:renewCode',
    async (_e, input: { hash: string }): Promise<Res<{ deckCode: string; ttlMs: number }>> =>
      wrap(async () => {
        const hash = String(input?.hash ?? '')
        if (!hash) throw new Error('INVALID_INPUT:Hash is required')
        const deckCode = await publishDeckCode(hash, { lang: DEFAULT_PORTAL_LANG }).catch(
          rethrowAsCode
        )
        return { deckCode, ttlMs: DECK_CODE_TTL_MS }
      })
  )

  // 讀回某副牌的卡表，給檢視用。Card 是快取，可能缺列 —— 缺的時候降級成
  // 「有這張卡，細節不知道」，而不是讓整個查詢失敗。
  ipcMain.handle(
    'decks:cards',
    async (_e, { deckId }: { deckId: number }): Promise<Res<StoredDeckCard[]>> =>
      wrap(async () => readDeckCards(db, deckId))
  )
}
