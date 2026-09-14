/**
 * The 起手 card table: one line per card, in the order the contract declares
 * its fields - identity, keep rate, deal-rate check, dealt comparison. Each
 * section can be absent while the next is not, and each absent section is
 * drawn as the KIND of absence it is (`MissingPill`), never as a dash.
 *
 * Fixed column widths for the same reason `CardsTable` has them: a number must
 * sit at the same x on every line. The card cell is the only elastic one.
 *
 * # A chart with a card list down the side
 *
 * Every numeric column is bar-first (see `cells.tsx`): the bar takes the
 * width, the digits follow in a narrow fixed column. Read down any column and
 * the shape is there before the numbers are - a keep-rate column full of long
 * fills is a deck the player trusts, a comparison column leaning right is a
 * deck whose openers matter. The header explanations that used to live in the
 * sort buttons' tooltips are now one ⓘ beside each label (`InfoHint`), which
 * is the app's one gesture for "hover if you want the reason".
 *
 * Sorting on 發到 vs 沒發到 ranks only rows whose `confidence` is `'sortable'`.
 * The rest sink as a block under a divider that says how many and, on its ⓘ,
 * why; a user should never have to guess why the biggest number is not on top.
 */
import { Box, Skeleton, Stack, Tooltip, Typography } from '@mui/material'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import React from 'react'

import { OPENING_THRESHOLDS, type OpeningCardStat } from '@shared/openingStats'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import InfoHint from '@renderer/components/Common/InfoHint'
import { CostBadge } from '@renderer/components/Cards/CardsTable'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import {
  BannerArt,
  CautionMark,
  DiffCell,
  Digits,
  DivergingBar,
  Hint,
  MissingPill,
  RateCell,
  SampleOnly
} from './cells'
import type { OpeningRow, OpeningSort, OpeningSortKey } from './openingFilterState'
import {
  fmtDelta,
  fmtPct,
  lowRecognised,
  missingFor,
  NUMERIC,
  recognisedCaution,
  remainingFor,
  sampleFor
} from './openingFormat'

/** Column widths, in px. The card column takes what is left. */
const COST_W = 44
const DEALT_W = 56
const KEEP_W = 190
const DEAL_W = 176
const CMP_W = 230

const COLUMNS = `${COST_W}px minmax(0, 1fr) ${DEALT_W}px ${KEEP_W}px ${DEAL_W}px ${CMP_W}px`

/**
 * ±this many percentage points fill the deal-rate track.
 *
 * Deal rates for 1–3 copies sit between 10% and 30%, so a deviation of 15
 * points is already "the card is nearly never seen" and pinning there keeps
 * an ordinary ±3 visible as a small nub rather than a hairline.
 */
const DEAL_SPAN = 15

/* ---------------------------------------------------------------- cells */

function KeepCell({ stat }: { stat: OpeningCardStat }): React.JSX.Element {
  const caution = lowRecognised(stat) ? recognisedCaution(stat.recognisedShare ?? 0) : null
  if (stat.keepRate) {
    // The anchor is the average keep rate a player might expect, and there is
    // no defensible number for that, so there is no anchor: the fill and the
    // whisker alone carry the value and its uncertainty.
    return <RateCell rate={stat.keepRate} label="保留率" anchor={null} emphasis caution={caution} />
  }
  const kind = missingFor(stat, 'keep')
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <MissingPill
        kind={kind}
        sample={sampleFor(stat, 'keep')}
        remaining={remainingFor(stat, 'keep')}
      />
      {caution && <CautionMark title={caution} />}
    </Box>
  )
}

/**
 * Observed against expected, as a deviation from an anchor.
 *
 * The first pass printed `14% / 期望 30%` and asked the reader to subtract.
 * Now the expected rate is the axis and the observed rate is a bar growing
 * away from it: a deck where the recogniser is fine is a column of stubs, and
 * a card it keeps missing is one long bar to the left. The sort on this column
 * is the same quantity (observed minus expected), so the bar and the order
 * agree.
 *
 * The sign is not good/bad - being dealt a card more often than the deck
 * predicts is luck - so the bar is grey until `dealRateSuspect`, and then the
 * whole cell turns warning-tinted with a full-size mark. It is the only signal
 * in the app that the recogniser is missing a specific card, so it must be
 * impossible to scroll past.
 */
