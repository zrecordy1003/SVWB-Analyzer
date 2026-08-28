import React, { useCallback, useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'
import MatchCard, { MATCH_CARD_CONTENT_HEIGHT } from './MatchCard'
import type { MatchRow } from '../types'

const LOAD_MORE_THRESHOLD = 5
/** 卡片內容 + 上下框線 + 列間距，每張卡片都一樣高 */
const ROW_HEIGHT = MATCH_CARD_CONTENT_HEIGHT + 2 + 12

type Props = {
  rows: MatchRow[]
  onEdit: (id: number) => void
  onDelete: (id: number) => void
  hasMore: boolean
  isLoadingMore: boolean
  isInitialLoading: boolean
  loadError: string | null
  onLoadMore: () => void
  onRetry: () => void
}

const VirtualMatchList: React.FC<Props> = ({
  rows,
  onEdit,
  onDelete,
  hasMore,
  isLoadingMore,
  isInitialLoading,
  loadError,
  onLoadMore,
  onRetry
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

  useEffect(() => {
    if (lastIndex == null) return
    if (lastIndex >= rows.length - LOAD_MORE_THRESHOLD && hasMore && !isLoadingMore) {
      onLoadMore()
    }
  }, [lastIndex, rows.length, hasMore, isLoadingMore, onLoadMore])

  if (isInitialLoading) {
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
    return (
      <Box display="flex" justifyContent="center" py={6}>
        <Typography color="text.secondary">無符合資料</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ position: 'relative', height: '100%', minHeight: 0 }}>
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          height: '100%',
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
        <Box sx={{ position: 'relative', height: virtualizer.getTotalSize() }}>
          {virtualItems.map((item) => {
            const match = rows[item.index]
            return (
              <Box
                key={match.id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translate3d(0, ${item.start}px, 0)`,
                  pb: 1.5,
                  willChange: 'transform',
                  contain: 'layout paint style',
                  backfaceVisibility: 'hidden'
                }}
              >
                <MatchCard match={match} onEdit={onEdit} onDelete={onDelete} />
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
        {!hasMore && (
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
              <Button color="inherit" size="small" onClick={onRetry}>
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
