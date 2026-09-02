/**
 * The 卡片 page's table: one line per (class, card).
 *
 * Fixed column widths throughout, for the same reason `DeckRow` has them: the
 * eye runs down a column, so the same kind of number must sit at the same x on
 * every line. The card cell is the only elastic one and it is the only one
 * that truncates - a number that gets cut to「18勝…」is a bug, a long card name
 * with an ellipsis and a title is not.
 *
 * Two numbers per line, always both, and they are labelled for what they
 * measure:
 *
 * - 勝率 - the record of the decks that carried the card. Not the card's win
 *   rate; there is no event data to have one (research doc 2.1).
 * - 相對不帶它 - that record minus the record of the same class's decks
 *   without it. Greyed when the comparison side is under the low-sample line,
 *   because a difference against three games is not a difference.
 */
import { Box, Skeleton, Stack, Tooltip, Typography } from '@mui/material'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import React from 'react'

import { CARD_STATS_LOW_SAMPLE } from '@shared/cardStats'
import { cardImageUrl } from '@shared/deckImport'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import { formatWithInterval } from '@renderer/components/Analyzer/confidence'

import type { CardRow, CardsSort, CardsSortKey } from './cardsFilterState'
import { fmtDelta, fmtRate, KIND_LABEL, RARITY_LABEL } from './cardsFormat'

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

/** Column widths, in px. The card column takes what is left. */
const COST_W = 44
const DECKS_W = 116
const GAMES_W = 76
const RATE_W = 176
const DELTA_W = 176

/** 費用、卡片、帶入的牌組、場次、勝率、相對不帶它 - six columns, no more. */
const COLUMNS = `${COST_W}px minmax(0, 1fr) ${DECKS_W}px ${GAMES_W}px ${RATE_W}px ${DELTA_W}px`

/** Same rule as `DeckRow`: green at or above half, red below. */
const rateTone = (rate: number, variant: 'light' | 'main'): string =>
  rate >= 50 ? `success.${variant}` : `error.${variant}`

/* --------------------------------------------------------------- pieces */

/** The round cost badge every card list in the app uses. */
export function CostBadge({ cost, size = 24 }: { cost: number | null; size?: number }) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        fontSize: size <= 24 ? 12 : 14,
        fontWeight: 800,
        color: '#dce9ff',
        bgcolor: 'rgba(90,130,215,0.28)',
        border: '1px solid rgba(140,180,255,0.35)',
        flexShrink: 0
      }}
    >
      {cost ?? '?'}
    </Box>
  )
}

function BannerArt({ hash, alt }: { hash: string | null; alt: string }) {
  const src = cardImageUrl('list', hash)
  const [failed, setFailed] = React.useState(false)
  if (!src || failed) {
    return <Box sx={{ width: 72, height: 20, borderRadius: 0.5, bgcolor: 'action.hover' }} />
  }
  return (
    <Box
      component="img"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{
        width: 72,
        height: 20,
        borderRadius: 0.5,
        objectFit: 'cover',
        // Portrait banners keep the character on the right; see `DeckRow`.
        objectPosition: '85% center',
        display: 'block'
      }}
    />
  )
}

/** A win-rate bar from zero, with the 50% mark - `DeckRow`'s bar plus MatchupBars' anchor. */
function RateBar({ rate, muted }: { rate: number | null; muted: boolean }) {
  return (
    <Box
      sx={{
        flex: 1,
        height: 4,
        borderRadius: 2,
        bgcolor: 'action.hover',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: '50%',
          borderLeft: '1px dashed',
          borderColor: 'text.disabled'
        }}
      />
      {rate !== null && (
        <Box
          sx={{
            width: `${Math.min(100, rate)}%`,
            height: '100%',
            bgcolor: muted ? 'text.disabled' : rateTone(rate, 'main')
          }}
        />
      )}
    </Box>
  )
}

/** A diverging bar from the centre: right is better than the baseline, left is worse. */
function DeltaBar({ delta, muted }: { delta: number | null; muted: boolean }) {
  // ±20 points fills half the bar; beyond that it is pinned - a 40-point gap
  // on eleven games does not need a longer bar to say "unreliable".
  const span = delta === null ? 0 : Math.min(50, (Math.abs(delta) / 20) * 50)
  return (
    <Box
      sx={{
        flex: 1,
        height: 4,
        borderRadius: 2,
        bgcolor: 'action.hover',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: '50%',
          borderLeft: '1px dashed',
          borderColor: 'text.disabled'
        }}
      />
      {delta !== null && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: delta >= 0 ? '50%' : `${50 - span}%`,
            width: `${span}%`,
            bgcolor: muted ? 'text.disabled' : delta >= 0 ? 'success.main' : 'error.main'
          }}
        />
      )}
    </Box>
  )
}

