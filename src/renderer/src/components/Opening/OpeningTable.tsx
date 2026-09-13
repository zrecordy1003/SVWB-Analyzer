/**
 * The 起手 card table: one line per card, in the order the contract declares
 * its fields - identity, keep rate, deal-rate check, dealt comparison. Each
 * section can be absent while the next is not, and each absent section is
 * drawn as the KIND of absence it is (`MissingPill`), never as a dash.
 *
 * Fixed column widths for the same reason `CardsTable` has them: a number must
 * sit at the same x on every line. The card cell is the only elastic one.
 *
 * Sorting on 發到 vs 沒發到 ranks only rows whose `confidence` is `'sortable'`.
 * The rest sink as a block under a labelled divider. The header's tooltip says
 * so and the divider shows it; a user should never have to guess why the
 * biggest number is not on top.
 */
import { Box, Skeleton, Stack, Tooltip, Typography } from '@mui/material'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import React from 'react'

import { OPENING_THRESHOLDS, type OpeningCardStat, type Rate } from '@shared/openingStats'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import { CostBadge } from '@renderer/components/Cards/CardsTable'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import {
  BannerArt,
  CautionMark,
  DiffCell,
  IntervalBar,
  MissingPill,
  RateCell,
  SampleOnly
} from './cells'
import type { OpeningRow, OpeningSort, OpeningSortKey } from './openingFilterState'
import {
  fmtPct,
  lowRecognised,
  missingFor,
  NUMERIC,
  RARITY_LABEL,
  recognisedCaution,
  remainingFor,
  sampleFor
} from './openingFormat'

/** Column widths, in px. The card column takes what is left. */
const COST_W = 44
const DEALT_W = 88
const KEEP_W = 168
const DEAL_W = 150
const CMP_W = 260

const COLUMNS = `${COST_W}px minmax(0, 1fr) ${DEALT_W}px ${KEEP_W}px ${DEAL_W}px ${CMP_W}px`

/* ---------------------------------------------------------------- cells */

