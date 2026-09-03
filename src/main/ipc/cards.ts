/**
 * The card pool: reading it, and filling it.
 *
 * Separate from `ipc/decks.ts` because the lifetimes are different. A deck is
 * the user's data and lives forever; the pool is a cache of Cygames' data,
 * fetched a class at a time when an editor asks for it, and disposable.
 *
 * Reads never go to the network. `cards:pool` answers from SQLite and reports
 * whether that slice has ever been synced; fetching is a separate, explicit act.
 * That split is what lets the startup bootstrap
 * (`data/cardPoolBootstrap.ts`) and the user's own refresh button share one
 * write path without either of them being able to turn a render into a request.
 */
import { ipcMain } from 'electron'

import type { PoolCard } from '../../shared/deckImport.js'
import { cardKindFromType, CLASS_ID_TO_NAME } from '../../shared/deckImport.js'
import { syncCardPoolSlice } from '../data/cardPool.js'
import { getDb } from '../data/db/client.js'
import { SvwbApiError, type PortalLang } from '../data/svwbApi.js'
import { store } from '../store.js'
import type { Res } from '../../shared/ipc.js'

/**
 * This module's own `wrap`, and NOT the shared `wrapRes`.
 *
 * The difference is the `SvwbApiError` branch: the portal's failures carry a
 * CODE that the UI switches on to say something specific, so returning
 * `e.message` here - which is what the shared helper does - would flatten
 * "the deck code expired" and "the portal is down" into the same string.
 *
 * Three other modules did have an identical private copy of the shared one and
 * have been folded into it; this one is a specialisation, so it stays.
 */
const wrap = async <T>(fn: () => Promise<T>): Promise<Res<T>> => {
  try {
    return { ok: true, data: await fn() }
  } catch (e: unknown) {
    if (e instanceof SvwbApiError) return { ok: false, error: e.code }
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

const currentLang = (): PortalLang =>
  (store.get('settings')?.cardLang as PortalLang | undefined) ?? 'cht'

/** The pool as the renderer consumes it, plus how fresh it is. */
export type CardPoolResult = {
  cards: PoolCard[]
  /** Null when this slice has never been fetched, so the UI can offer to fetch it. */
  syncedAt: number | null
  /** The language the stored text is in, which may differ from the current setting. */
  lang: string | null
}

function assertKnownClass(classId: unknown): number {
  const id = Number(classId)
  if (!Number.isInteger(id) || !CLASS_ID_TO_NAME[id]) {
    throw new Error('INVALID_INPUT:Unknown class')
  }
  return id
}

function assertKnownFormat(battleFormat: unknown): number {
  const f = Number(battleFormat)
  if (!Number.isInteger(f) || f < 1 || f > 4) throw new Error('INVALID_INPUT:Unknown battle format')
  return f
}

export function registerCardsIpc(): void {
  const db = getDb()

  /**
   * Read one class's pool for a format from disk.
   *
   * Returns neutral cards alongside the class's own, because that is what a
   * deck may contain and what the portal itself returns together.
   */
  ipcMain.handle(
    'cards:pool',
    async (_e, input: { classId: number; battleFormat: number }): Promise<Res<CardPoolResult>> =>
      wrap(async () => {
        const classId = assertKnownClass(input?.classId)
        const battleFormat = assertKnownFormat(input?.battleFormat)
        const lang = currentLang()

        const sync = await db
          .selectFrom('CardPoolSync')
          .select(['syncedAt', 'lang'])
          .where('classId', '=', classId)
          .where('battleFormat', '=', battleFormat)
          .where('lang', '=', lang)
          .executeTakeFirst()

        const rows = await db
          .selectFrom('CardPool')
          .innerJoin('Card', 'Card.cardId', 'CardPool.cardId')
          .select([
            'Card.cardId',
            'Card.name',
            'Card.cost',
            'Card.type',
            'Card.class',
            'Card.rarity',
            'Card.atk',
            'Card.life',
            'Card.skillText',
            'Card.tribes',
            'Card.deckEnabledNum',
            'Card.imageHash',
            'Card.bannerHash',
            'Card.isToken',
            'CardPool.sortIndex'
          ])
          .where('CardPool.battleFormat', '=', battleFormat)
          // 0 is neutral: playable in every class's deck.
          .where('Card.class', 'in', [0, classId])
          .orderBy('CardPool.sortIndex', 'asc')
          .execute()

        const cards: PoolCard[] = rows.map((r) => ({
          cardId: r.cardId,
          name: r.name,
          cost: r.cost,
          type: r.type,
          kind: cardKindFromType(r.type),
          cardClass: r.class,
          rarity: r.rarity,
          atk: r.atk,
          life: r.life,
          skillText: r.skillText,
          tribes: parseTribes(r.tribes),
          deckEnabledNum: r.deckEnabledNum,
          imageHash: r.imageHash,
          bannerHash: r.bannerHash,
          isToken: r.isToken === 1,
          sortIndex: r.sortIndex
        }))

        return { cards, syncedAt: sync?.syncedAt ?? null, lang: sync?.lang ?? null }
      })
  )

  /**
   * Fetch one class's pool from the portal and write it to disk.
   *
   * The write itself lives in `data/cardPool.ts`, shared with the startup
   * bootstrap - the upsert semantics are subtle enough that two copies would
   * eventually disagree.
   */
  ipcMain.handle(
    'cards:syncPool',
    async (
      _e,
      input: { classId: number; battleFormat: number }
    ): Promise<Res<{ cardCount: number; syncedAt: number }>> =>
      wrap(async () =>
        syncCardPoolSlice(
          db,
          {
            classId: assertKnownClass(input?.classId),
            battleFormat: assertKnownFormat(input?.battleFormat)
          },
          currentLang()
        )
      )
  )

  /** Every slice we hold, for a settings screen or a diagnosis. */
  ipcMain.handle(
    'cards:poolStatus',
    async (): Promise<
      Res<
        {
          classId: number
          battleFormat: number
          lang: string
          cardCount: number
          syncedAt: number
        }[]
      >
    > =>
      wrap(async () =>
        db
          .selectFrom('CardPoolSync')
          .selectAll()
          .orderBy('battleFormat', 'asc')
          .orderBy('classId', 'asc')
          .execute()
      )
  )
}

/** `tribes` is stored as a JSON array; a corrupt value costs the tribes, not the card. */
function parseTribes(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}