function DealRateCell({ stat }: { stat: OpeningCardStat }): React.JSX.Element {
  if (stat.observedDealRate === null || stat.expectedDealRate === null) {
    const kind = missingFor(stat, 'deal')
    return (
      <MissingPill
        kind={kind}
        sample={sampleFor(stat, 'deal')}
        remaining={remainingFor(stat, 'deal')}
      />
    )
  }
  const belowCheck = stat.eligible < OPENING_THRESHOLDS.dealCheck
  const deviation = stat.observedDealRate - stat.expectedDealRate
  const suspect = stat.dealRateSuspect
  const tip = (
    <Box sx={{ ...NUMERIC, minWidth: 220 }}>
      <Typography variant="caption" component="div">
        實際發到 {fmtPct(stat.observedDealRate)}（{stat.eligible} 場有牌組且四張全辨識）
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary">
        牌組帶 {stat.copies?.toFixed(1) ?? '?'} 張時，理論上 {fmtPct(stat.expectedDealRate)}{' '}
        的起手會有它
      </Typography>
      {suspect && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, color: 'warning.light' }}>
          差得比運氣能解釋的多。這通常是辨識漏掉了這張卡 -
          異畫、閃卡最常見。它在手上的場次會被算成「沒發到」，所以這一列的其他數字也別太信。
        </Typography>
      )}
      {belowCheck && !suspect && (
        <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
          不到 {OPENING_THRESHOLDS.dealCheck} 場，還不能拿來懷疑辨識。
        </Typography>
      )}
    </Box>
  )
  return (
    <Tooltip title={tip} placement="top" slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        data-testid={suspect ? 'opening-deal-suspect' : undefined}
        sx={{
          minWidth: 0,
          cursor: 'help',
          // The alarm state gets its own surface: a tinted, bordered cell that
          // breaks the row's rhythm. Colour on the bar alone was tried and
          // was not enough - a grey column with one amber bar in it reads as
          // a data point, not an alarm.
          ...(suspect && {
            mx: -0.75,
            px: 0.75,
            py: 0.5,
            borderRadius: 1,
            bgcolor: (t) => `${t.palette.warning.main}1f`,
            border: '1px solid',
            borderColor: (t) => `${t.palette.warning.main}66`
          })
        }}
      >
        {suspect && (
          <WarningAmberRoundedIcon
            aria-label="發到率遠低於牌組能給的，很可能是這張卡認不出來"
            sx={{ fontSize: 18, color: 'warning.main', flexShrink: 0 }}
          />
        )}
        <DivergingBar
          value={deviation}
          lo={null}
          hi={null}
          span={DEAL_SPAN}
          muted={belowCheck && !suspect}
          height={suspect ? 9 : 6}
          tone={suspect ? 'warning.main' : belowCheck ? 'text.disabled' : 'text.secondary'}
        />
        <Digits
          primary={fmtDelta(deviation, 0)}
          secondary={`n=${stat.eligible}`}
          colour={suspect ? 'warning.light' : belowCheck ? 'text.disabled' : 'text.secondary'}
          emphasis={suspect}
          width={44}
        />
      </Stack>
    </Tooltip>
  )
}

function CompareCell({ stat, sortable }: { stat: OpeningCardStat; sortable: boolean }) {
  const caution = lowRecognised(stat) ? recognisedCaution(stat.recognisedShare ?? 0) : null
  // `hidden` is the rule: whatever the handler put in the arms, the cell prints
  // the sample sizes. `diff === null` with `shown` should not happen, and is
  // treated the same way rather than crashing on a contract the handler bent.
  if (stat.confidence === 'hidden' || stat.diff === null || !stat.dealtWr || !stat.notDealtWr) {
    const kind = missingFor(stat, 'compare')
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {kind === 'low-sample' ? (
          <SampleOnly
            sample={sampleFor(stat, 'compare')}
            what="勝率差"
            remaining={remainingFor(stat, 'compare')}
          />
        ) : (
          <MissingPill kind={kind} />
        )}
        {caution && <CautionMark title={caution} />}
      </Box>
    )
  }
  return (
    <DiffCell
      diff={stat.diff}
      lo={stat.diffLo}
      hi={stat.diffHi}
      dealt={stat.dealtWr}
      notDealt={stat.notDealtWr}
      sortable={sortable}
      caution={caution}
    />
  )
}

