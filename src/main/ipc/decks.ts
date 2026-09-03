import { clipboard } from 'electron'
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
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
import { handleIpc } from './typed.js'
import { wrapRes as wrap, type Res } from '../../shared/ipc.js'
import type {
  DeckCreateInput,
  DeckImportCommitInput,
  DeckListItem,
  DeckSaveLocalInput,
  DeckStatsRow,
  DeckUpdateInput
} from '../../shared/decks.js'
import { RangeKey } from './helper.js'

/* ================================
 * 型別
 * ================================ */

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

type Db = Kysely<Database> | Transaction<Database>
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

// 不分大小寫重名檢查（同職業 + 同分類）。同家族不算重名：fork 出的版本沿用
// 名稱是設計要求（名稱是「這副牌」的屬性），不是撞名。
const norm = (s: string): string => s.trim().toLocaleLowerCase()
async function hasNameDuplicateCI(
  db: Db,
  params: {
    cls: string
    categoryId: string | null
    name: string
    excludeId?: number
    excludeFamilyId?: number
  }
): Promise<boolean> {
  let query = db
    .selectFrom('Deck')
    .select(['id', 'name', 'familyId'])
    .where('class', '=', params.cls)
  query =
    params.categoryId === null
      ? query.where('categoryId', 'is', null)
      : query.where('categoryId', '=', params.categoryId)
  const rows = await query.execute()
  const target = norm(params.name)
  return rows.some((r) => {
    if (params.excludeId && r.id === params.excludeId) return false
    if (params.excludeFamilyId != null && (r.familyId ?? r.id) === params.excludeFamilyId) {
      return false
    }
    return norm(r.name) === target
  })
}

/**
 * Has any match ever been played with (or against) this deck row?
 *
 * This is the freeze line of plan rule 3.1: a referenced row's card list is
 * history and never changes again. The check MUST run inside the same
 * transaction as the write that depends on it - the Rust engine inserts
 * matches from another process exactly while the user is editing decks, and a
 * check-then-write gap would let a match slip in between and have its card
 * list rewritten under it.
 */
async function isDeckReferenced(db: Db, deckId: number): Promise<boolean> {
  const row = await db
    .selectFrom('Match')
    .select('id')
    .where((eb) => eb.or([eb('my_deckId', '=', deckId), eb('oppo_deckId', '=', deckId)]))
    .limit(1)
    .executeTakeFirst()
  return !!row
}

/**
 * The family's current version: the highest UNARCHIVED id, falling back to the
 * highest id when the whole family is archived. Ordered by id, not createdAt -
 * createdAt mixes integer and text storage in historical databases and sorts
 * wrong silently, while AUTOINCREMENT ids are monotonic with no ties.
 */
async function familyRepresentativeId(db: Db, familyId: number): Promise<number | null> {
  const rows = await db
    .selectFrom('Deck')
    .select(['id', 'archivedAt'])
    .where((eb) => eb.or([eb('familyId', '=', familyId), eb('id', '=', familyId)]))
    .orderBy('id', 'desc')
    .execute()
  if (rows.length === 0) return null
  return rows.find((r) => r.archivedAt === null)?.id ?? rows[0].id
}

/** Every version row of a family, oldest first. Ordered by id, never createdAt (plan 3.4). */
async function familyVersionRows(
  db: Db,
  familyId: number
): Promise<{ id: number; archivedAt: number | null; isDefault: number }[]> {
  return db
    .selectFrom('Deck')
    .select(['id', 'archivedAt', 'isDefault'])
    .where((eb) => eb.or([eb('familyId', '=', familyId), eb('id', '=', familyId)]))
    .orderBy('id', 'asc')
    .execute()
}

/**
 * Retire deck rows by the rule of plan 3.3, one row at a time: a row no match
 * references is hard-deleted (the FK takes its DeckCard rows with it - there is
 * nothing to protect); a row some match references is archived, because in
 * this model that row IS the card list those matches were played with.
 *
 * Archiving clears `isDefault`. The engine assigns new matches with
 * `SELECT id FROM Deck WHERE class = ? AND isDefault = 1`, so an archived row
 * still holding it would keep collecting games under a "deleted" deck.
 *
 * The reference check runs inside the caller's transaction: the engine inserts
 * matches from another process, and a deck it just recorded a game on must
 * archive, not vanish.
 */
