import { useEffect, useRef, useState } from 'react'
import type { CardStatsQuery, CardStatsResult } from '@shared/cardStats'

type Res<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * `cards:stats` for one query, kept current.
 *
 * A `null` query means "not ready to ask yet" (the page is still restoring its
 * saved filters) and yields no request. The result is re-fetched whenever the
 * main process says the match data moved, so a game that just ended shows up
 * without the user touching a filter. Whether card art may be shown rides along
 * because every consumer of this data needs that answer too.
 */
export function useCardStats(query: CardStatsQuery | null): {
  data: CardStatsResult | null
  loading: boolean
  error: string | null
  showImages: boolean
} {
  const [data, setData] = useState<CardStatsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showImages, setShowImages] = useState(false)
  // A late answer to an old query must not overwrite a newer one.
  const requestSeq = useRef(0)

  useEffect(() => {
    if (!query) return
    let cancelled = false

    const load = (): void => {
      const seq = ++requestSeq.current
      setLoading(true)
      window.electron.ipcRenderer
        .invoke('cards:stats', query)
        .then((res: Res<CardStatsResult>) => {
          if (cancelled || seq !== requestSeq.current) return
          if (res?.ok) {
            setData(res.data)
            setError(null)
          } else {
            setError(res?.error ?? 'UNKNOWN')
          }
        })
        .catch((err: unknown) => {
          if (cancelled || seq !== requestSeq.current) return
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled && seq === requestSeq.current) setLoading(false)
        })
    }

    load()
    const unsubscribe = window.electron?.ipcRenderer.on('matches:needRefetch', load)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [query])

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