function KeepCell({ stat }: { stat: OpeningCardStat }): React.JSX.Element {
  const caution = lowRecognised(stat) ? recognisedCaution(stat.recognisedShare ?? 0) : null
  if (stat.keepRate) {
    // The anchor is the average keep rate a player might expect, and there is
    // no defensible number for that, so there is no anchor: the whisker alone
    // carries the uncertainty.
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
 * Observed against expected. The whisker here is not a confidence interval
 * from the contract - it carries none for the deal rate - so the bar shows the
 * observed rate with the EXPECTED rate as the dashed anchor, and the alarm is a
 * warning mark plus colour. When `dealRateSuspect` is set the mark is the loud
 * one, because it is the only signal in the app that the recogniser is missing
 * a specific card.
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
  const asRate: Rate = {
    total: stat.eligible,
    wins: Math.round((stat.observedDealRate / 100) * stat.eligible),
    rate: stat.observedDealRate,
    lo: stat.observedDealRate,
    hi: stat.observedDealRate
  }
  const tip = (
    <Box sx={{ ...NUMERIC, minWidth: 220 }}>
      <Typography variant="caption" component="div">
        實際發到 {fmtPct(stat.observedDealRate)}（{stat.eligible} 場有牌組且四張全辨識）
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary">
        牌組帶 {stat.copies?.toFixed(1) ?? '?'} 張時，理論上 {fmtPct(stat.expectedDealRate)}{' '}
        的起手會有它
      </Typography>
      {stat.dealRateSuspect && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, color: 'warning.light' }}>
          差得比運氣能解釋的多。這通常是辨識漏掉了這張卡 -
          異畫、閃卡最常見。它在手上的場次會被算成「沒發到」，所以這一列的其他數字也別太信。
        </Typography>
      )}
      {belowCheck && !stat.dealRateSuspect && (
        <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
          不到 {OPENING_THRESHOLDS.dealCheck} 場，還不能拿來懷疑辨識。
        </Typography>
      )}
    </Box>
  )
  return (
    <Tooltip title={tip} placement="top" slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
      <Stack spacing={0.35} sx={{ minWidth: 0, cursor: 'help' }}>
        <Stack direction="row" alignItems="baseline" spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography
            component="span"
            sx={{
              ...NUMERIC,
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1.2,
              color: stat.dealRateSuspect ? 'warning.light' : 'text.primary'
            }}
          >
            {stat.observedDealRate.toFixed(0)}%
          </Typography>
          <Typography
            component="span"
            variant="caption"
            noWrap
            sx={{ ...NUMERIC, color: 'text.secondary', lineHeight: 1.2 }}
          >
            / 期望 {stat.expectedDealRate.toFixed(0)}% · n={stat.eligible}
          </Typography>
          {stat.dealRateSuspect && (
            <CautionMark title="實際發到率遠低於牌組能給的 - 很可能是這張卡認不出來。" />
          )}
        </Stack>
        <IntervalBar
          rate={asRate}
          anchor={stat.expectedDealRate}
          muted={belowCheck || !stat.dealRateSuspect}
          height={5}
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
  const meta = [
    stat.className === 'neutral' ? '中立' : null,
    stat.rarity ? RARITY_LABEL[stat.rarity] : null
  ]
    .filter(Boolean)
    .join(' ・ ')

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
        minHeight: 56,
        py: 0.9,
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

      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        {showImages && <BannerArt hash={stat.bannerHash} alt="" />}
        <ClassIcon id={stat.className} size={18} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={700} noWrap title={stat.name}>
            {stat.name}
          </Typography>
          {meta && (
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {meta}
            </Typography>
          )}
        </Box>
      </Stack>

      {/* 被發到：次數，底下是留了幾張。零是零，不是空格。 */}
      <Tooltip
        title={
          stat.dealt > 0
            ? `換前四張裡有它 ${stat.dealt} 次，留下 ${stat.kept} 次、換掉 ${stat.dealt - stat.kept} 次`
            : '換前四張裡從來沒認出過它'
        }
        placement="top"
        disableInteractive
      >
        <Box sx={{ textAlign: 'right', cursor: 'help' }}>
          <Typography
            variant="body2"
            noWrap
            sx={{
              ...NUMERIC,
              fontWeight: 700,
              color: stat.dealt === 0 ? 'text.disabled' : 'text.primary'
            }}
          >
            {stat.dealt}
            <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400, ml: 0.4 }}>
              次
            </Box>
          </Typography>
          {stat.dealt > 0 && (
            <Typography
              variant="caption"
              color="text.secondary"
              noWrap
              component="div"
              sx={NUMERIC}
            >
              留 {stat.kept}
            </Typography>
          )}
        </Box>
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
  tooltip,
  lock
}: {
  label: string
  sortKey?: OpeningSortKey
  sort: OpeningSort
  onSort: (key: OpeningSortKey) => void
  align?: 'left' | 'right'
  tooltip?: React.ReactNode
  /** A small lock beside the label: this sort ranks only part of the table. */
  lock?: boolean
}): React.JSX.Element {
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
        gap: 0.35,
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
        '&:hover': sortKey ? { color: 'text.primary' } : undefined,
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', borderRadius: 0.5 }
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
  )
  return tooltip ? (
    <Tooltip title={tooltip} placement="top" slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
      {inner}
    </Tooltip>
  ) : (
    inner
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
            label="被發到"
            sortKey="dealt"
            align="right"
            sort={sort}
            onSort={onSort}
            tooltip="換前四張裡認出這張卡的次數，以及其中留下幾次。"
          />
          <HeaderCell
            label="保留率"
            sortKey="keepRate"
            sort={sort}
            onSort={onSort}
            tooltip={
              <Typography variant="caption" component="div" sx={{ maxWidth: 300 }}>
                被發到的時候，留下來的比例。這是這頁最單純的數字：它描述你的決定，不預測結果，所以幾十次就能看。不到{' '}
                {OPENING_THRESHOLDS.keepRate} 次只印 n。
              </Typography>
            }
          />
          <HeaderCell
            label="發到率 / 期望"
            sortKey="dealRate"
            sort={sort}
            onSort={onSort}
            tooltip={
              <Typography variant="caption" component="div" sx={{ maxWidth: 300 }}>
                實際被發到的比例，對照牌組張數算出來的理論值。這一欄其實是辨識的警報器：一張老是認不出來的卡，發到率會掉到牌組不可能給的水準。排序是「實際減期望」，最低的在上。
              </Typography>
            }
          />
          <HeaderCell
            label="發到 vs 沒發到"
            sortKey="diff"
            sort={sort}
            onSort={onSort}
            lock
            tooltip={
              <Typography variant="caption" component="div" sx={{ maxWidth: 320 }}>
                發到這張卡的對局勝率，減去牌組裡有它但沒發到的對局勝率，已向零收縮。兩邊各不到{' '}
                {OPENING_THRESHOLDS.wrShow} 場只印 n；各不到 {OPENING_THRESHOLDS.wrSort}{' '}
                場可以看但不參與排序 - 排序時它們會整塊沉到分隔線底下。
              </Typography>
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
                  <Typography variant="caption" color="text.secondary">
                    以下 {unrankedCount} 張的樣本不到每邊 {OPENING_THRESHOLDS.wrSort}{' '}
                    場，不參與這個排序，依被發到次數排列。
                  </Typography>
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
