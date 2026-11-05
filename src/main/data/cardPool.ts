/**
 * Filling the card pool: one (class, format, language) slice at a time.
 *
 * Extracted from `ipc/cards.ts` because two callers need it and must not drift:
 * the user's own "sync" button, and the startup bootstrap that fills the pool
 * before anyone asks. A second copy of the upsert would be a second chance to
 * get the shared-with-imported-decks semantics wrong.
 *
 * The pool must be fetched per class - the endpoint rejects a request for all
 * of them at once - and per format, because the two formats' card sets diverge
 * as sets rotate out. They happen to be identical today; `is_include_rotation`
 * on each card does NOT reconstruct the rotation pool (it marks 114 of 175
 * cards the rotation endpoint actually returns), so there is no shortcut.
 */
import type { Kysely } from 'kysely'

import type { Database } from './db/client.js'
import { nowMs } from './db/client.js'
import { fetchCardPool, type PortalLang } from './svwbApi.js'
import { currentSeason, type MetaSeason } from '../../shared/meta.js'

export type CardPoolSlice = { classId: number; battleFormat: number }

/**
 * Fetch one slice and write it to disk.
 *
 * `Card` rows are upserted rather than replaced: they are shared with imported
 * decks, so a card that leaves Rotation must keep its details for the decks
 * that still list it. Only this format's membership is rewritten.
 */
export async function syncCardPoolSlice(
  db: Kysely<Database>,
  slice: CardPoolSlice,
  lang: PortalLang
): Promise<{ cardCount: number; syncedAt: number }> {
  const { classId, battleFormat } = slice
  const cards = await fetchCardPool({ classId, battleFormat }, { lang })
  const now = nowMs()

  await db.transaction().execute(async (tx) => {
    for (const card of cards) {
      await tx
        .insertInto('Card')
        .values({
          cardId: card.cardId,
          name: card.name,
          cost: card.cost,
          type: card.type,
          class: card.cardClass,
          rarity: card.rarity,
          atk: card.atk,
          life: card.life,
          skillText: card.skillText,
          tribes: JSON.stringify(card.tribes),
          deckEnabledNum: card.deckEnabledNum,
          imageHash: card.imageHash,
          bannerHash: card.bannerHash,
          isToken: card.isToken ? 1 : 0,
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

      await tx
        .insertInto('CardPool')
        .values({ battleFormat, cardId: card.cardId, sortIndex: card.sortIndex })
        .onConflict((oc) =>
          oc
            .columns(['battleFormat', 'cardId'])
            .doUpdateSet((eb) => ({ sortIndex: eb.ref('excluded.sortIndex') }))
        )
        .execute()
    }

    await tx
      .insertInto('CardPoolSync')
      .values({ classId, battleFormat, lang, cardCount: cards.length, syncedAt: now })
      .onConflict((oc) =>
        oc.columns(['classId', 'battleFormat', 'lang']).doUpdateSet((eb) => ({
          cardCount: eb.ref('excluded.cardCount'),
          syncedAt: eb.ref('excluded.syncedAt')
        }))
      )
      .execute()
  })

  return { cardCount: cards.length, syncedAt: now }
}

/**
 * How old a held slice may get before it is fetched again.
 *
 * The pack list below catches a release the app knows about; this catches the
 * rest - a pack shipped after this build, cards added between packs, a balance
 * patch that rewrote a card's text. A refresh is the same 14 requests as a cold
 * start, so once a week is a small price for never being a pack behind.
 */
export const CARD_POOL_MAX_AGE_MS = 7 * 24 * 60 * 60_000

export type CardPoolDueOptions = {
  now?: number
  maxAgeMs?: number
  releases?: readonly MetaSeason[]
}

/**
 * Which slices to fetch for this language: the ones we do not hold, and the
 * ones that went stale.
 *
 * Holding a slice used to be the whole test, so a pool fetched once was kept
 * forever and every card from a later pack was missing - from the builder, and
 * from the opening-hand index, which only names cards that are in the pool.
 * A slice is now stale when it was fetched before the latest card pack went
 * live, or more than `CARD_POOL_MAX_AGE_MS` ago.
 */
export async function cardPoolSlicesDue(
  db: Kysely<Database>,
  slices: readonly CardPoolSlice[],
  lang: PortalLang,
  options: CardPoolDueOptions = {}
): Promise<CardPoolSlice[]> {
  const now = options.now ?? nowMs()
  const maxAgeMs = options.maxAgeMs ?? CARD_POOL_MAX_AGE_MS
  const season = currentSeason(new Date(now), options.releases)
  const freshSince = Math.max(now - maxAgeMs, season ? Date.parse(season.releasedAt) : 0)

  const have = await db
    .selectFrom('CardPoolSync')
    .select(['classId', 'battleFormat', 'syncedAt'])
    .where('lang', '=', lang)
    .execute()

  const key = (s: CardPoolSlice): string => `${s.classId}:${s.battleFormat}`
  const fresh = new Set(have.filter((row) => Number(row.syncedAt) >= freshSince).map(key))
  return slices.filter((s) => !fresh.has(key(s)))
}
