import type { MulliganPayload, MulliganResult } from '@shared/openingStats'
import { createIpcResource, unwrapRes } from '@renderer/ipcResource'

/**
 * `cards:mulligan`, through the shared cache - the same arrangement as
 * `useOpeningStats.ts`, and it should move to `resources.ts` together with
 * that one. Keyed on the payload, so switching the opponent pin and switching
 * back costs one round trip, not two; invalidated on the same broadcast, for
 * the same reason (the background retry names cards after the fact).
 */
export const mulliganResource = createIpcResource({
  channel: 'cards:mulligan',
  select: unwrapRes,
  invalidateOn: ['matches:needRefetch']
})

/** A `null` query means "not ready to ask yet"; distinct from an empty filter. */
export function useMulligan(query: MulliganPayload | null): {
  data: MulliganResult | null
  loading: boolean
  error: string | null
} {
  const { data, loading, error } = mulliganResource.use(query ? [query] : null)
  return { data, loading, error }
}
