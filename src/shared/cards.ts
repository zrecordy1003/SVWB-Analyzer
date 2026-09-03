/**
 * The card channels' payloads and return shapes.
 *
 * Same reason as `shared/decks.ts`: these are what the renderer sends and
 * receives, so they belong to the contract rather than to the handler that
 * happens to produce them.
 */
import type { GameMode } from './domain.js'
import type { PoolCard } from './deckImport.js'
import type { QueryPayload } from './types.js'

export type CardPoolResult = {
  cards: PoolCard[]
  /** Null when this slice has never been fetched, so the UI can offer to fetch it. */
  syncedAt: number | null
  /** The language the stored text is in, which may differ from the current setting. */
  lang: string | null
}

/** One `(class, format, language)` slice of the pool, and when it was last fetched. */
export type CardPoolStatusRow = {
  classId: number
  battleFormat: number
  lang: string
  cardCount: number
  syncedAt: number
}

/**
 * The match list's filter payload, with two additions the card page needs:
 * `mode: 'all'` (an option the list does not have) and `limit`, the "most
 * recent N matches" cap. Paging fields are meaningless for an aggregate.
 */
export type CardStatsPayload = Omit<QueryPayload, 'mode' | 'cursor' | 'pageIndex' | 'pageSize'> & {
  mode?: GameMode | 'all' | null
  /** Keep only the `limit` most recent matches that pass every other filter. */
  limit?: number | null
}