/* ------------------------------------------------------------------ row */

function CardLine({
  row,
  showImages,
  selected,
  onSelect
}: {
  row: OpeningRow
  showImages: boolean
  selected: boolean
  onSelect: (row: OpeningRow) => void
}): React.JSX.Element {
  const { stat } = row

  return (
    <Box
      role="button"
      tabIndex={0}
      data-testid={`opening-row-${stat.cardId}`}
      data-confidence={stat.confidence}
      data-missing={stat.missing ?? undefined}
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
        minHeight: 50,
        py: 0.75,
        cursor: 'pointer',
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: selected ? 'action.selected' : 'transparent',
        transition: 'background-color .14s',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
        '&:last-of-type': { borderBottom: 'none' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
      }}
    >
      <CostBadge cost={stat.cost} />

      {/* Name only. Rarity and "中立" used to sit under the name as a second
          line; the class icon already says neutral, and rarity has no bearing
          on the mulligan - it is still in the drawer for whoever wants it. */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        {showImages && <BannerArt hash={stat.bannerHash} alt="" />}
        <ClassIcon id={stat.className} size={18} />
        <Typography variant="body2" fontWeight={700} noWrap title={stat.name} sx={{ minWidth: 0 }}>
          {stat.name}
        </Typography>
      </Stack>

      {/* 被發到：the count alone. Kept-count is in the tooltip; the keep-rate
          column beside it is that same ratio drawn. Zero is zero, not blank. */}
      <Tooltip
        title={
          stat.dealt > 0
            ? `換前四張裡有它 ${stat.dealt} 次，留下 ${stat.kept} 次、換掉 ${stat.dealt - stat.kept} 次`
            : '換前四張裡從來沒認出過它'
        }
        placement="top"
        disableInteractive
      >
        <Typography
          variant="body2"
          noWrap
          sx={{
            ...NUMERIC,
            textAlign: 'right',
            fontSize: 14,
            fontWeight: 800,
            cursor: 'help',
            color: stat.dealt === 0 ? 'text.disabled' : 'text.primary'
          }}
        >
          {stat.dealt}
        </Typography>
      </Tooltip>

      <KeepCell stat={stat} />
      <DealRateCell stat={stat} />
      <CompareCell stat={stat} sortable={row.sortable} />
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
  hint,
  hintLabel,
  lock
}: {
  label: string
  sortKey?: OpeningSortKey
  sort: OpeningSort
  onSort: (key: OpeningSortKey) => void
  align?: 'left' | 'right'
  /** The column's explanation, behind an ⓘ beside the label. */
  hint?: React.ReactNode
  hintLabel?: string
  /** A small lock beside the label: this sort ranks only part of the table. */
  lock?: boolean
}): React.JSX.Element {
  const active = sortKey !== undefined && sort.key === sortKey
  // The ⓘ is a sibling of the sort button, not a child: a focusable span inside
  // a button is two tab stops in one control and screen readers announce it
  // as neither.
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 0.5,
        minWidth: 0
      }}
    >
      <Box
        component={sortKey ? 'button' : 'div'}
        type={sortKey ? 'button' : undefined}
        onClick={sortKey ? () => onSort(sortKey) : undefined}
        aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : undefined}
        sx={{
          all: 'unset',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.35,
          minWidth: 0,
          cursor: sortKey ? 'pointer' : 'default',
          color: active ? 'text.primary' : 'text.disabled',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          '&:hover': sortKey ? { color: 'text.primary' } : undefined,
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            borderRadius: 0.5
          }
        }}
      >
        <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </Box>
        {lock && <LockOutlinedIcon sx={{ fontSize: 12, flexShrink: 0, opacity: 0.8 }} />}
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
      {hint && <InfoHint title={hint} label={hintLabel ?? `${label}的說明`} size={15} />}
    </Box>
  )
}

/* ---------------------------------------------------------------- table */

