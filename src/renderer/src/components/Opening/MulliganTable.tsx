/**
 * The 換牌建議 table: one line per card, 保留率 first and heaviest, the
 * kept-versus-swapped difference second and quieter, and beside it the mark
 * that says which comparison the number actually came from.
 *
 * # Why the keep rate is the wide column and the difference is not
 *
 * The 起手 table gives its comparison column the most room because that
 * comparison (dealt vs not dealt) is clean. This one is not: keeping is a
 * decision, so `diff` carries whatever made the player decide, and shrinking
 * a confounded difference makes it smaller, not cleaner. The keep rate, by
 * contrast, is a description of the player's own habit with no estimation in
 * it, readable at a dozen observations, and - the plan's 四 - it is also the
 * reader's warning light for the comparison beside it: a card kept 95% of the
 * time has almost no swapped arm, and the keep rate says so before the n does.
 * So the keep rate gets the fill, the height and the width; the difference
 * gets a thinner track and its digits are not emphasised.
 *
 * # The basis column
 *
 * A pill per row, always drawn, in one of three tones (`BasisMark`). It is a
 * column rather than an icon beside the number because the failure mode of
 * this page is a table where half the rows quietly answer a wider question
 * than the header asks, and a reader must see that from across the room. The
 * explanation is on hover; the tone and the label are not.
 *
 * Sorting on the difference ranks only `'sortable'` rows, exactly as the 起手
 * table does, and the table does not open sorted on it: it opens on `dealt`.
 */
import { Box, Skeleton, Stack, Tooltip, Typography } from '@mui/material'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import HorizontalRuleRoundedIcon from '@mui/icons-material/HorizontalRuleRounded'
import type { SvgIconComponent } from '@mui/icons-material'
import React from 'react'

import { KEEP_THRESHOLDS, type KeepAdvice, type Rate } from '@shared/openingStats'
import InfoHint from '@renderer/components/Common/InfoHint'
import { CostBadge } from '@renderer/components/Cards/CardsTable'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import { BannerArt, Digits, DivergingBar, Hint, MissingPill, RateCell, SampleOnly } from './cells'
import {
  armsRemaining,
  armsSample,
  basisSpec,
  keepRemaining,
  keepSample,
  type BasisTone,
  type MulliganRow,
  type Pins
} from './mulliganState'
import type { OpeningSort, OpeningSortKey } from './openingFilterState'
import { fmtDelta, fmtInterval, fmtRate, NUMERIC } from './openingFormat'

/**
 * Column widths, in px. The card column takes what is left.
 *
 * The keep-rate track is the widest bar on the page (250) and the comparison
 * is narrower (210) - the reverse of the 起手 table, for the reason in the
 * file header. The basis column is sized to its longest label at 11.5px.
 */
const COST_W = 44
const DEALT_W = 60
const KEEP_W = 250
const CMP_W = 210
const BASIS_W = 128

const COLUMNS = `${COST_W}px minmax(0, 1fr) ${DEALT_W}px ${KEEP_W}px ${CMP_W}px ${BASIS_W}px`

/* ----------------------------------------------------------------- basis */

const BASIS_ICON: Record<BasisTone, SvgIconComponent> = {
  adjusted: LayersOutlinedIcon,
  pooled: HorizontalRuleRoundedIcon,
  widened: UnfoldMoreRoundedIcon
}

/**
 * The pill that says where a row's numbers came from.
 *
 * Three looks, chosen so they read as a ranking without being read:
 * - adjusted: a filled pill in the primary tint with a layers icon. The one
 *   the whole feature is for.
 * - pooled: a hairline outline in disabled text with a flat dash. Honoured the
 *   filter, did nothing about the other three cards.
 * - widened: the warning tint with an unfold icon, because the row stepped
 *   outside the question the header asks. It is the same colour family the
 *   page uses for "something about this row is not what it looks like".
 *
 * Always drawn, even on hidden rows, because a hidden row still has a rung
 * (the handler reports the last one it tried) and a reader comparing two
 * `n=` cells wants to know which population each n was counted in.
 */
export function BasisMark({
  advice,
  pins,
  size = 'cell'
}: {
  advice: KeepAdvice
  pins: Pins
  size?: 'cell' | 'title'
}): React.JSX.Element {
  const spec = basisSpec(advice.basis, pins)
  const Icon = BASIS_ICON[spec.tone]
  const tall = size === 'title'
  return (
    <Tooltip
      title={<Hint>{spec.explain}</Hint>}
      placement="top"
      slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
    >
      <Box
        component="span"
        data-testid="mulligan-basis"
        data-basis={advice.basis}
        data-tone={spec.tone}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          height: tall ? 24 : 22,
          px: 0.9,
          borderRadius: 11,
          fontSize: tall ? 12 : 11.5,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          cursor: 'help',
          maxWidth: '100%',
          ...(spec.tone === 'adjusted' && {
            color: 'primary.light',
            bgcolor: (t) => `${t.palette.primary.main}22`,
            border: '1px solid',
            borderColor: (t) => `${t.palette.primary.main}55`
          }),
          ...(spec.tone === 'pooled' && {
            color: 'text.secondary',
            border: '1px solid',
            borderColor: 'divider'
          }),
          ...(spec.tone === 'widened' && {
            color: 'warning.light',
            bgcolor: (t) => `${t.palette.warning.main}1f`,
            border: '1px solid',
            borderColor: (t) => `${t.palette.warning.main}55`
          })
        }}
      >
        <Icon sx={{ fontSize: 14, flexShrink: 0 }} />
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {spec.label}
        </Box>
      </Box>
    </Tooltip>
  )
}

