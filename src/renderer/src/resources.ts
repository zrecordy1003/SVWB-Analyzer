/**
 * The shared IPC resources.
 *
 * One place, rather than a `createIpcResource` call inside whichever component
 * happened to need it first. The point of the cache is that two consumers of
 * the same question share one request, and that only works if they reach the
 * same instance - which they will not if the instance is a component's export.
 * (`DeckVersionsDialog` importing a cache from `DeckPerformance` was where
 * that became obvious: no cycle today, and one waiting to happen.)
 *
 * Keep these small and named after the question, not after the screen.
 */
import { createIpcResource, unwrapRes } from '@renderer/ipcResource'

/**
 * Win/loss per deck, for whatever filter is asked.
 *
 * Two consumers today - the deck-performance page and the version-history
 * dialog opened from it - asking the same channel with different filters. They
 * previously fetched independently, so opening the dialog re-asked something
 * the page behind it already knew, and a `matches:needRefetch` produced two
 * requests instead of one.
 */
export const deckStatsResource = createIpcResource({
  channel: 'decks:stats',
  select: unwrapRes,
  // A game that just ended should move the numbers without the user touching
  // a filter.
  invalidateOn: ['matches:needRefetch']
})

/**
 * Card-level win rates.
 *
 * Wrapped by `useCardStats`, which adds the card-art setting - a settings read
 * rather than a query, so it does not belong in the cache.
 */
export const cardStatsResource = createIpcResource({
  channel: 'cards:stats',
  select: unwrapRes,
  invalidateOn: ['matches:needRefetch']
})
