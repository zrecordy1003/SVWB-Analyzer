// src/renderer/components/matches/MatchList.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Snackbar, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'

import SearchBar, {
  type Filters as SearchFilters,
  type OnFiltersChange
} from './component/SearchBar'
import MatchFormDrawer from './component/MatchFormDrawer'
import ConfirmDialog from '../Common/ConfirmDialog'
import VirtualMatchList from './component/VirtualMatchList'
import { useDecksTags } from '../../hooks/useDecksTags'
import { useInfiniteMatches } from './hooks/useInfiniteMatches'
import { invokeIpc } from '@renderer/ipc'

/**
 * 新增的紀錄會不會出現在目前這份清單裡。
 *
 * 只看時間。時間是唯一有預設值的條件（預設「今天」），所以也是唯一會在使用者
 * 什麼都沒設定的情況下把剛補的舊紀錄藏起來的東西——而那正是這個功能最主要的
 * 用途。職業、模式、牌組那些是使用者自己挑的，被篩掉不會意外。
 *
 * 不自動改動篩選條件：那是使用者的設定，替他改掉比讓他自己去改更難理解。
 */
function withinActiveRange(filters: SearchFilters, playedAt: Date): boolean {
  const { rangeKey, startDate, endDate } = filters
  if (rangeKey === 'all') return true

  if (rangeKey === 'custom') {
    if (startDate && playedAt < startOfDay(startDate)) return false
    if (endDate && playedAt > endOfDay(endDate)) return false
    return true
  }

  const days = rangeKey === 'today' ? 1 : rangeKey === '7d' ? 7 : 30
  const from = startOfDay(new Date())
  from.setDate(from.getDate() - (days - 1))
  return playedAt >= from && playedAt <= endOfDay(new Date())
}

const startOfDay = (d: Date): Date => {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

const endOfDay = (d: Date): Date => {
  const copy = new Date(d)
  copy.setHours(23, 59, 59, 999)
  return copy
}

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

  // 編輯 / 新增 / 刪除
  const [editId, setEditId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [createdNote, setCreatedNote] = useState<string | null>(null)
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
        await invokeIpc('matches:updateDeck', id, side, deckId)
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
      await invokeIpc('matches:delete', id)
      removeRow(id)
    },
    [confirmDelete.id, removeRow]
  )

  return (
    // 外距由 Main 統一給，頁面不再自己加一圈 - 分析器和這裡的邊界才會落在同一
    // 條線上。高度同理：吃掉工具列以外剩下的空間，不自己算 vh。
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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

      <Box display="flex" alignItems="center" justifyContent="space-between" gap={1} mb={1}>
        {/* 動作在左、狀態在右：這一條是清單的頂邊，而讀一份清單是從左上角開始的
            ——那個位置該放「我可以做什麼」，不是「有幾筆」。補一筆漏掉的、或把
            工具啟用前的舊資料填進來，加的東西就出現在下面。 */}
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          onClick={() => setCreating(true)}
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700, ml: -0.5 }}
        >
          新增紀錄
        </Button>
        <Box display="flex" alignItems="center" gap={1.5}>
          {/* 筆數只講「符合條件的有幾筆」。原本還報了已載入幾筆，但那是無限捲動
              自己的進度，不是使用者問的問題——捲到底就會一樣，在那之前也沒有哪個
              決定取決於它。 */}
          <Typography variant="caption" color="text.secondary">
            {totalCount} 筆
          </Typography>
        </Box>
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

      {/* 編輯：右側抽屜，清單留在旁邊看得到 */}
      <MatchFormDrawer
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

      {/* 新增：同一個抽屜，開在 create 模式 */}
      <MatchFormDrawer
        open={creating}
        matchId={null}
        create
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          // 不做樂觀插入：新紀錄的時間可能落在這份清單的任何位置（甚至在還沒
          // 載入的那幾頁裡），塞在最前面會讓它看起來排錯。重查一次比較誠實。
          reload()
          setCreatedNote(
            withinActiveRange(filters, new Date(created.playedAt))
              ? '已新增一筆紀錄'
              : '已新增，但它不在目前的時間篩選範圍內——把範圍往前調才看得到'
          )
        }}
      />

      {/* 刪除確認 */}
      <ConfirmDialog
        open={confirmDelete.open}
        title="刪除此對戰紀錄？"
        message="此操作無法復原。"
        onClose={handleConfirmDelete}
      />

      <Snackbar
        open={!!createdNote}
        autoHideDuration={6000}
        onClose={() => setCreatedNote(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setCreatedNote(null)}>
          {createdNote}
        </Alert>
      </Snackbar>

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
