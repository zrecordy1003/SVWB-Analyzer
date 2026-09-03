/**
 * A deck's 40 cards, laid out the way the game's own deck page does: large
 * portraits sorted by cost, filling however many rows the drawer's height
 * allows and running sideways from there.
 *
 * `DeckCardList`'s text rows and small-art grid are still what a version diff
 * or the builder's side panel wants - dense and vertical. This is for the one
 * place a user opens a deck just to *look* at it: cost curve and copy counts
 * read fastest when they are arranged exactly like the client every SVWB
 * player already has memorised, rather than invented fresh for this app.
 */
import { Box, Skeleton, Stack, Typography } from '@mui/material'
import { cardImageUrl, type StoredDeckCard } from '@shared/deckImport'
import React from 'react'

import CardTooltip from './CardTooltip'

/**
 * Wider than `DeckCardList`'s item type: this board shows full card art
 * (needs `imageHash`, not the banner crop) and feeds every card through
 * `CardTooltip`, which wants rarity/atk/life too.
 */
export type DeckCardBoardItem = Pick<
  StoredDeckCard,
  | 'cardId'
  | 'count'
  | 'name'
  | 'cost'
  | 'kind'
  | 'rarity'
  | 'atk'
  | 'life'
  | 'skillText'
  | 'imageHash'
>

/** The portal's own card art ratio (`PoolGrid` in the builder uses the same). */
const CARD_RATIO = 530 / 687
/** The row height picking `rowCount` aims for - not what a card ends up drawn at. */
const TARGET_ROW_HEIGHT = 166
const GAP = 8

/**
 * How many whole rows to lay out, and how tall each ends up.
 *
 * Two different problems, on purpose. Row COUNT is picked once from the
 * container's height divided by a target size - two rows at the app's
 * minimum window height, more once the window is taller - and then held
 * fixed: cards beyond that run sideways instead of a third row starting.
 * Row HEIGHT is whatever `100% / rowCount` comes out to, so those rows always
 * fill the container exactly rather than leaving a dead strip under the last
 * one when the height doesn't divide evenly by `TARGET_ROW_HEIGHT`. Column
 * width then follows the card art's own ratio, so a taller row makes a wider
 * card instead of a stretched one.
 */
function useBoardMetrics(containerRef: React.RefObject<HTMLElement | null>): {
  rowCount: number
  rowHeight: number
  columnWidth: number
} {
  // Guessed at two rows worth of height until the observer's first callback
  // lands, rather than 0 - the same default the drawer opens to, so there is
  // nothing to visibly correct a frame later in the common case.
  const [height, setHeight] = React.useState(TARGET_ROW_HEIGHT * 2 + GAP)

  React.useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height))
    observer.observe(el)
    return () => observer.disconnect()
  }, [containerRef])

  const rowCount = Math.max(1, Math.floor((height + GAP) / (TARGET_ROW_HEIGHT + GAP)))
  const rowHeight = (height - GAP * (rowCount - 1)) / rowCount
  return { rowCount, rowHeight, columnWidth: rowHeight * CARD_RATIO }
}

/** Missing cost sorts last rather than first - "unknown" is not "free". */
const costOf = (card: DeckCardBoardItem): number => card.cost ?? Number.POSITIVE_INFINITY

function sortByCost(cards: DeckCardBoardItem[]): DeckCardBoardItem[] {
  return [...cards].sort((a, b) => costOf(a) - costOf(b) || a.cardId - b.cardId)
}