/* ----------------------------------------------------------------- cells */

function KeepCell({ advice }: { advice: KeepAdvice }): React.JSX.Element {
  if (advice.keepRate) {
    return <RateCell rate={advice.keepRate} label="保留率" anchor={null} emphasis />
  }
  if (advice.dealt === 0) return <MissingPill kind={advice.missing ?? 'unidentified'} />
  return <SampleOnly sample={keepSample(advice)} what="保留率" remaining={keepRemaining(advice)} />
}

/**
 * The kept-versus-swapped difference: a thinner diverging bar than the 起手
 * page's, un-emphasised digits, both arms' n after it.
 *
 * The tooltip carries the two arms and, at `'stratified'`, the sentence the
 * contract owes the reader: the difference is NOT the two rates beside it
 * subtracted, and the distance between them is the confounding the bands
 * took out. Below that rung the two coincide and the sentence is omitted
 * rather than printed as a falsehood.
 */
export function KeepDiffCell({
  advice,
  sortable,
  pins
}: {
  advice: KeepAdvice
  sortable: boolean
  pins: Pins
}): React.JSX.Element {
  if (
    advice.confidence === 'hidden' ||
    advice.diff === null ||
    !advice.keptWr ||
    !advice.swappedWr
  ) {
    if (advice.dealt === 0) return <MissingPill kind={advice.missing ?? 'unidentified'} />
    return (
      <SampleOnly sample={armsSample(advice)} what="留 vs 換" remaining={armsRemaining(advice)} />
    )
  }
  return (
    <DiffBody
      diff={advice.diff}
      lo={advice.diffLo}
      hi={advice.diffHi}
      kept={advice.keptWr}
      swapped={advice.swappedWr}
      stratified={advice.basis === 'stratified'}
      sortable={sortable}
      basisExplain={basisSpec(advice.basis, pins).explain}
    />
  )
}

function DiffBody({
  diff,
  lo,
  hi,
  kept,
  swapped,
  stratified,
  sortable,
  basisExplain
}: {
  diff: number
  lo: number | null
  hi: number | null
  kept: Rate
  swapped: Rate
  stratified: boolean
  sortable: boolean
  basisExplain: string
}): React.JSX.Element {
  const straddles = lo !== null && hi !== null && lo < 0 && hi > 0
  const colour = straddles ? 'text.secondary' : diff >= 0 ? 'success.light' : 'error.light'
  const crude = kept.rate - swapped.rate
  const tip = (
    <Box sx={{ ...NUMERIC, minWidth: 250, maxWidth: 340 }}>
      <Typography variant="caption" component="div">
        留下時：{fmtRate(kept)} · 區間 {fmtInterval(kept)}
      </Typography>
      <Typography variant="caption" component="div">
        換掉時：{fmtRate(swapped)} · 區間 {fmtInterval(swapped)}
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
        差 {fmtDelta(diff)} 個百分點（已向零收縮）
        {lo !== null && hi !== null ? `；未收縮的 95% 區間 ${fmtDelta(lo)} 到 ${fmtDelta(hi)}` : ''}
      </Typography>
      {stratified && (
        <Typography
          variant="caption"
          component="div"
          color="text.secondary"
          sx={{ mt: 0.5, lineHeight: 1.5 }}
        >
          這個差不是上面兩個勝率相減（那是 {fmtDelta(crude)}
          ）：它是其餘三張相近的手牌各自比完再合起來的。兩者的距離，就是其餘三張造成的偏差。
        </Typography>
      )}
      <Typography
        variant="caption"
        component="div"
        color="text.secondary"
        sx={{ mt: 0.5, lineHeight: 1.5 }}
      >
        {basisExplain}
      </Typography>
      {!sortable && (
        <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
          兩邊各不到 {KEEP_THRESHOLDS.sort} 次，可以看、不參與排序。
        </Typography>
      )}
    </Box>
  )
  return (
    <Tooltip title={tip} placement="top" slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, cursor: 'help' }}>
        <DivergingBar value={diff} lo={lo} hi={hi} muted={!sortable} height={6} />
        <Digits
          primary={fmtDelta(diff)}
          secondary={`n=${kept.total}/${swapped.total}`}
          colour={colour}
          width={66}
        />
      </Stack>
    </Tooltip>
  )
}

