import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueryPayload } from '@shared/types'
import type { MatchRow } from '../types'

const CHUNK_SIZE = 30

/** 對外只需要能轉成 QueryPayload 的篩選條件（型別對齊 SearchBar 的 Filters） */
export type MatchFilters = {
  my: { id: string | number }[]
  oppo: { id: string | number }[]
  mode: string | null
  rangeKey: string
  startDate: Date | null
  endDate: Date | null
  decks: { id: number }[]
  tags: { id: number }[]
  note: 'any' | 'with' | 'without'
  crEnabled: boolean
  crMin: number | null
  crMax: number | null
}

function buildPayload(f: MatchFilters): QueryPayload {
  let start: string | null = null
  let end: string | null = null
  if (f.rangeKey === 'custom' && f.startDate && f.endDate) {
    start = new Date(f.startDate).toISOString()
    end = new Date(f.endDate).toISOString()
  }
  return {
    myClassIds: f.my.map((c) => String(c.id)) as QueryPayload['myClassIds'],
    oppoClassIds: f.oppo.map((c) => String(c.id)) as QueryPayload['oppoClassIds'],
    mode: (f.mode ?? null) as QueryPayload['mode'],
    rangeKey: f.rangeKey as QueryPayload['rangeKey'],
    start,
    end,
    myDeckIds: f.decks.map((d) => Number(d.id)),
    tagIds: f.tags.map((t) => Number(t.id)),
    note: f.note,
    crMin: f.crEnabled && typeof f.crMin === 'number' ? f.crMin : null,
    crMax: f.crEnabled && typeof f.crMax === 'number' ? f.crMax : null
  }
}

/** Rows carry `playedAt` as a Date over IPC, but be tolerant of a string. */
const timeOf = (value: Date | string | number): number => new Date(value).getTime()

type MatchCursor = { playedAt: string; id: number }
type MatchListPage = {
  rows: MatchRow[]
  total: number | null
  hasMore: boolean
  nextCursor: MatchCursor | null
}

async function fetchListPage(
  pageSize: number,
  f: MatchFilters,
  cursor: MatchCursor | null = null
): Promise<MatchListPage> {
  const payload = { pageSize, cursor, ...buildPayload(f) }
  return window.electron?.ipcRenderer.invoke('matches:queryList', payload)
}

/**
 * Fold a freshly fetched newest page into the rows already held.
 *
 * A match row is not written once. The engine creates it the moment a battle
 * starts - result, mode and BP all still null - and then UPDATES that same row
 * as each value becomes known. A refresh that only prepends ids it has not
 * seen therefore leaves the "未定" version of a row on screen for good, which
 * is what this used to do: every `matchUpdated` and `matchFinished` arrived,
 * re-fetched, and discarded the new data because the id was already held.
 *
 * `topChunk` is authoritative for everything at or newer than its oldest row.
 * Inside that window what it returns replaces what is held, and a held row it
 * no longer returns has been deleted - which is how an abandoned replay match
 * disappears instead of lingering as a phantom.
 *
 * Rows older than the window are kept as they are. The engine only ever
 * mutates the newest match, so re-reading every page the user has scrolled
 * through would cost far more than it buys.
 *
 * Exported as a pure function so the reconciliation is testable without a DOM.
 */
export function reconcileRecent(
  prev: MatchRow[],
  topChunk: MatchRow[],
  chunkSize: number
): MatchRow[] {
  const incoming = new Set(topChunk.map((r) => r.id))
  // A short chunk means the query returned everything it has, so the window is
  // the whole list and nothing outside it survives.
  const windowEdge =
    topChunk.length < chunkSize
      ? Number.NEGATIVE_INFINITY
      : timeOf(topChunk[topChunk.length - 1].playedAt)
  // `<=` rather than `<` on the boundary: a row sharing the oldest timestamp
  // may simply have been cut off by the page limit, and showing it one refresh
  // too long beats dropping a real match.
  const older = prev.filter((r) => !incoming.has(r.id) && timeOf(r.playedAt) <= windowEdge)
  return [...topChunk, ...older]
}