/* ------------------------------------------------------------------ row */

function CardLine({
  row,
  showImages,
  showClass,
  selected,
  onSelect
}: {
  row: CardRow
  showImages: boolean
  showClass: boolean
  selected: boolean
  onSelect: (row: CardRow) => void
}) {
  const { card } = row
  const meta = [
    card.kind ? KIND_LABEL[card.kind] : null,
    card.rarity ? RARITY_LABEL[card.rarity] : null
  ]
    .filter(Boolean)
    .join(' ・ ')

  const rateTooltip = (
    <Box sx={{ ...NUMERIC, minWidth: 220 }}>
      <Typography variant="caption" component="div">
        帶入時：{formatWithInterval(card.wins, card.total)}
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary">
        同職業不帶它：
        {card.without.total > 0
          ? formatWithInterval(card.without.wins, card.without.total)
          : '沒有這樣的對局'}
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary">
        平均帶 {card.copies.toFixed(1)} 張
      </Typography>
      {row.deltaLowSample && card.without.total > 0 && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, color: 'warning.light' }}>
          對照組不足 {CARD_STATS_LOW_SAMPLE} 場，差值只供參考。
        </Typography>
      )}
    </Box>
  )

  const deltaColor =
    row.delta === null
      ? 'text.disabled'
      : row.deltaLowSample
        ? 'text.disabled'
        : row.delta >= 0
          ? 'success.light'
          : 'error.light'

  const rateColorSx = row.rate === null ? 'text.disabled' : rateTone(row.rate, 'light')

  return (
    <Box
      role="button"
      tabIndex={0}
      data-testid={`cards-row-${card.cardId}`}
      data-class={row.myClass}
      data-low-sample={row.lowSample ? 'true' : undefined}
      aria-selected={selected}
      onClick={() => onSelect(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(row)
        }
      }}
      sx={{
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        columnGap: 1.5,
        alignItems: 'center',
        px: 2,
        minHeight: 48,
        py: 0.75,
        cursor: 'pointer',
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: selected ? 'action.selected' : 'transparent',
        // 開了「顯示樣本不足的卡」才看得到的列：灰階，還在，但先別把它讀成結論。
        opacity: row.lowSample ? 0.55 : 1,
        filter: row.lowSample ? 'grayscale(0.6)' : 'none',
        transition: 'background-color .14s',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
        '&:last-of-type': { borderBottom: 'none' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
      }}
    >
      <CostBadge cost={card.cost} />

      {/* 卡圖和名字同一欄：圖是卡片的一部分，不是另一個欄位。 */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        {showImages && <BannerArt hash={card.bannerHash} alt="" />}
        {showClass && <ClassIcon id={row.myClass} size={18} />}
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={700} noWrap title={card.name}>
            {card.name}
          </Typography>
          {meta && (
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {meta}
            </Typography>
          )}
        </Box>
      </Stack>

      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ ...NUMERIC, textAlign: 'right' }}
      >
        <Box component="span" sx={{ color: 'text.primary', fontWeight: 700 }}>
          {row.families}
        </Box>
        {' 副 · '}
        <Box component="span" sx={{ color: 'text.primary', fontWeight: 700 }}>
          {row.versions}
        </Box>
        {' 版'}
      </Typography>

      <Tooltip
        title={`${card.wins}勝 ${card.total - card.wins}敗`}
        placement="top"
        disableInteractive
      >
        <Typography
          variant="body2"
          noWrap
          sx={{ ...NUMERIC, textAlign: 'right', fontWeight: 700, cursor: 'help' }}
        >
          {card.total}
          <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400, ml: 0.4 }}>
            場
          </Box>
        </Typography>
      </Tooltip>

      {/* 勝率：數字 + 長條，兩者一起才看得出「多好」。 */}
      <Tooltip
        title={rateTooltip}
        placement="top"
        slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
      >
        <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, cursor: 'help' }}>
          <Typography
            sx={{
              ...NUMERIC,
              width: 60,
              flexShrink: 0,
              textAlign: 'right',
              fontSize: 15,
              fontWeight: 900,
              color: rateColorSx
            }}
          >
            {fmtRate(row.rate)}
          </Typography>
          <RateBar rate={row.rate} muted={row.lowSample} />
        </Stack>
      </Tooltip>

      {/* 相對不帶它：同一種畫法，長條從中間往兩邊長。 */}
      <Tooltip
        title={rateTooltip}
        placement="top"
        slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
      >
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          data-testid="cards-row-compare"
          sx={{ minWidth: 0, cursor: 'help' }}
        >
          <Typography
            sx={{
              ...NUMERIC,
              width: 60,
              flexShrink: 0,
              textAlign: 'right',
              fontSize: 15,
              fontWeight: 900,
              color: deltaColor
            }}
          >
            {fmtDelta(row.delta)}
          </Typography>
          <DeltaBar delta={row.delta} muted={row.deltaLowSample || row.lowSample} />
        </Stack>
      </Tooltip>
    </Box>
  )
}