/* ------------------------------------------------------------------ row */

function CardLine({
  row,
  pins,
  showImages,
  selected,
  onSelect
}: {
  row: MulliganRow
  pins: Pins
  showImages: boolean
  selected: boolean
  onSelect: (row: MulliganRow) => void
}): React.JSX.Element {
  const { advice } = row
  return (
    <Box
      role="button"
      tabIndex={0}
      data-testid={`mulligan-row-${advice.cardId}`}
      data-confidence={advice.confidence}
      data-basis={advice.basis}
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
      <CostBadge cost={advice.cost} />

      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
        {showImages && <BannerArt hash={advice.bannerHash} alt="" />}
        <Typography
          variant="body2"
          fontWeight={700}
          noWrap
          title={advice.name}
          sx={{ minWidth: 0 }}
        >
          {advice.name}
        </Typography>
      </Stack>

      {/* 發到：copies, not matches - the handler's unit. The tooltip says so
          in the count's own terms (留下幾張、換掉幾張). */}
      <Tooltip
        title={
          advice.dealt > 0
            ? `這個條件下換前手牌裡有它 ${advice.dealt} 張，留下 ${advice.kept}、換掉 ${advice.dealt - advice.kept}`
            : '這個條件下換前手牌裡從來沒認出過它'
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
            color: advice.dealt === 0 ? 'text.disabled' : 'text.primary'
          }}
        >
          {advice.dealt}
        </Typography>
      </Tooltip>

      <KeepCell advice={advice} />
      <KeepDiffCell advice={advice} sortable={row.sortable} pins={pins} />
      <Box sx={{ minWidth: 0, display: 'flex' }}>
        <BasisMark advice={advice} pins={pins} />
      </Box>
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
  hint?: React.ReactNode
  hintLabel?: string
  lock?: boolean
}): React.JSX.Element {
  const active = sortKey !== undefined && sort.key === sortKey
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

export type MulliganTableProps = {
  rows: MulliganRow[]
  pins: Pins
  sort: OpeningSort
  onSort: (key: OpeningSortKey) => void
  unrankedFrom: number
  showImages: boolean
  selectedKey: string | null
  onSelect: (row: MulliganRow) => void
  loading: boolean
  emptyText: string
}

export default function MulliganTable({
  rows,
  pins,
  sort,
  onSort,
  unrankedFrom,
  showImages,
  selectedKey,
  onSelect,
  loading,
  emptyText
}: MulliganTableProps): React.JSX.Element {
  const unrankedCount = unrankedFrom >= 0 ? rows.length - unrankedFrom : 0
  return (
    <Box data-testid="mulligan-table" sx={{ minWidth: 0, overflowX: 'auto' }}>
      <Box sx={{ minWidth: 980 }}>
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
            hint={
              <Hint>
                這個條件下，換前手牌裡認出這張卡的張數。一手兩張算兩張，因為留或換是一張一張決定的。
              </Hint>
            }
          />
          <HeaderCell
            label="保留率"
            sortKey="keepRate"
            sort={sort}
            onSort={onSort}
            hint={
              <Hint>
                被發到的時候，留下來的比例。純描述、沒有估計，幾次就能看，所以它是這頁最寬的一欄。它也替右邊那欄把關：保留率
                95% 的卡，「換掉」那一邊幾乎是空的，旁邊的差自然不可信。不到{' '}
                {KEEP_THRESHOLDS.keepRate} 張只印 n。
              </Hint>
            }
          />
          <HeaderCell
            label="留 vs 換"
            sortKey="diff"
            sort={sort}
            onSort={onSort}
            lock
            hint={
              <Hint>
                留下這張時的勝率，減去換掉它時的勝率，已向零收縮。留不留是你決定的，所以這不是公平的比較——它會跟著其餘三張一起走，右邊那欄說明這一列用哪些手牌來比。兩邊各不到{' '}
                {KEEP_THRESHOLDS.show} 次只印 n；各不到 {KEEP_THRESHOLDS.sort}{' '}
                次可以看但不參與排序。
              </Hint>
            }
          />
          <HeaderCell
            label="比較範圍"
            sort={sort}
            onSort={onSort}
            hint={
              <Hint>
                這一列的數字是拿哪些手牌比出來的。藍色是「其餘三張相近」：留與換只在其餘三張費用差不多的手牌之間比，再把三段合起來。灰色是沒有分層、但仍在你選的條件裡。橘色是你選的條件樣本不夠，這一列把範圍放寬了——它回答的比你問的寬。
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
            data-testid="mulligan-empty"
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
                  data-testid="mulligan-unranked-divider"
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
                        這些卡「留 vs 換」兩邊各不到 {KEEP_THRESHOLDS.sort}{' '}
                        次，差值還是雜訊多於訊號，拿來排名會排出資料撐不起來的順序。它們照被發到張數排列。
                      </Hint>
                    }
                  />
                </Stack>
              )}
              <CardLine
                row={row}
                pins={pins}
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
