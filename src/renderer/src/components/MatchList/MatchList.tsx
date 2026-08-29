// src/renderer/components/matches/MatchList.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Snackbar, Typography } from '@mui/material'

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
    syncRecent,
    reload
  } = useInfiniteMatches(debouncedFilters, queryEnabled)

  // 編輯 / 刪除
  const [editId, setEditId] = useState<number | null>(null)
  const [deckError, setDeckError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; id: number | null }>({
    open: false,
    id: null
  })

  // 就地更新單列時要拿到最新一版的該列，但又不想讓 rows 進 callback 的相依
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // 外部通知（引擎寫入或使用者編輯）→ 就地對齊最新一頁，不重置捲動位置
  const syncRecentRef = useRef(syncRecent)
  syncRecentRef.current = syncRecent
  useEffect(() => {
    const sync = (): void => syncRecentRef.current()
    const unsubMatches = window.electron?.ipcRenderer.on('matches:needRefetch', sync)
    // Cards render deck and tag NAMES, denormalised into each row by the join.
    // Renaming a deck therefore leaves the old name on every card until
    // something else refetches, so reference-data edits have to land here too.
    const unsubReference = window.electron?.ipcRenderer.on('reference-data:changed', sync)
    return () => {
      unsubMatches && unsubMatches()
      unsubReference && unsubReference()
    }
  }, [])

  const openEdit = useCallback((id: number) => setEditId(id), [])
  const closeEdit = useCallback(() => setEditId(null), [])

  // 卡片上的牌組下拉：寫完才更新該列，失敗就維持原樣並說明，不做樂觀更新
  const setDeck = useCallback(
    async (id: number, side: 'my' | 'oppo', deckId: number) => {
      const deck = allDecks.find((d) => d.id === deckId)
      if (!deck) return
      try {
        await window.electron.ipcRenderer.invoke('matches:updateDeck', id, side, deckId)
        const current = rowsRef.current.find((r) => r.id === id)
        if (!current) return
        const picked = { id: deck.id, name: deck.name }
        patchRow(
          id,
          side === 'my' ? { ...current, my_deck: picked } : { ...current, oppo_deck: picked }
        )
      } catch (e: any) {
        setDeckError(e?.message ?? '設定牌組失敗')
      }
    },
    [allDecks, patchRow]
  )

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
          deckOptions={allDecks}
          onEdit={openEdit}
          onDelete={requestDelete}
          onSetDeck={setDeck}
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

      <Snackbar
        open={!!deckError}
        autoHideDuration={4000}
        onClose={() => setDeckError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setDeckError(null)}>
          {deckError}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default MatchList