/* --------------------------------------------------------------- header */

function HeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
  tooltip
}: {
  label: string
  sortKey?: CardsSortKey
  sort: CardsSort
  onSort: (key: CardsSortKey) => void
  align?: 'left' | 'right'
  tooltip?: string
}) {
  const active = sortKey !== undefined && sort.key === sortKey
  const inner = (
    <Box
      component={sortKey ? 'button' : 'div'}
      type={sortKey ? 'button' : undefined}
      onClick={sortKey ? () => onSort(sortKey) : undefined}
      aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : undefined}
      sx={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 0.25,
        width: '100%',
        minWidth: 0,
        cursor: sortKey ? 'pointer' : tooltip ? 'help' : 'default',
        color: active ? 'text.primary' : 'text.disabled',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        '&:hover': sortKey ? { color: 'text.primary' } : undefined
      }}
    >
      <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </Box>
      {active && (
        <ArrowDownwardRoundedIcon
          sx={{
            fontSize: 13,
            flexShrink: 0,
            transition: 'transform .18s',
            transform: sort.descending ? 'none' : 'rotate(180deg)'
          }}
        />
      )}
    </Box>
  )
  return tooltip ? (
    <Tooltip title={tooltip} placement="top">
      {inner}
    </Tooltip>
  ) : (
    inner
  )
}

/* ---------------------------------------------------------------- table */

export type CardsTableProps = {
  rows: CardRow[]
  sort: CardsSort
  onSort: (key: CardsSortKey) => void
  showImages: boolean
  /** 全部職業 - a class mark per line, since the same card can sit under two. */
  showClass: boolean
  selectedKey: string | null
  onSelect: (row: CardRow) => void
  loading: boolean
  /** Why the table is empty; the page knows, the table does not. */
  emptyText: string
}

export default function CardsTable({
  rows,
  sort,
  onSort,
  showImages,
  showClass,
  selectedKey,
  onSelect,
  loading,
  emptyText
}: CardsTableProps): React.JSX.Element {
  return (
    <Box data-testid="cards-table" sx={{ minWidth: 0, overflowX: 'auto' }}>
      <Box sx={{ minWidth: 720 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: COLUMNS,
            columnGap: 1.5,
            px: 2,
            py: 0.75,
            bgcolor: 'action.hover',
            borderBottom: '1px solid',
            borderColor: 'divider'
          }}
        >
          <HeaderCell label="費用" sortKey="cost" sort={sort} onSort={onSort} />
          <HeaderCell label="卡片" sortKey="name" sort={sort} onSort={onSort} />
          <HeaderCell
            label="帶入的牌組"
            align="right"
            sort={sort}
            onSort={onSort}
            tooltip="有幾副牌組、幾個版本的卡表帶了這張卡"
          />
          <HeaderCell label="場次" sortKey="total" align="right" sort={sort} onSort={onSort} />
          <HeaderCell
            label="勝率"
            sortKey="winRate"
            align="left"
            sort={sort}
            onSort={onSort}
            tooltip="帶著這張卡的牌組在這些對局裡的勝率。這是牌組的成績，不是卡片本身的 - 沒有抽牌資料。"
          />
          <HeaderCell
            label="相對不帶它"
            sortKey="delta"
            align="left"
            sort={sort}
            onSort={onSort}
            tooltip={`帶入時的勝率，減去同職業「沒帶這張卡」的牌組在同範圍內的勝率。對照組不足 ${CARD_STATS_LOW_SAMPLE} 場時灰階。`}
          />
        </Box>

        {loading && rows.length === 0 ? (
          <Stack spacing={0} sx={{ p: 1 }}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton
                key={i}
                variant="rectangular"
                height={40}
                sx={{ my: 0.5, borderRadius: 1 }}
              />
            ))}
          </Stack>
        ) : rows.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            data-testid="cards-empty"
            sx={{ px: 2, py: 4, textAlign: 'center' }}
          >
            {emptyText}
          </Typography>
        ) : (
          rows.map((row) => (
            <CardLine
              key={row.key}
              row={row}
              showImages={showImages}
              showClass={showClass}
              selected={row.key === selectedKey}
              onSelect={onSelect}
            />
          ))
        )}
      </Box>
    </Box>
  )
}
