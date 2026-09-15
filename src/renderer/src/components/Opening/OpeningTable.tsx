/**
 * The 起手 card table: one line per card, in the order the contract declares
 * its fields - identity, keep rate, dealt comparison. Each section can be
 * absent while the next is not, and each absent section is drawn as the KIND
 * of absence it is (`MissingPill`), never as a dash.
 *
 * The contract has a fourth section, the deal-rate check (`observedDealRate`
 * against `expectedDealRate`), and this table used to give it a column. It no
 * longer does - see `SuspectMark` for where it went and why.
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
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import React from 'react'

import { OPENING_THRESHOLDS, type OpeningCardStat } from '@shared/openingStats'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import InfoHint from '@renderer/components/Common/InfoHint'
import { CostBadge } from '@renderer/components/Cards/CardsTable'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import { BannerArt, CautionMark, DiffCell, Hint, MissingPill, RateCell, SampleOnly } from './cells'
import type { OpeningRow, OpeningSort, OpeningSortKey } from './openingFilterState'
import {
  fmtPct,
  lowRecognised,
  missingFor,
  NUMERIC,
  recognisedCaution,
  remainingFor,
  sampleFor
} from './openingFormat'

/**
 * Column widths, in px. The card column takes what is left.
 *
 * When the deal-rate column (176px) was removed, its width went to the two
 * remaining bar columns rather than to the card column: the comparison is the
 * column that was tightest - a whisker, a dot and `+8.4` with two n's in 230px
 * - and a wider keep-rate track makes the whiskers on small samples legible.
 * The card column already had room for the longest name in the pool.
 */
const COST_W = 44
const DEALT_W = 60
const KEEP_W = 230
const CMP_W = 320

const COLUMNS = `${COST_W}px minmax(0, 1fr) ${DEALT_W}px ${KEEP_W}px ${CMP_W}px`

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
 * The recognition alarm, as a mark beside the card's name.
 *
 * `dealRateSuspect` is the one signal in the app that the recogniser is
 * systematically missing a specific card - an alternate illustration or a
 * foil that never matches, so the card goes missing from hands it was really
 * in. Its raw material, observed deal rate against the hypergeometric
 * expectation, used to have its own column here: a diverging bar per row,
 * sortable, with the expected rate as the axis. That column is gone, and the
 * reasons are worth recording so nobody adds it back:
 *
 * - For every card the recogniser reads fine, the column said "this card
 *   turned up about as often as a 40-card deck predicts" - a statement about
 *   the recogniser, not the player, and one with no bearing on how to
 *   mulligan. A player reading the table got a column of grey stubs and had
 *   to be told, in the header's ⓘ, that it was really an alarm.
 * - An alarm that is a column is an alarm that fires on 3% of rows and is
 *   silent noise on the other 97%. A mark that appears only on the suspect
 *   row is the same signal with the noise removed.
 *
 * So: the check is still computed for every card (the contract is unchanged,
 * and the drill-down drawer prints the observed and expected figures as one
 * line for whoever wants them), but the TABLE shows only the verdict, only
 * when it is guilty, and beside the name - because the accusation is against
 * this card's illustration, not against any one of its numbers.
 *
 * The mark is `ErrorOutlineRounded` in `warning.main`, deliberately not the
 * amber triangle `CautionMark` uses beside numbers. The two are different
 * claims and a row can carry both: the triangle says "the hands in these
 * matches were often unreadable, so these numbers are computed on a biased
 * subset" (context about the matches); this mark says "THIS card is the one
 * that is not being read" (an accusation against the card). Drawing them with
 * the same glyph would make the row look like it was saying one thing twice.
 * A neutral `InfoHint` was considered and rejected: this is not an
 * explanation the reader may want, it is a warning that the row's other
 * numbers are understated, and it should look like one.
 */
function SuspectMark({ stat }: { stat: OpeningCardStat }): React.JSX.Element | null {
  if (!stat.dealRateSuspect || stat.observedDealRate === null || stat.expectedDealRate === null) {
    return null
  }
  const tip = (
    <Box sx={{ maxWidth: 320 }}>
      <Typography variant="caption" component="div" sx={{ lineHeight: 1.6 }}>
        這張卡出現在起手的頻率，遠低於牌組張數能給的 -
        差得比運氣能解釋的多。通常是辨識漏掉了它：異畫、閃卡最常見。它在手上的場次會被算成「沒發到」，所以這一列的其他數字很可能被低估。
      </Typography>
      <Typography
        variant="caption"
        component="div"
        color="text.secondary"
        sx={{ ...NUMERIC, mt: 0.75, lineHeight: 1.6 }}
      >
        實際發到 {fmtPct(stat.observedDealRate)}（n={stat.eligible}）· 牌組帶{' '}
        {stat.copies?.toFixed(1) ?? '?'} 張時理論上 {fmtPct(stat.expectedDealRate)}
      </Typography>
    </Box>
  )
  return (
    <Tooltip title={tip} placement="top" slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
      <ErrorOutlineRoundedIcon
        data-testid="opening-deal-suspect"
        role="img"
        aria-label="發到率遠低於牌組能給的，很可能是這張卡認不出來"
        tabIndex={0}
        sx={{
          fontSize: 16,
          color: 'warning.main',
          cursor: 'help',
          flexShrink: 0,
          borderRadius: '50%',
          outlineOffset: 2
        }}
      />
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
        <SuspectMark stat={stat} />
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
