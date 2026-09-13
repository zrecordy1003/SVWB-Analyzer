import { useEffect, useState } from 'react'

import type { OpeningStatsPayload, OpeningStatsResult } from '@shared/openingStats'
import { createIpcResource, unwrapRes } from '@renderer/ipcResource'

/**
 * `cards:openingStats`, through the shared cache.
 *
 * The resource lives here rather than in `src/renderer/src/resources.ts`, which
 * is where the others are and where this one should move the next time that
 * file is touched: this page was built alongside three other changes and its
 * scope was kept to its own folder plus the App wiring. The cache semantics are
 * unchanged - keyed on the query, invalidated when a match lands - so a second
 * consumer (the drill-down's per-opponent queries) shares requests with the
 * table, and re-opening the drawer on the same card costs nothing.
 */
export const openingStatsResource = createIpcResource({
  channel: 'cards:openingStats',
  select: unwrapRes,
  // Unlike the other resources this one also moves WITHOUT a new match: the
  // background retry names cards after the fact. There is no broadcast for
  // that yet, so `matches:needRefetch` is the best available proxy and the
  // page shows `pendingRetry` so the user knows numbers may still move.
  invalidateOn: ['matches:needRefetch']
})

/** A `null` query means "not ready to ask yet"; distinct from an empty filter. */
export function useOpeningStats(query: OpeningStatsPayload | null): {
  data: OpeningStatsResult | null
  loading: boolean
  error: string | null
  showImages: boolean
} {
  const { data, loading, error } = openingStatsResource.use(query ? [query] : null)
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
