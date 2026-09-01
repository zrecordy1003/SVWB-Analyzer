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

/** Which slices we do not hold for this language yet. */
export async function missingCardPoolSlices(
  db: Kysely<Database>,
  slices: readonly CardPoolSlice[],
  lang: PortalLang
): Promise<CardPoolSlice[]> {
  const have = await db
    .selectFrom('CardPoolSync')
    .select(['classId', 'battleFormat'])
    .where('lang', '=', lang)
    .execute()

  const key = (s: CardPoolSlice): string => `${s.classId}:${s.battleFormat}`
  const held = new Set(have.map(key))
  return slices.filter((s) => !held.has(key(s)))
}