async function retireDeckRows(
  tx: Transaction<Database>,
  ids: number[],
  now: number
): Promise<{ deleted: number; archived: number }> {
  let deleted = 0
  let archived = 0
  for (const id of ids) {
    if (await isDeckReferenced(tx, id)) {
      await tx
        .updateTable('Deck')
        .set({ archivedAt: now, isDefault: 0, updatedAt: now })
        .where('id', '=', id)
        .execute()
      archived++
    } else {
      await tx.deleteFrom('Deck').where('id', '=', id).execute()
      deleted++
    }
  }
  return { deleted, archived }
}

/** How many matches reference any of these rows, on either side. */
async function countMatchesReferencing(db: Db, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const counted = await db
    .selectFrom('Match')
    .select(({ fn }) => fn.countAll<number>().as('total'))
    .where((eb) => eb.or([eb('my_deckId', 'in', ids), eb('oppo_deckId', 'in', ids)]))
    .executeTakeFirst()
  return Number(counted?.total ?? 0)
}

/**
 * Push name / categoryId onto every version of a family.
 *
 * Names and categories belong to "this deck", not to "this version" (plan rule
 * 3.1): leaving old versions behind under an old name would split one deck's
 * history across two names, and across two category groups in every list.
 */
async function applyFamilyMutables(
  tx: Transaction<Database>,
  params: { familyId: number; name?: string; categoryId?: string | null; now: number }
): Promise<void> {
  const data: { name?: string; categoryId?: string | null; updatedAt: number } = {
    updatedAt: params.now
  }
  if (typeof params.name === 'string') data.name = params.name
  if (params.categoryId !== undefined) data.categoryId = params.categoryId
  if (data.name === undefined && data.categoryId === undefined) return
  await tx
    .updateTable('Deck')
    .set(data)
    .where((eb) => eb.or([eb('familyId', '=', params.familyId), eb('id', '=', params.familyId)]))
    .execute()
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
    /**
     * The row's other columns. MUST NOT contain `isDefault` - see below.
     */
    fields: Record<string, unknown>
    /**
     * "Make this the default for its class."
     *
     * This flag is the ONLY input for that column, and it is deliberately
     * one-way: true sets it, absent leaves whatever the row already had.
     * Clearing a default is `decks:update`'s job, not a side effect of saving
     * a card list.
     *
     * It used to arrive twice - here as the intent, and again inside `fields`
     * as a value the callers built with `input.isDefault ? 1 : 0`. A save that
     * simply did not mention the flag - which is every save the deck editor
     * makes - therefore wrote a hard 0 over it, and editing your default deck
     * quietly stopped it being the default. One input, derived per branch.
     */
    isDefault?: boolean
    cards: { cardId: number; count: number }[]
    now: number
    /**
     * How to treat a replace target that matches already reference. 'fork'
     * (the default) creates a new version and leaves the old row untouched;
     * 'inPlace' is the explicit correction mode of plan rule 3.2 and rewrites
     * the frozen row the way every save used to.
     */
    mode?: 'fork' | 'inPlace'
  }
): Promise<Selectable<DeckRow>> {
  if (params.isDefault) {
    await tx.updateTable('Deck').set({ isDefault: 0 }).where('class', '=', params.cls).execute()
  }

  const writeCards = async (deckId: number): Promise<void> => {
    if (params.cards.length === 0) return
    await tx
      .insertInto('DeckCard')
      .values(params.cards.map((c) => ({ deckId, cardId: c.cardId, count: c.count })))
      .execute()
  }

  // ---- create: a brand-new deck founds its own family --------------------
  if (params.replaceDeckId === null) {
    const inserted = await tx
      .insertInto('Deck')
      .values({
        ...params.fields,
        class: params.cls,
        createdAt: params.now,
        isDefault: params.isDefault ? 1 : 0
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow()
    // AUTOINCREMENT means the row cannot know its own id before insert, so
    // familyId = id is a backfill in the same transaction, never a guess.
    await tx
      .updateTable('Deck')
      .set({ familyId: inserted.id })
      .where('id', '=', inserted.id)
      .where('familyId', 'is', null)
      .execute()
    await writeCards(inserted.id)
    return { ...inserted, familyId: inserted.familyId ?? inserted.id }
  }

  // ---- replace: freeze check inside THIS transaction ---------------------
  const current = await tx
    .selectFrom('Deck')
    .selectAll()
    .where('id', '=', params.replaceDeckId)
    .executeTakeFirst()
  if (!current) throw new Error('NOT_FOUND:Deck')

  const familyId = current.familyId ?? current.id
  const referenced = await isDeckReferenced(tx, current.id)

  if (!referenced || params.mode === 'inPlace') {
    // Nothing points at this card list (or the caller explicitly asked for a
    // correction), so overwriting it destroys no history.
    const deckRow = await tx
      .updateTable('Deck')
      .set(params.isDefault ? { ...params.fields, isDefault: 1 } : params.fields)
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    // Replaced, not merged: two copies of a card the user removed would
    // otherwise survive as a stale row.
    await tx.deleteFrom('DeckCard').where('deckId', '=', current.id).execute()
    await writeCards(current.id)
    // Name and category belong to the family, not the row (plan rule 3.1).
    await applyFamilyMutables(tx, {
      familyId,
      name: typeof params.fields.name === 'string' ? params.fields.name : undefined,
      categoryId:
        'categoryId' in params.fields
          ? ((params.fields.categoryId ?? null) as string | null)
          : undefined,
      now: params.now
    })
    return deckRow
  }

  // The row is frozen. Same fingerprint means the card list did not actually
  // change - saving a deck you only looked at, or re-importing the same 40
  // cards - and a fork here would mint an identical fake version. Update the
  // mutable fields and stop.
  const newFingerprint =
    typeof params.fields.fingerprint === 'string' ? params.fields.fingerprint : null
  if (newFingerprint !== null && newFingerprint === current.fingerprint) {
    const mutable: Record<string, unknown> = { updatedAt: params.now }
    if (params.isDefault) mutable.isDefault = 1
    await tx.updateTable('Deck').set(mutable).where('id', '=', current.id).execute()
    await applyFamilyMutables(tx, {
      familyId,
      name: typeof params.fields.name === 'string' ? params.fields.name : undefined,
      categoryId:
        'categoryId' in params.fields
          ? ((params.fields.categoryId ?? null) as string | null)
          : undefined,
      now: params.now
    })
    return tx.selectFrom('Deck').selectAll().where('id', '=', current.id).executeTakeFirstOrThrow()
  }

  // ---- fork: a new version row; the old card list and its matches stay ----
  //
  // isDefault travels to the new version. The engine assigns new matches via
  // `SELECT id FROM Deck WHERE class = ? AND isDefault = 1`, and the user's
  // mental model is "I changed my deck", so new games belong to the new list.
  const wasDefault = current.isDefault === 1
  const makeDefault = Boolean(params.isDefault) || wasDefault
  if (wasDefault) {
    await tx.updateTable('Deck').set({ isDefault: 0 }).where('id', '=', current.id).execute()
  }

  const forked = await tx
    .insertInto('Deck')
    .values({
      ...params.fields,
      class: current.class,
      createdAt: params.now,
      familyId,
      isDefault: makeDefault ? 1 : 0
    } as never)
    .returningAll()
    .executeTakeFirstOrThrow()
  await writeCards(forked.id)
  await applyFamilyMutables(tx, {
    familyId,
    name: typeof params.fields.name === 'string' ? params.fields.name : undefined,
    categoryId:
      'categoryId' in params.fields
        ? ((params.fields.categoryId ?? null) as string | null)
        : undefined,
    now: params.now
  })
  return forked
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
  handleIpc(
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
  //
  // 預設只回每個家族的「當前版本」（未封存中 id 最大的那一列），並且整個家族都
  // 封存的不回。這是階段 1「畫面跟今天一樣」的關鍵：fork 出來的舊版本不會在清單
  // 裡冒出一堆同名項目。對局卡片上的牌組名稱不受影響——那是 matches IPC 端用
  // deckId 直接查列，任何版本、封存與否都查得到。
  // 要看全部版本（階段 2 的版本 UI、測試）就帶 scope: 'all'。
  handleIpc(
    'decks:all',
    async (_e, params: { scope?: 'current' | 'all' } = {}): Promise<Res<DeckListItem[]>> =>
      wrap(async () => {
        // The key card's banner comes along for the ride so the deck list can
        // use it as a background. A LEFT join, because the card cache may not
        // hold that card - a deck with no picture still has to list.
        const allRows = await db
          .selectFrom('Deck')
          .leftJoin('Card', 'Card.cardId', 'Deck.keyCardId')
          .selectAll('Deck')
          .select('Card.bannerHash as keyCardBannerHash')
          .orderBy('Deck.class', 'asc')
          .orderBy('Deck.isDefault', 'desc')
          .orderBy('Deck.updatedAt', 'desc')
          .orderBy('Deck.name', 'asc')
          .execute()

        let rows = allRows
        if (params?.scope !== 'all') {
          // Current version = highest unarchived id per family, derived rather
          // than stored (plan 3.4). Ordering by id, never createdAt: mixed
          // integer/text storage makes createdAt sort wrong silently.
          const currentByFamily = new Map<number, number>()
          for (const row of allRows) {
            if (row.archivedAt !== null) continue
            const fam = row.familyId ?? row.id
            const best = currentByFamily.get(fam)
            if (best === undefined || row.id > best) currentByFamily.set(fam, row.id)
          }
          rows = allRows.filter((row) => currentByFamily.get(row.familyId ?? row.id) === row.id)
        }

        // One query for the cards of the decks being RETURNED, rather than one
        // per deck - and rather than the whole table, which is what this used
        // to read.
        //
        // Grouping in JS still beats a query per deck: a deck is ~16 rows and a
        // collection is tens of decks. What changed is the denominator.
        // Versioning forks a new Deck row plus its ~40 DeckCard rows on every
        // edit of a played deck, and archived versions are never removed, so
        // "every DeckCard row" grows without bound while the answer only ever
        // needs the current versions. On the default scope that is a small
        // fraction of the table, and the cost of this handler stops tracking
        // how long the user has owned the app.
        //
        // Ordering matters: `rows` is the post-scope-filter set, so this read
        // has to come after that filter rather than beside `allRows`.
        const deckIds = rows.map((row) => row.id)
        const facts = deckIds.length
          ? await db
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
              .where('DeckCard.deckId', 'in', deckIds)
              .execute()
          : []

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

  // 牌組戰績：依我方牌組統計勝率。
  //
  // groupBy 'family'（預設）把一副牌歷代版本的戰績合在一起，回傳列的 deckId 是
  // 該家族當前版本的 id——所以在 fork 從未發生過的資料庫上，輸出跟舊版逐 deckId
  // 分組完全相同（相容性保證：使用者看到的數字不變）。groupBy 'deck' 才把版本
  // 各自分開。封存的牌組照算：封存是「離開挑選清單」，不是「離開歷史」。
  handleIpc(
    'decks:stats',
    async (
      _e,
      params: {
        deckIds?: number[]
        mode?: GameMode | 'all'
        rangeKey?: RangeKey
        start?: string | number | Date | null
        end?: string | number | Date | null
        groupBy?: 'family' | 'deck'
      } = {}
    ): Promise<Res<DeckStatsRow[]>> =>
      wrap(async () => {
        const { start, end } = computeRange(params)
        const groupBy = params.groupBy ?? 'family'
        const famExpr = sql<number>`coalesce("Deck"."familyId", "Deck"."id")`

        let query = db
          .selectFrom('Match')
          .innerJoin('Deck', 'Deck.id', 'Match.my_deckId')
          .select(({ fn, eb }) => [
            sql<number | null>`"Match"."my_deckId"`.as('my_deckId'),
            famExpr.as('familyId'),
            fn.countAll<number>().as('total'),
            // SQLite has no FILTER-free conditional count shorter than SUM.
            eb.fn
              .sum<number>(eb.case().when('Match.result', '=', 1).then(1).else(0).end())
              .as('wins'),
            // 先後攻各自的場數與勝場。分開算而不是回傳一個先攻勝率：一副只先攻
            // 過兩場的牌組，那個 50% 和三十場的 50% 不是同一件事，而畫面要能把
            // 這件事說出來就得拿得到分母。
            eb.fn
              .sum<number>(eb.case().when('Match.play_order', '=', 'first').then(1).else(0).end())
              .as('firstTotal'),
            eb.fn
              .sum<number>(
                eb
                  .case()
                  .when(eb.and([eb('Match.play_order', '=', 'first'), eb('Match.result', '=', 1)]))
                  .then(1)
                  .else(0)
                  .end()
              )
              .as('firstWins'),
            eb.fn
              .sum<number>(eb.case().when('Match.play_order', '=', 'second').then(1).else(0).end())
              .as('secondTotal'),
            eb.fn
              .sum<number>(
                eb
                  .case()
                  .when(eb.and([eb('Match.play_order', '=', 'second'), eb('Match.result', '=', 1)]))
                  .then(1)
                  .else(0)
                  .end()
              )
              .as('secondWins'),
            fn.min<number | null>('Match.playedAt').as('firstPlayedAt'),
            fn.max<number | null>('Match.playedAt').as('lastPlayedAt')
          ])
          .where('Match.my_deckId', 'is not', null)
          .where('Match.result', 'is not', null)

        query = groupBy === 'family' ? query.groupBy(famExpr) : query.groupBy('Match.my_deckId')

        if (params.deckIds?.length) {
          if (groupBy === 'family') {
            // "These decks" means "these decks' families": a filter pinned to
            // the current version id must keep counting the games played on
            // the versions before it.
            const famRows = await db
              .selectFrom('Deck')
              .select(['id', 'familyId'])
              .where('id', 'in', params.deckIds)
              .execute()
            const fams = [...new Set(famRows.map((r) => r.familyId ?? r.id))]
            query = fams.length
              ? query.where(famExpr, 'in', fams)
              : query.where('Match.my_deckId', 'in', params.deckIds)
          } else {
            query = query.where('Match.my_deckId', 'in', params.deckIds)
          }
        }
        if (params.mode && params.mode !== 'all')
          query = query.where('Match.mode', '=', params.mode)
        if (start) query = query.where('Match.playedAt', '>=', toMs(start))
        if (end) query = query.where('Match.playedAt', '<=', toMs(end))

        const grouped = await query.execute()

        // Family -> current version id, so the renderer's existing
        // deckId-keyed lookup lands on the row it is already displaying.
        const deckRows = await db
          .selectFrom('Deck')
          .select(['id', 'familyId', 'archivedAt'])
          .execute()
        const repByFamily = new Map<number, number>()
        for (const row of deckRows) {
          const fam = row.familyId ?? row.id
          const existing = repByFamily.get(fam)
          const existingRow = deckRows.find((r) => r.id === existing)
          if (existing === undefined) {
            repByFamily.set(fam, row.id)
            continue
          }
          const rowLive = row.archivedAt === null
          const existingLive = existingRow ? existingRow.archivedAt === null : false
          if ((rowLive && !existingLive) || (rowLive === existingLive && row.id > existing)) {
            repByFamily.set(fam, row.id)
          }
        }

        const toStatsRow = (row: {
          my_deckId: number | null
          familyId: number | null
          total: number
          wins: number
          firstTotal: number
          firstWins: number
          secondTotal: number
          secondWins: number
          firstPlayedAt: number | null
          lastPlayedAt: number | null
        }): DeckStatsRow => {
          const total = Number(row.total)
          const wins = Number(row.wins ?? 0)
          const familyId = row.familyId ?? row.my_deckId
          return {
            deckId:
              groupBy === 'family'
                ? (repByFamily.get(familyId as number) ?? (row.my_deckId as number))
                : (row.my_deckId as number),
            familyId,
            total,
            wins,
            winRate: total > 0 ? +((wins / total) * 100).toFixed(2) : 0,
            first: { total: Number(row.firstTotal ?? 0), wins: Number(row.firstWins ?? 0) },
            second: { total: Number(row.secondTotal ?? 0), wins: Number(row.secondWins ?? 0) },
            firstPlayedAt: row.firstPlayedAt == null ? null : Number(row.firstPlayedAt),
            lastPlayedAt: row.lastPlayedAt == null ? null : Number(row.lastPlayedAt)
          }
        }
        const out = grouped.filter((row) => row.my_deckId != null).map(toStatsRow)

        // The catch-all row for matches with no deck assigned. Without it the
        // per-deck rows can never add up to the total match count and the
        // screen has no line saying where the difference went. Skipped when
        // the caller filtered to specific decks - "no deck" is not one of them.
        if (!params.deckIds?.length) {
          let unassigned = db
            .selectFrom('Match')
            .select(({ fn, eb }) => [
              fn.countAll<number>().as('total'),
              eb.fn.sum<number>(eb.case().when('result', '=', 1).then(1).else(0).end()).as('wins')
            ])
            .where('my_deckId', 'is', null)
            .where('result', 'is not', null)
          if (params.mode && params.mode !== 'all') {
            unassigned = unassigned.where('mode', '=', params.mode)
          }
          if (start) unassigned = unassigned.where('playedAt', '>=', toMs(start))
          if (end) unassigned = unassigned.where('playedAt', '<=', toMs(end))
          const u = await unassigned.executeTakeFirst()
          const total = Number(u?.total ?? 0)
          if (total > 0) {
            const wins = Number(u?.wins ?? 0)
            out.push({
              deckId: null,
              familyId: null,
              total,
              wins,
              winRate: total > 0 ? +((wins / total) * 100).toFixed(2) : 0,
              // 這一列是「沒有指定牌組」的合計，沒有牌組就沒有牌組的先後攻表現。
              first: { total: 0, wins: 0 },
              second: { total: 0, wins: 0 },
              // 沒有牌組就沒有「版本的期間」可畫；這一列不上時間線。
              firstPlayedAt: null,
              lastPlayedAt: null
            })
          }
        }

        return out
      })
  )

  // 建立分類（如需）
  handleIpc(
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
  handleIpc(
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
          const inserted = await tx
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
          // A new deck founds its own family. AUTOINCREMENT means the id is
          // unknowable before insert, so this is a backfill in the same
          // transaction - familyId must never be NULL after migration 011.
          await tx
            .updateTable('Deck')
            .set({ familyId: inserted.id })
            .where('id', '=', inserted.id)
            .where('familyId', 'is', null)
            .execute()
          return { ...inserted, familyId: inserted.familyId ?? inserted.id }
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(created)
      })
  )

  // 更新牌組：名稱/分類/isDefault（同樣維持單一預設的不變量）
  handleIpc(
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

          const familyId = current.familyId ?? current.id

          // 名稱唯一檢查（以「欲更新後的 class + categoryId + name」為準）。
          // 同家族的其他版本本來就同名，不算撞名。
          if (typeof data.name === 'string' || typeof data.categoryId !== 'undefined') {
            const nextCatId =
              typeof data.categoryId !== 'undefined' ? data.categoryId : current.categoryId
            const nextName = typeof data.name === 'string' ? data.name : current.name
            const dup = await hasNameDuplicateCI(tx, {
              cls: current.class,
              categoryId: nextCatId ?? null,
              name: nextName,
              excludeFamilyId: familyId
            })
            if (dup) throw new Error('DUPLICATE_NAME')
          }

          // isDefault 調整（同職業僅能有一個）——這是「這一列」的屬性，不跟家族走。
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

          const now = nowMs()
          // 名稱與分類是「這副牌」的屬性，整個家族一起改（plan 規則 3.1）；否則
          // 版本歷史裡會出現不同名字、被分進不同分類的同一副牌。
          await applyFamilyMutables(tx, {
            familyId,
            name: data.name,
            categoryId: typeof data.categoryId !== 'undefined' ? data.categoryId : undefined,
            now
          })
          if (typeof data.isDefault !== 'undefined') {
            await tx
              .updateTable('Deck')
              .set({ isDefault: data.isDefault, updatedAt: now })
              .where('id', '=', id)
              .execute()
          }
          return tx
            .updateTable('Deck')
            .set({ updatedAt: now })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow()
        })
        notifyReferenceDataChanged('decks')
        return deckFromRow(updated)
      })
  )

  // 刪除牌組：作用在整個家族（plan 規則 3.3）。逐列查引用——沒有任何對局引用的
  // 版本真刪（FK 讓 DeckCard 一併消失，沒有東西要保護）；有引用的封存（寫
  // archivedAt），因為在這個模型裡那一列就是那幾十場對局的卡表。封存列若持有
  // isDefault 必須清掉，否則 engine 會繼續把新對局安靜地掛到「已刪除」的牌組上。
  handleIpc(
    'decks:delete',
    async (
      _e,
      { id }: { id: number }
    ): Promise<Res<{ success: true; deleted: number; archived: number }>> =>
      wrap(async () => {
        const result = await db.transaction().execute(async (tx) => {
          const target = await tx
            .selectFrom('Deck')
            .select(['id', 'familyId'])
            .where('id', '=', id)
            .executeTakeFirst()
          if (!target) throw new Error('NOT_FOUND:Deck')
          const familyId = target.familyId ?? target.id
          const rows = await familyVersionRows(tx, familyId)
          return retireDeckRows(
            tx,
            rows.map((r) => r.id),
            nowMs()
          )
        })
        notifyReferenceDataChanged('decks')
        return { success: true as const, ...result }
      })
  )

  // 刪除前的預告：這副牌（整個家族）底下有幾場對局、幾個版本。刪除確認框要
  // 讓使用者知道會走「封存」還是「真刪」，就得先講得出這兩個數字。
  handleIpc(
    'decks:deleteImpact',
    async (_e, { id }: { id: number }): Promise<Res<{ matches: number; versions: number }>> =>
      wrap(async () => {
        const target = await db
          .selectFrom('Deck')
          .select(['id', 'familyId'])
          .where('id', '=', id)
          .executeTakeFirst()
        if (!target) throw new Error('NOT_FOUND:Deck')
        const familyId = target.familyId ?? target.id

        const ids = (await familyVersionRows(db, familyId)).map((v) => v.id)
        return { matches: await countMatchesReferencing(db, ids), versions: ids.length }
      })
  )

  // 捨棄單一版本前的預告：這一個版本有幾場對局、它是不是家族最後一個未封存的
  // 版本。後者決定了「捨棄此版本」會不會變成「刪掉整副牌」——確認框要先講。
  handleIpc(
    'decks:versionImpact',
    async (
      _e,
      { id }: { id: number }
    ): Promise<Res<{ matches: number; versions: number; isLastActive: boolean }>> =>
      wrap(async () => {
        const target = await db
          .selectFrom('Deck')
          .select(['id', 'familyId', 'archivedAt'])
          .where('id', '=', id)
          .executeTakeFirst()
        if (!target) throw new Error('NOT_FOUND:Deck')

        const rows = await familyVersionRows(db, target.familyId ?? target.id)
        const active = rows.filter((r) => r.archivedAt === null)
        return {
          matches: await countMatchesReferencing(db, [id]),
          versions: rows.length,
          isLastActive: target.archivedAt === null && active.length <= 1
        }
      })
  )

  // 捨棄單一版本（階段 2 的版本 UI）。作用在那一列：無引用真刪、有引用封存
  // （封存時清 isDefault）。例外是家族最後一個未封存的版本——把它拿掉等於
  // 「刪掉這副牌」，所以行為等同 decks:delete，整個家族一起處理；否則家族的
  // 「當前版本」定義會回退到某個封存的舊列，或這副牌從清單上安靜消失。
  handleIpc(
    'decks:deleteVersion',
    async (
      _e,
      { id }: { id: number }
    ): Promise<Res<{ success: true; deleted: number; archived: number; familyDeleted: boolean }>> =>
      wrap(async () => {
        const result = await db.transaction().execute(async (tx) => {
          const target = await tx
            .selectFrom('Deck')
            .select(['id', 'familyId', 'archivedAt'])
            .where('id', '=', id)
            .executeTakeFirst()
          if (!target) throw new Error('NOT_FOUND:Deck')

          const rows = await familyVersionRows(tx, target.familyId ?? target.id)
          const active = rows.filter((r) => r.archivedAt === null)
          const now = nowMs()

          if (target.archivedAt === null && active.length <= 1) {
            const retired = await retireDeckRows(
              tx,
              rows.map((r) => r.id),
              now
            )
            return { ...retired, familyDeleted: true }
          }
          const retired = await retireDeckRows(tx, [id], now)
          return { ...retired, familyDeleted: false }
        })
        notifyReferenceDataChanged('decks')
        return { success: true as const, ...result }
      })
  )

  // 設為某職業預設：給某個 deckId 設預設，並清除此職業其他預設
  handleIpc(
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
  handleIpc(
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

        // 先告知重複，但不代替使用者決定要覆蓋還是另存。指紋可能撞到某個舊版本
        // （封存與否都算），但回給 UI 的語意指向「那副牌」——家族的當前版本——
        // 而不是撞到的那一列。
        const existing = await db
          .selectFrom('Deck')
          .select(['id', 'familyId'])
          .where('fingerprint', '=', preview.fingerprint)
          .orderBy('id', 'desc')
          .executeTakeFirst()

        const duplicateDeckId = existing
          ? await familyRepresentativeId(db, existing.familyId ?? existing.id)
          : null
        return { preview, duplicateDeckId }
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
  handleIpc(
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
  handleIpc(
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
          let replaceFamilyId: number | undefined
          if (replaceId !== null) {
            const replaceTarget = await tx
              .selectFrom('Deck')
              .select(['id', 'familyId'])
              .where('id', '=', replaceId)
              .executeTakeFirst()
            if (!replaceTarget) throw new Error('NOT_FOUND:Deck')
            replaceFamilyId = replaceTarget.familyId ?? replaceTarget.id
          } else {
            const dupContent = await tx
              .selectFrom('Deck')
              .select(['id', 'familyId'])
              .where('fingerprint', '=', preview.fingerprint)
              .orderBy('id', 'desc')
              .executeTakeFirst()
            // 帶上 id，讓 UI 能提供「改成更新那一副」而不是只說失敗。指紋撞到的
            // 可能是某個舊版本；回的 id 指向那個家族的當前版本，語意是「這副牌」。
            if (dupContent) {
              const rep = await familyRepresentativeId(tx, dupContent.familyId ?? dupContent.id)
              throw new Error(`DUPLICATE_CONTENT:${rep ?? dupContent.id}`)
            }
          }

          const dupName = await hasNameDuplicateCI(tx, {
            cls,
            categoryId,
            name,
            excludeFamilyId: replaceFamilyId
          })
          if (dupName) throw new Error('DUPLICATE_NAME')

          const now = nowMs()
          const deckFields = {
            name,
            categoryId,
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
  handleIpc(
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
          let replaceFamilyId: number | undefined
          if (replaceId !== null) {
            const current = await tx
              .selectFrom('Deck')
              .select(['id', 'class', 'familyId'])
              .where('id', '=', replaceId)
              .executeTakeFirst()
            if (!current) throw new Error('NOT_FOUND:Deck')
            if (current.class !== cls) throw new Error('INVALID_INPUT:Cannot change deck class')
            replaceFamilyId = current.familyId ?? current.id
          }

          const dupName = await hasNameDuplicateCI(tx, {
            cls,
            categoryId,
            name,
            excludeFamilyId: replaceFamilyId
          })
          if (dupName) throw new Error('DUPLICATE_NAME')

          const now = nowMs()
          return upsertDeckWithCards(tx, {
            replaceDeckId: replaceId,
            cls,
            isDefault: input.isDefault,
            cards,
            now,
            // 預設 fork；「修正、不建立新版本」是使用者明講的例外（plan 3.2）。
            mode: input.forceInPlace ? 'inPlace' : 'fork',
            fields: {
              name,
              categoryId,
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
  handleIpc(
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
  handleIpc(
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
  handleIpc(
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
  handleIpc(
    'decks:cards',
    async (_e, { deckId }: { deckId: number }): Promise<Res<StoredDeckCard[]>> =>
      wrap(async () => readDeckCards(db, deckId))
  )
}
