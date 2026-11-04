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
import { EASE, MOTION, motion } from '../../Common/motion'

const LOAD_MORE_THRESHOLD = 5
/** 卡片內容 + 上下框線 + 列間距，每張卡片都一樣高 */
const ROW_HEIGHT = MATCH_CARD_CONTENT_HEIGHT + 2 + 12
/** Gap between the thumb's travel and the list's top and bottom edges. */
const THUMB_INSET = 6
/**
 * Width kept clear on the right for the scrollbar. Cards end before it, so the
 * bar never sits over a card's edit and delete buttons and can always be grabbed.
 */
const SCROLLBAR_GUTTER = 14

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
  const scrollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Pointer over the list: the bar shows faintly so it can be found and grabbed. */
  const hoverRef = useRef(false)
  /** An in-progress thumb drag: where the pointer and the scroll position started. */
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index].id,
    estimateSize: () => ROW_HEIGHT,
    // Enough rows past each edge that a fast flick of the wheel does not
    // outrun rendering and show a blank strip; rows are cheap (~50 nodes).
    overscan: 6
  })

  const virtualItems = virtualizer.getVirtualItems()
  const lastIndex = virtualItems[virtualItems.length - 1]?.index

  /** Thumb size and the distance it can travel, from the list's current size. */
  const thumbGeometry = useCallback(() => {
    const element = scrollRef.current
    if (!element) return null
    const { clientHeight, scrollHeight } = element
    if (scrollHeight <= clientHeight) return null
    const trackHeight = clientHeight - THUMB_INSET * 2
    const height = Math.max(32, (clientHeight / scrollHeight) * trackHeight)
    return { height, travel: trackHeight - height, range: scrollHeight - clientHeight }
  }, [])

  /**
   * Position and show the thumb. Written to the DOM directly rather than through
   * React state, so a scroll event never causes a render of its own and the
   * virtualizer stays the only scroll-driven render path.
   *
   * Three levels: hidden when the pointer is elsewhere, faint while the pointer
   * is over the list (so the bar can be found and grabbed), solid while
   * scrolling or dragging.
   */
  const updateScrollbar = useCallback(
    (active: boolean) => {
      const element = scrollRef.current
      const thumb = scrollbarRef.current
      if (!element || !thumb) return
      const geometry = thumbGeometry()
      if (!geometry) {
        thumb.style.opacity = '0'
        return
      }
      const progress = element.scrollTop / geometry.range
      thumb.style.height = `${geometry.height}px`
      thumb.style.transform = `translate3d(0, ${THUMB_INSET + geometry.travel * progress}px, 0)`
      thumb.style.opacity = dragRef.current
        ? '0.9'
        : active
          ? '0.72'
          : hoverRef.current
            ? '0.36'
            : '0'
    },
    [thumbGeometry]
  )

  const handleScroll = useCallback(() => {
    updateScrollbar(true)
    if (scrollbarTimerRef.current) clearTimeout(scrollbarTimerRef.current)
    scrollbarTimerRef.current = setTimeout(() => updateScrollbar(false), 850)
    // While the list moves, cards ignore the pointer: otherwise every card that
    // passes under a resting cursor runs its hover colour and opens its
    // tooltips, which reads as the list flickering. Restored a moment after
    // the last scroll event.
    const element = scrollRef.current
    if (!element) return
    element.dataset.scrolling = ''
    if (scrollingTimerRef.current) clearTimeout(scrollingTimerRef.current)
    scrollingTimerRef.current = setTimeout(() => delete element.dataset.scrolling, 150)
  }, [updateScrollbar])

  const handleThumbPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = scrollRef.current
      if (!element) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { startY: event.clientY, startTop: element.scrollTop }
      updateScrollbar(true)
    },
    [updateScrollbar]
  )

  const handleThumbPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const element = scrollRef.current
      const geometry = thumbGeometry()
      if (!drag || !element || !geometry || geometry.travel <= 0) return
      element.scrollTop =
        drag.startTop + ((event.clientY - drag.startY) * geometry.range) / geometry.travel
    },
    [thumbGeometry]
  )

  const handleThumbPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return
      event.currentTarget.releasePointerCapture(event.pointerId)
      dragRef.current = null
      handleScroll()
    },
    [handleScroll]
  )

  /** A click on the track beside the thumb pages towards the click, like a native bar. */
  const handleTrackPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current
    const thumb = scrollbarRef.current
    if (!element || !thumb) return
    const above = event.clientY < thumb.getBoundingClientRect().top
    element.scrollBy({ top: (above ? -1 : 1) * element.clientHeight * 0.9, behavior: 'smooth' })
  }, [])

  const handlePointerEnter = useCallback(() => {
    hoverRef.current = true
    updateScrollbar(false)
  }, [updateScrollbar])

  const handlePointerLeave = useCallback(() => {
    hoverRef.current = false
    if (!dragRef.current) updateScrollbar(false)
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
      if (scrollingTimerRef.current) clearTimeout(scrollingTimerRef.current)
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
    <Box
      // Reaches into the page's right padding by the gutter's width, so the
      // cards still line up with the toolbar above and the bar sits in the margin.
      sx={{ position: 'relative', height: '100%', minHeight: 0, mr: `-${SCROLLBAR_GUTTER}px` }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {refreshing && <LoadingStatus />}
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        // 舊結果淡下去但仍可操作：它們都是真的對局，點進去編輯或刪除不會錯。
        aria-busy={refreshing}
        // Focusable, so the arrow keys, PageUp/PageDown and Home/End scroll the
        // list once it has been clicked or tabbed to.
        tabIndex={0}
        aria-label="對局列表"
        sx={{
          height: '100%',
          outline: 'none',
          '&:focus-visible': {
            boxShadow: 'inset 0 0 0 2px rgba(144,202,249,0.45)',
            borderRadius: 1
          },
          '&[data-scrolling] [data-index]': { pointerEvents: 'none' },
          opacity: refreshing ? 0.55 : 1,
          transition: motion(['opacity'], 'base'),
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
        <Box
          sx={{ position: 'relative', mr: `${SCROLLBAR_GUTTER}px` }}
          style={{ height: virtualizer.getTotalSize() }}
        >
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
            sx={{ animation: `match-list-loading-in ${MOTION.base}ms ${EASE} both` }}
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
      {/* The track: clicking beside the thumb pages, the thumb itself drags. */}
      <Box
        aria-hidden
        onPointerDown={handleTrackPointerDown}
        sx={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: SCROLLBAR_GUTTER,
          height: '100%',
          zIndex: 2,
          // The thumb widens when the pointer is on the track, so it reads as
          // something that can be grabbed, not only as a position indicator.
          '&:hover > div': { width: 8 }
        }}
      >
        <Box
          ref={scrollbarRef}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={handleThumbPointerUp}
          onPointerCancel={handleThumbPointerUp}
          sx={{
            position: 'absolute',
            right: 3,
            width: 6,
            cursor: 'default',
            touchAction: 'none',
            minHeight: 32,
            borderRadius: 999,
            opacity: 0,
            backgroundColor: 'rgba(197, 215, 238, 0.72)',
            boxShadow: '0 1px 5px rgba(0,0,0,0.28)',
            willChange: 'transform, opacity',
            transition:
              motion(['opacity', 'width'], 'base') + ', ' + motion(['background-color'], 'fast')
          }}
        />
      </Box>
    </Box>
  )
}

export default VirtualMatchList
