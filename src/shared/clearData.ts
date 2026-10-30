/**
 * "Clear past data" in Settings: what can be cleared, and how many of each there are.
 *
 * Four independent kinds, because the user chooses (a modal with a checkbox for
 * each and the number next to it). Matches are the default; decks, tags and
 * categories are opt-in, since removing them also empties the pickers and filters
 * that use them.
 */

export interface ClearCounts {
  /** Recorded games. Their opening hands and tag links go with them. */
  matches: number
  decks: number
  tags: number
  /** The user's own deck categories. The three built-in ones are never counted or removed. */
  categories: number
}

export type ClearSelection = Record<keyof ClearCounts, boolean>

export interface ClearResult {
  /** What was removed, by kind. */
  deleted: ClearCounts
  /** The pre-clear copy of the database, so the user can go back. */
  backup: string
  /** Sync was on, so the deletions are being sent to the user's other devices as well. */
  syncs: boolean
}
