import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import type { Database } from '../data/db/client.js'

/**
 * What a "my deck" filter means once decks have versions.
 *
 * - `'family'` (the default): "these decks" means "these decks and every other
 *   version of them". The renderer's pickers list one row per family - the
 *   current version - so a filter pinned to that id would silently drop every
 *   match played on the versions before it. Expanding here, in the one place
 *   the predicate is built, fixes the match list and the analyzer at once
 *   without either of them having to hold every version of every deck.
 * - `'deck'`: exactly these rows. The analyzer's "single version" mode.
 */
export type MyDeckScope = 'family' | 'deck'

/**
 * The predicate for `myDeckIds`, as a sub-select rather than a pre-resolved id
 * list so it can be built synchronously inside an expression builder and stays
 * correct even if a fork lands between two pages of the same list.
 */
export function myDeckIdsExpression(
  eb: ExpressionBuilder<Database, 'Match'>,
  ids: number[],
  scope: MyDeckScope | undefined
): Expression<SqlBool> {
  if (scope === 'deck') return eb('my_deckId', 'in', ids)

  // Every row whose family is the family of any picked row. `coalesce` because
  // familyId is nullable in the schema even though the write path fills it.
  return eb(
    'my_deckId',
    'in',
    eb
      .selectFrom('Deck')
      .select('Deck.id')
      .where(
        sql<number>`coalesce("Deck"."familyId", "Deck"."id")`,
        'in',
        eb
          .selectFrom('Deck as Picked')
          .select(sql<number>`coalesce("Picked"."familyId", "Picked"."id")`.as('fam'))
          .where('Picked.id', 'in', ids)
      )
  )
}
