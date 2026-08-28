// src/renderer/components/matches/MatchList.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'

import SearchBar, {
  type Filters as SearchFilters,
  type OnFiltersChange
} from './component/SearchBar'
import MatchEditDialog from './component/MatchEditDialog'
import ConfirmDialog from '../Common/ConfirmDialog'
import VirtualMatchList from './component/VirtualMatchList'
import { useDecksTags } from '../../hooks/useDecksTags'
import { useInfiniteMatches } from './hooks/useInfiniteMatches'

function useDebounced<T>(value: T, delay = 200): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return v
}

const MatchList = (): React.JSX.Element => {
  const {
    allDecks,
    allTags,
    loading: referenceDataLoading,
    refreshDecks,
    refreshTags
  } = useDecksTags()

  const [filters, setFilters] = useState<SearchFilters>({
    my: [],
    oppo: [],
    mode: null,
    rangeKey: 'today',
    startDate: null,
    endDate: null,
    decks: [],
    tags: [],
    note: 'any',
    crEnabled: false,
    crMin: null,
    crMax: null
  })
  const onFiltersChange = useCallback<OnFiltersChange>(
    (patch) => setFilters((f) => ({ ...f, ...patch })),
    []
  )
  const debouncedFilters = useDebounced(filters, 200)
  const [filtersInitialized, setFiltersInitialized] = useState(false)
  const [queryEnabled, setQueryEnabled] = useState(false)

  useEffect(() => {
    if (!filtersInitialized) return
    const handle = setTimeout(() => setQueryEnabled(true), 240)
    return () => clearTimeout(handle)
  }, [filtersInitialized])

  const {
    rows,
    totalCount,
    isInitialLoading,
    isLoadingMore,
    loadError,
    hasMore,
    loadMore,
    patchRow,
    removeRow,
    mergeNewOnTop,
    reload
  } = useInfiniteMatches(debouncedFilters, queryEnabled)

  // 編輯 / 刪除
  const [editId, setEditId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; id: number | null }>({
    open: false,
    id: null
  })

  // 外部通知（新對局寫入）→ 只把新資料插到最前面，不重置捲動位置
  const mergeNewOnTopRef = useRef(mergeNewOnTop)
  mergeNewOnTopRef.current = mergeNewOnTop
  useEffect(() => {
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', () => {
      mergeNewOnTopRef.current()
    })
    return () => {
      unsub && unsub()
    }
  }, [])

  const openEdit = useCallback((id: number) => setEditId(id), [])
  const closeEdit = useCallback(() => setEditId(null), [])

  const requestDelete = useCallback((id: number) => setConfirmDelete({ open: true, id }), [])
  const handleConfirmDelete = useCallback(
    async (ok: boolean) => {
      const id = confirmDelete.id
      setConfirmDelete({ open: false, id: null })
      if (!ok || !id) return
      await window.electron.ipcRenderer.invoke('matches:delete', id)
      removeRow(id)
    },
    [confirmDelete.id, removeRow]
  )

  return (
    <Box p={2} display="flex" flexDirection="column" height="calc(100vh - 140px)">
      <SearchBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        deckOptions={allDecks}
        tagOptions={allTags}
        refreshDecks={refreshDecks}
        refreshTags={refreshTags}
        initializationReady={!referenceDataLoading}
        onInitialized={() => setFiltersInitialized(true)}
      />

      <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
        <Typography variant="caption" color="text.secondary">
          已載入 {rows.length} / 共 {totalCount} 筆
        </Typography>
        <Typography variant="caption" color="text.secondary">
          右鍵：編輯
        </Typography>
      </Box>

      <Box flex={1} minHeight={0}>
        <VirtualMatchList
          rows={rows}
          onEdit={openEdit}
          onDelete={requestDelete}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          isInitialLoading={isInitialLoading}
          loadError={loadError}
          onLoadMore={loadMore}
          onRetry={reload}
        />
      </Box>

      {/* 編輯對話框 */}
      <MatchEditDialog
        open={!!editId}
        matchId={editId}
        onClose={closeEdit}
        onSaved={(updated) =>
          patchRow(updated.id, {
            ...updated,
            tags: updated.tags?.map(({ tag }) => tag) ?? [],
            tagCount: updated.tags?.length ?? 0
          })
        }
        onDeleted={() => editId && removeRow(editId)}
      />

      {/* 刪除確認 */}
      <ConfirmDialog
        open={confirmDelete.open}
        title="刪除此對戰紀錄？"
        message="此操作無法復原。"
        onClose={handleConfirmDelete}
      />
    </Box>
  )
}

export default MatchList
