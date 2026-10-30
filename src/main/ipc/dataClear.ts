/**
 * Clearing recorded data from Settings.
 *
 * Deliberately an ordinary SQL DELETE, not a special path. Everything that has to
 * follow a deletion already hangs off the schema, so there is nothing to
 * remember here:
 *
 *   - a match takes its opening hand and its tag links with it (ON DELETE CASCADE);
 *   - removing a deck leaves the matches that used it, with the deck field empty
 *     (ON DELETE SET NULL), exactly what deleting one deck in the app does;
 *   - and cross-device sync's triggers record each deletion as a tombstone, so when
 *     sync is on the other devices and the cloud copy are cleared too. That is the
 *     behaviour the user asked for ("delete means delete"), and it needs no code
 *     here - which is the point of recording changes with triggers.
 *
 * A copy of the database is taken first and the clear is refused if the copy cannot
 * be made: this is the one irreversible button in the app, and "no backup" is a
 * worse failure than "did not clear".
 *
 * Everything is one transaction, so a clear is all or nothing.
 */
import type { Kysely } from 'kysely'

import { backUp } from '../sync/lifecycle.js'
import { getState } from '../sync/ledger.js'
import { getDb, type Database } from '../data/db/client.js'
import { broadcast } from '../utils/broadcast.js'
import { handleIpc } from './typed.js'
import type { ClearCounts, ClearResult, ClearSelection } from '../../shared/clearData.js'

/** The three categories every install has; they are part of the app, not the user's data. */
const BUILTIN_CATEGORIES = ['aggro', 'midrange', 'control']

export const BACKUP_REASON = 'before-clear'

export async function countClearable(db: Kysely<Database>): Promise<ClearCounts> {
  const count = async (table: 'Match' | 'Deck' | 'Tag'): Promise<number> =>
    Number(
      (
        await db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow()
      ).n
    )
  const categories = await db
    .selectFrom('DeckCategory')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('id', 'not in', BUILTIN_CATEGORIES)
    .executeTakeFirstOrThrow()
  return {
    matches: await count('Match'),
    decks: await count('Deck'),
    tags: await count('Tag'),
    categories: Number(categories.n)
  }
}

/** The renderer sends this; do not trust its shape. */
function asSelection(raw: unknown): ClearSelection {
  const o = (raw ?? {}) as Record<string, unknown>
  const sel: ClearSelection = {
    matches: o.matches === true,
    decks: o.decks === true,
    tags: o.tags === true,
    categories: o.categories === true
  }
  if (!Object.values(sel).some(Boolean)) throw new Error('NOTHING_SELECTED')
  return sel
}

export async function clearData(
  db: Kysely<Database>,
  selection: ClearSelection,
  backupDir: string
): Promise<ClearResult> {
  const before = await countClearable(db)
  // Not caught: if there is no backup there is no clear.
  const backup = await backUp(db, backupDir, BACKUP_REASON)

  await db.transaction().execute(async (tx) => {
    // Children before parents, so each statement does the minimum of cascading.
    if (selection.matches) await tx.deleteFrom('Match').execute()
    if (selection.decks) await tx.deleteFrom('Deck').execute()
    if (selection.tags) await tx.deleteFrom('Tag').execute()
    if (selection.categories) {
      await tx.deleteFrom('DeckCategory').where('id', 'not in', BUILTIN_CATEGORIES).execute()
    }
  })

  return {
    deleted: {
      matches: selection.matches ? before.matches : 0,
      decks: selection.decks ? before.decks : 0,
      tags: selection.tags ? before.tags : 0,
      categories: selection.categories ? before.categories : 0
    },
    backup,
    syncs: (await getState(db, 'enabled')) === '1'
  }
}

export function registerDataClearIpc(deps: { backupDir(): string }): void {
  handleIpc('data:clearCounts', () => countClearable(getDb()))

  handleIpc('data:clear', async (_e, selection) => {
    const result = await clearData(getDb(), asSelection(selection), deps.backupDir())
    // Open screens hold copies of what was just removed.
    broadcast('matches:needRefetch')
    for (const scope of ['decks', 'tags', 'categories']) {
      broadcast('reference-data:changed', { scope })
    }
    return result
  })
}