function CardCell({
  card,
  showImages,
  width,
  height
}: {
  card: DeckCardBoardItem
  showImages: boolean
  width: number
  height: number
}) {
  const src = showImages ? cardImageUrl('card', card.imageHash) : null
  const [failed, setFailed] = React.useState(false)

  return (
    <CardTooltip card={card}>
      <Box
        sx={{
          position: 'relative',
          // Explicit, not `aspectRatio`: as a grid item this box is stretched
          // to fill its track by default, and a fixed size matching the
          // grid's own row/column tracks is what keeps every card the same
          // size instead of fighting the stretch.
          width,
          height,
          borderRadius: 1.5,
          overflow: 'hidden',
          bgcolor: 'rgba(0,0,0,0.35)',
          border: '1px solid rgba(255,255,255,0.08)'
        }}
      >
        {src && !failed ? (
          <Box
            component="img"
            src={src}
            alt={card.name}
            loading="lazy"
            onError={() => setFailed(true)}
            // `cover`, not `contain`: the deck page wants a wall of full-bleed
            // portraits, and the portal's own art has almost no margin to lose.
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          // No art (setting off, still loading, or the fetch failed): cost and
          // name are the only things identifying the card, so they're printed
          // here instead of being baked into a picture that isn't there.
          <Stack
            justifyContent="center"
            alignItems="center"
            spacing={0.75}
            sx={{ height: '100%', px: 1, textAlign: 'center' }}
          >
            <Box
              sx={{
                minWidth: 24,
                height: 24,
                px: 0.75,
                borderRadius: '50%',
                bgcolor: 'rgba(255,255,255,0.1)',
                fontSize: 13,
                fontWeight: 800,
                display: 'grid',
                placeItems: 'center'
              }}
            >
              {card.cost ?? '?'}
            </Box>
            <Typography variant="caption" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
              {card.name}
            </Typography>
          </Stack>
        )}

        {/* Only the copy count is overlaid - same convention as the builder's
            pool grid. Everything else a picture already tells you. */}
        <Box
          sx={{
            position: 'absolute',
            top: 6,
            right: 6,
            minWidth: 22,
            height: 22,
            px: 0.5,
            borderRadius: 1,
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            fontSize: 12,
            fontWeight: 900,
            boxShadow: '0 2px 8px rgba(0,0,0,.6)'
          }}
        >
          ×{card.count}
        </Box>
      </Box>
    </CardTooltip>
  )
}

export type DeckCardBoardProps = {
  cards: DeckCardBoardItem[]
  showImages: boolean
  loading?: boolean
  emptyText?: string
}

export default function DeckCardBoard({
  cards,
  showImages,
  loading,
  emptyText
}: DeckCardBoardProps) {
  // Measured on this wrapper regardless of which branch below is showing, so
  // the empty/loading states get a definite height to report and the real
  // grid isn't the only thing driving its own container's size.
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const { rowCount, rowHeight, columnWidth } = useBoardMetrics(containerRef)

  /**
   * The board only scrolls sideways (`overflowX: auto`, `overflowY: hidden`),
   * but a mouse wheel reports vertical delta - left as-is, scrolling over the
   * card wall does nothing. Redirects that delta into `scrollLeft` instead.
   *
   * A native listener with `{ passive: false }`, not `onWheel`: React attaches
   * wheel handlers as passive by default, so `preventDefault()` there is
   * silently ignored and the page behind the drawer scrolls too.
   */
  const attachWheelScroll = React.useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    if (!node) return
    const handleWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0 || node.scrollWidth <= node.clientWidth) return
      node.scrollLeft += e.deltaY
      e.preventDefault()
    }
    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [])

  if (cards.length === 0 && !loading) {
    return (
      <Box ref={containerRef} sx={{ height: '100%' }}>
        <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
          {emptyText ?? '這副牌組沒有卡表資料。用「新增牌組」貼上牌組代碼或分享連結就會有。'}
        </Typography>
      </Box>
    )
  }

  const boardSx = {
    height: '100%',
    display: 'grid',
    gridAutoFlow: 'column',
    gridTemplateRows: `repeat(${rowCount}, ${rowHeight}px)`,
    gridAutoColumns: `${columnWidth}px`,
    gap: `${GAP}px`,
    overflowX: 'auto',
    overflowY: 'hidden'
  } as const

  if (loading) {
    return (
      <Box ref={attachWheelScroll} sx={boardSx}>
        {Array.from({ length: rowCount * 6 }, (_, i) => (
          <Skeleton
            key={i}
            variant="rectangular"
            sx={{ width: columnWidth, height: rowHeight, borderRadius: 1.5 }}
          />
        ))}
      </Box>
    )
  }

  return (
    <Box ref={attachWheelScroll} sx={boardSx}>
      {sortByCost(cards).map((card) => (
        <CardCell
          key={card.cardId}
          card={card}
          showImages={showImages}
          width={columnWidth}
          height={rowHeight}
        />
      ))}
    </Box>
  )
}
