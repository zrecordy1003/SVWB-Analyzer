import React, { useCallback, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import ListAltIcon from '@mui/icons-material/ListAlt'
import EmptyState from '@renderer/components/Common/EmptyState'
import LoadingStatus from '@renderer/components/Common/LoadingStatus'
import SoftButton from '@renderer/components/Common/SoftButton'
import MatchCard, { MATCH_CARD_CONTENT_HEIGHT } from './MatchCard'
import type { InlineDeckOption } from './InlineDeckSelect'
import type { MatchRow } from '../types'
import type { OpeningHandMap } from '../hooks/useInfiniteMatches'

const LOAD_MORE_THRESHOLD = 5
/** 卡片內容 + 上下框線 + 列間距，每張卡片都一樣高 */
const ROW_HEIGHT = MATCH_CARD_CONTENT_HEIGHT + 2 + 12

type Props = {
  rows: MatchRow[]
  /** Opening hands by match id; a row with no entry has none to show. */
  hands: OpeningHandMap
  deckOptions: InlineDeckOption[]
  onEdit: (id: number) => void
  onDelete: (id: number) => void
  onSetDeck: (id: number, side: 'my' | 'oppo', deckId: number) => void
  hasMore: boolean
  isLoadingMore: boolean
  /** True while the first page of a new query is in flight; rows may still hold the previous one. */
  isInitialLoading: boolean
  loadError: string | null
  /** Whether any match exists at all, filters aside; null when unknown. */
  hasAnyMatch: boolean | null
  onLoadMore: () => void
  /** Reload from the top - for a failed first page only. */
  onRetry: () => void
  onCreate: () => void
}

const VirtualMatchList: React.FC<Props> = ({
  rows,
  hands,
  deckOptions,
  onEdit,
  onDelete,
  onSetDeck,
  hasMore,
  isLoadingMore,
  isInitialLoading,
  loadError,
  hasAnyMatch,
  onLoadMore,
  onRetry,
  onCreate
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollbarRef = useRef<HTMLDivElement>(null)
  const scrollbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index].id,
    estimateSize: () => ROW_HEIGHT,
    // One extra viewport edge is enough to avoid blank rows while keeping the
    // per-scroll render cost low.
    overscan: 4
  })

  const virtualItems = virtualizer.getVirtualItems()
  const lastIndex = virtualItems[virtualItems.length - 1]?.index

  const updateScrollbar = useCallback((visible: boolean) => {
    const element = scrollRef.current
    const thumb = scrollbarRef.current
    if (!element || !thumb) return

    const { clientHeight, scrollHeight, scrollTop } = element
    if (scrollHeight <= clientHeight) {
      thumb.style.opacity = '0'
      return
    }

    const trackInset = 6
    const trackHeight = clientHeight - trackInset * 2
    const height = Math.max(32, (clientHeight / scrollHeight) * trackHeight)
    const travel = trackHeight - height
    const progress = scrollTop / (scrollHeight - clientHeight)
    // The scrollbar is visual-only. Updating it directly avoids a React render
    // for every browser scroll event, leaving the virtualizer as the sole
    // scroll-driven render path.
    thumb.style.height = `${height}px`
    thumb.style.transform = `translate3d(0, ${trackInset + travel * progress}px, 0)`
    thumb.style.opacity = visible ? '0.72' : '0'
  }, [])

  const handleScroll = useCallback(() => {
    updateScrollbar(true)
    if (scrollbarTimerRef.current) clearTimeout(scrollbarTimerRef.current)
    scrollbarTimerRef.current = setTimeout(() => updateScrollbar(false), 850)
  }, [updateScrollbar])

  useEffect(() => {
    updateScrollbar(false)
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => updateScrollbar(false))
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (scrollbarTimerRef.current) clearTimeout(scrollbarTimerRef.current)
    }
  }, [rows.length, updateScrollbar])

  // 有錯就停：失敗的那一頁 hasMore 仍是 true，不擋的話會一直重打同一個失敗的請求。
  // 要不要再試交給下面那顆「重試」。
  useEffect(() => {
    if (lastIndex == null || loadError) return
    if (lastIndex >= rows.length - LOAD_MORE_THRESHOLD && hasMore && !isLoadingMore) {
      onLoadMore()
    }
  }, [lastIndex, rows.length, hasMore, isLoadingMore, loadError, onLoadMore])

  // 換條件時舊的列先留著；新的第一頁一落地就回到頂端，從第一筆開始讀。
  const refreshing = isInitialLoading && rows.length > 0
  const wasRefreshingRef = useRef(false)
  useEffect(() => {
    if (wasRefreshingRef.current && !isInitialLoading) scrollRef.current?.scrollTo({ top: 0 })
    wasRefreshingRef.current = refreshing
  }, [isInitialLoading, refreshing])

  if (isInitialLoading && rows.length === 0) {
    return (
      <Box display="flex" justifyContent="center" py={6}>
        <CircularProgress size={28} />
      </Box>
    )
  }

  if (loadError && rows.length === 0) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            重試
          </Button>
        }
      >
        {loadError}
      </Alert>
    )
  }

  if (rows.length === 0) {
    // 預設範圍是「今天」，全新的使用者一打開就落在這裡；叫他放寬條件是答錯了
    // 問題。所以先分清楚是篩光了，還是根本還沒有任何一筆。
    if (hasAnyMatch === false) {
      return (
        <EmptyState
          title="還沒有對局"
          icon={<ListAltIcon sx={{ fontSize: 40, opacity: 0.6 }} />}
          description="開啟遊戲對戰後會自動記錄每一場，也可以手動新增。"
          action={
            <SoftButton
              size="small"
              tone="primary"
              startIcon={<AddIcon fontSize="small" />}
              onClick={onCreate}
            >
              新增紀錄
            </SoftButton>
          }
        />
      )
    }
    // 和分析器共用同一塊空狀態：兩頁問的是同一個問題，答案不該長得不一樣。
    return (
      <EmptyState description="這段時間沒有符合條件的對局。請放寬時間範圍，或移除部分進階條件。" />
    )
  }

  return (
    <Box sx={{ position: 'relative', height: '100%', minHeight: 0 }}>
      {refreshing && <LoadingStatus />}
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        // 舊結果淡下去但仍可操作：它們都是真的對局，點進去編輯或刪除不會錯。
        aria-busy={refreshing}
        sx={{
          height: '100%',
          opacity: refreshing ? 0.55 : 1,
          transition: 'opacity 160ms ease-out',
          overflowY: 'auto',
          overscrollBehaviorY: 'contain',
          scrollbarWidth: 'none',
          '@keyframes match-list-loading-in': {
            from: { opacity: 0, transform: 'translateY(-4px)' },
            to: { opacity: 1, transform: 'translateY(0)' }
          },
          '&::-webkit-scrollbar': {
            display: 'none'
          }
        }}
      >
        {/* Height in `style` for the same reason as each row's position below:
            it changes with every page loaded, and `sx` would keep each value. */}
        <Box sx={{ position: 'relative' }} style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((item) => {
            const match = rows[item.index]
            return (
              <Box
                key={match.id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                // The position goes in `style`, not `sx`: every value in `sx`
                // becomes a CSS class that is never removed, so each new scroll
                // offset left one more rule behind - about one per row scrolled
                // past, for as long as the window stayed open.
                style={{ transform: `translate3d(0, ${item.start}px, 0)` }}
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  pb: 1.5,
                  willChange: 'transform',
                  contain: 'layout paint style',
                  backfaceVisibility: 'hidden'
                }}
              >
                <MatchCard
                  match={match}
                  hand={hands.get(match.id)}
                  deckOptions={deckOptions}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onSetDeck={onSetDeck}
                />
              </Box>
            )
          })}
        </Box>

        {isLoadingMore && (
          <Box
            display="flex"
            justifyContent="center"
            py={2}
            sx={{ animation: 'match-list-loading-in 180ms ease-out both' }}
          >
            <CircularProgress size={20} />
          </Box>
        )}
        {!hasMore && !refreshing && !loadError && (
          <Box display="flex" justifyContent="center" py={2}>
            <Typography variant="caption" color="text.secondary">
              已無更多對局
            </Typography>
          </Box>
        )}
        {loadError && rows.length > 0 && (
          <Alert
            severity="warning"
            sx={{ mx: 1, mb: 1 }}
            action={
              // 只重抓失敗的那一頁，不把整份清單重載回頂端。
              <Button color="inherit" size="small" onClick={onLoadMore}>
                重試
              </Button>
            }
          >
            {loadError}
          </Alert>
        )}
      </Box>
      <Box
        aria-hidden
        sx={{
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          right: 2,
          width: 7,
          height: '100%',
          zIndex: 2
        }}
      >
        <Box
          ref={scrollbarRef}
          sx={{
            position: 'absolute',
            width: '100%',
            minHeight: 32,
            borderRadius: 999,
            opacity: 0,
            backgroundColor: 'rgba(197, 215, 238, 0.72)',
            boxShadow: '0 1px 5px rgba(0,0,0,0.28)',
            willChange: 'transform, opacity',
            transition: 'opacity 360ms ease-out, background-color 140ms ease-out'
          }}
        />
      </Box>
    </Box>
  )
}

export default VirtualMatchList
