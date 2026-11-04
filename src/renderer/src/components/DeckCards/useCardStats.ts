import type { CardStatsPayload } from '@shared/cards'
import type { CardStatsResult } from '@shared/cardStats'
import { cardStatsResource } from '@renderer/resources'
import { useCardImages } from '@renderer/hooks/useCardImages'

/**
 * `cards:stats`, through the shared cache.
 *
 * This file was a `useState` triple, an effect that fetched, a second effect
 * for the `matches:needRefetch` broadcast, and a `useRef` sequence counter so
 * a late answer could not overwrite a newer one. All four are
 * `createIpcResource` now, and the sequence counter is gone rather than moved:
 * the cache is keyed on the query, so a late answer writes to its own key and
 * the hook reads the key it currently wants.
 *
 * A `null` query means "not ready to ask yet" - the page is still restoring
 * its saved filters - and issues no request. Distinct from an empty filter,
 * which is a real query.
 *
 * `showImages` rides along because every consumer of this data needs that
 * answer too, and it is a settings read rather than a query.
 */
export function useCardStats(query: CardStatsPayload | null): {
  data: CardStatsResult | null
  loading: boolean
  error: string | null
  showImages: boolean
} {
  const { data, loading, error } = cardStatsResource.use(query ? [query] : null)
  const showImages = useCardImages()

  return { data, loading, error, showImages }
}