/**
 * 滾動載入版的對局清單資料 hook。
 * - rows 只會累加（loadMore）或整批重置（filters 變更），不做傳統換頁。
 * - patchRow / removeRow 讓編輯、刪除可以就地更新單筆卡片，不必整批重抓。
 * - syncRecent 讓外部通知（引擎寫入、使用者編輯）就地對齊最新一頁：新增、就地更新
 *   與刪除都會反映，且不打斷捲動位置。
 */
export function useInfiniteMatches(filters: MatchFilters, enabled = true) {
  const [rows, setRows] = useState<MatchRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const nextCursorRef = useRef<MatchCursor | null>(null)

  // generation 在每次篩選條件變更時 +1；任何非最新 generation 的回應都會被丟棄
  const generationRef = useRef(0)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const filterKey = JSON.stringify(filters)
  const filterKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (filterKeyRef.current === filterKey) return
    filterKeyRef.current = filterKey
    const generation = ++generationRef.current
    setIsInitialLoading(true)
    setIsLoadingMore(false)
    setLoadError(null)
    setHasMore(false)
    nextCursorRef.current = null

    void (async () => {
      try {
        const {
          rows: firstChunk,
          total,
          hasMore: more,
          nextCursor
        } = await fetchListPage(CHUNK_SIZE, filters)
        if (generation !== generationRef.current) return
        setRows(firstChunk)
        setTotalCount(total ?? 0)
        setHasMore(more)
        nextCursorRef.current = nextCursor
      } catch (error) {
        if (generation !== generationRef.current) return
        console.error('Failed to load match list:', error)
        setRows([])
        setTotalCount(0)
        setHasMore(false)
        nextCursorRef.current = null
        setLoadError('無法載入對局列表，請確認資料庫後再試一次。')
      } finally {
        if (generation === generationRef.current) setIsInitialLoading(false)
      }
    })()
    // filterKey 已經涵蓋 filters 的內容，不需要把 filters 物件本身也列進 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, filterKey, reloadToken])

  const loadMore = useCallback(() => {
    if (isLoadingMore || isInitialLoading || !hasMore || !nextCursorRef.current) return
    const generation = generationRef.current
    setIsLoadingMore(true)
    const cursor = nextCursorRef.current
    void fetchListPage(CHUNK_SIZE, filtersRef.current, cursor)
      .then(({ rows: nextChunk, hasMore: more, nextCursor }) => {
        if (generation !== generationRef.current) return
        setRows((prev) => [...prev, ...nextChunk])
        setHasMore(more)
        nextCursorRef.current = nextCursor
      })
      .catch((error) => {
        if (generation !== generationRef.current) return
        console.error('Failed to load more matches:', error)
        setLoadError('無法載入更多對局，請稍後再試。')
      })
      .finally(() => {
        if (generation === generationRef.current) setIsLoadingMore(false)
      })
  }, [hasMore, isInitialLoading, isLoadingMore])

  const patchRow = useCallback((id: number, updated: MatchRow) => {
    setRows((prev) => prev.map((r) => (r.id === id ? updated : r)))
  }, [])

  const removeRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
    setTotalCount((prev) => Math.max(0, prev - 1))
  }, [])

  const syncRecent = useCallback(() => {
    const generation = generationRef.current
    const f = filtersRef.current
    void fetchListPage(CHUNK_SIZE, f)
      .then(({ rows: topChunk, total }) => {
        if (generation !== generationRef.current) return
        setRows((prev) => reconcileRecent(prev, topChunk, CHUNK_SIZE))
        if (total != null) setTotalCount(total)
      })
      .catch((error) => {
        if (generation !== generationRef.current) return
        console.error('Failed to refresh match list:', error)
      })
  }, [])

  const reload = useCallback(() => {
    filterKeyRef.current = null
    setReloadToken((value) => value + 1)
  }, [])

  return {
    rows,
    totalCount,
    isInitialLoading,
    isLoadingMore,
    loadError,
    hasMore,
    loadMore,
    patchRow,
    removeRow,
    syncRecent,
    reload
  }
}
