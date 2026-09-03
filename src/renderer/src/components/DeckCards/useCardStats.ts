import { useEffect, useState } from 'react'

import type { CardStatsPayload } from '@shared/cards'
import type { CardStatsResult } from '@shared/cardStats'
import { cardStatsResource } from '@renderer/resources'

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
  const [showImages, setShowImages] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.settings
      .get('settings')
      .then((settings) => {
        if (!cancelled) setShowImages(Boolean(settings?.cardImages))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return { data, loading, error, showImages }
}