export type OpeningTableProps = {
  rows: OpeningRow[]
  sort: OpeningSort
  onSort: (key: OpeningSortKey) => void
  /** Index where the unranked block starts under a difference sort, or -1. */
  unrankedFrom: number
  showImages: boolean
  selectedKey: string | null
  onSelect: (row: OpeningRow) => void
  loading: boolean
  emptyText: string
}

export default function OpeningTable({
  rows,
  sort,
  onSort,
  unrankedFrom,
  showImages,
  selectedKey,
  onSelect,
  loading,
  emptyText
}: OpeningTableProps): React.JSX.Element {
  const unrankedCount = unrankedFrom >= 0 ? rows.length - unrankedFrom : 0
  return (
    <Box data-testid="opening-table" sx={{ minWidth: 0, overflowX: 'auto' }}>
      <Box sx={{ minWidth: 960 }}>
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
            label="發到"
            sortKey="dealt"
            align="right"
            sort={sort}
            onSort={onSort}
            hint={<Hint>換前四張裡認出這張卡的次數。滑到數字上看留下幾次。</Hint>}
          />
          <HeaderCell
            label="保留率"
            sortKey="keepRate"
            sort={sort}
            onSort={onSort}
            hint={
              <Hint>
                被發到的時候，留下來的比例。這是這頁最單純的數字：它描述你的決定，不預測結果，所以幾十次就能看。不到{' '}
                {OPENING_THRESHOLDS.keepRate} 次只印 n。
              </Hint>
            }
          />
          <HeaderCell
            label="發到率 − 期望"
            sortKey="dealRate"
            sort={sort}
            onSort={onSort}
            hint={
              <Hint>
                實際被發到的比例，減掉依牌組張數算出來的理論值；直線是理論值，長條往左是比理論少、往右是比理論多。這一欄其實是辨識的警報器：一張老是認不出來的卡，發到率會掉到牌組不可能給的水準，那時整格會變成橘色。
              </Hint>
            }
          />
          <HeaderCell
            label="發到 vs 沒發到"
            sortKey="diff"
            sort={sort}
            onSort={onSort}
            lock
            hint={
              <Hint>
                發到這張卡的對局勝率，減去牌組裡有它但沒發到的對局勝率（已向零收縮）。起手四張是隨機發的，所以這是公平的比較。兩邊各不到{' '}
                {OPENING_THRESHOLDS.wrShow} 場只印 n；各不到 {OPENING_THRESHOLDS.wrSort}{' '}
                場可以看但不參與排序，排序時整塊沉到分隔線底下。
              </Hint>
            }
          />
        </Box>

        {loading && rows.length === 0 ? (
          <Stack spacing={0} sx={{ p: 1 }}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton
                key={i}
                variant="rectangular"
                height={48}
                sx={{ my: 0.5, borderRadius: 1 }}
              />
            ))}
          </Stack>
        ) : rows.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            data-testid="opening-empty"
            sx={{ px: 2, py: 4, textAlign: 'center', maxWidth: 560, mx: 'auto' }}
          >
            {emptyText}
          </Typography>
        ) : (
          rows.map((row, index) => (
            <React.Fragment key={row.key}>
              {index === unrankedFrom && (
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  data-testid="opening-unranked-divider"
                  sx={{
                    px: 2,
                    py: 0.6,
                    bgcolor: 'action.hover',
                    borderBottom: '1px solid',
                    borderColor: 'divider'
                  }}
                >
                  <LockOutlinedIcon sx={{ fontSize: 13, color: 'text.disabled' }} />
                  <Typography variant="caption" color="text.secondary" sx={NUMERIC}>
                    以下 {unrankedCount} 張不參與排序
                  </Typography>
                  <InfoHint
                    label="為什麼這些卡不參與排序"
                    title={
                      <Hint>
                        這些卡的「發到 vs 沒發到」兩邊各不到 {OPENING_THRESHOLDS.wrSort}{' '}
                        場，差值還是雜訊多於訊號，拿來排名會排出資料撐不起來的順序。它們照被發到次數排列。
                      </Hint>
                    }
                  />
                </Stack>
              )}
              <CardLine
                row={row}
                showImages={showImages}
                selected={row.key === selectedKey}
                onSelect={onSelect}
              />
            </React.Fragment>
          ))
        )}
      </Box>
    </Box>
  )
}
