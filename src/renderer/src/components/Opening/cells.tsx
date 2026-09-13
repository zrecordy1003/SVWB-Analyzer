/**
 * The small pieces every number on the 起手 page is built from.
 *
 * Three of them carry the page's rules, and they are components rather than
 * conventions so that the rules cannot be skipped at a call site:
 *
 * - `RateCell` prints a `Rate` as point estimate + interval whisker + n. There
 *   is no prop to drop the n.
 * - `SampleOnly` is what stands in for a number the confidence rules forbid:
 *   the sample size, greyed. "n=7" tells the user how far away the number is;
 *   "—" tells them nothing, and a blank cell tells them the software broke.
 * - `MissingPill` draws one of the four kinds of absence, each visibly unlike
 *   the others. Every competitor collapses these into one empty cell; that is
 *   the failure this page exists not to repeat.
 *
 * The interval is drawn, not only written. `52.3% (38.1–66.2)` has to be read
 * and compared digit by digit; a whisker whose width is the uncertainty is
 * read at a glance, and two whiskers that overlap say "no difference" without
 * a single number being parsed.
 */
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import LinkOffRoundedIcon from '@mui/icons-material/LinkOffRounded'
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined'
import HourglassEmptyRoundedIcon from '@mui/icons-material/HourglassEmptyRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import type { SvgIconComponent } from '@mui/icons-material'
import React from 'react'

import type { Missing, Rate } from '@shared/openingStats'
import { OPENING_THRESHOLDS } from '@shared/openingStats'
import { cardImageUrl } from '@shared/deckImport'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import {
  fmtDelta,
  fmtInterval,
  fmtN,
  fmtRate,
  MISSING_SPEC,
  NUMERIC,
  rateTone
} from './openingFormat'

/* --------------------------------------------------------------- pieces */

/** The list banner, the same size the per-match 起手 block uses. */
export function BannerArt({
  hash,
  alt,
  width = 72,
  height = 20
}: {
  hash: string | null
  alt: string
  width?: number
  height?: number
}): React.JSX.Element {
  const src = cardImageUrl('list', hash)
  const [failed, setFailed] = React.useState(false)
  if (!src || failed) {
    return (
      <Box
        aria-hidden
        sx={{ width, height, borderRadius: 0.5, bgcolor: 'action.hover', flexShrink: 0 }}
      />
    )
  }
  return (
    <Box
      component="img"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{
        width,
        height,
        borderRadius: 0.5,
        objectFit: 'cover',
        objectPosition: '85% center',
        display: 'block',
        flexShrink: 0
      }}
    />
  )
}

/**
 * A point estimate with its interval, on a 0–100 track.
 *
 * The whisker is `lo..hi`, the dot is the estimate, the dashed mark is 50%.
 * Colour follows the estimate's side of 50 only when the whole interval is on
 * that side; an interval that straddles 50 is neutral, because "probably above
 * half" is not what a green bar says.
 */
export function IntervalBar({
  rate,
  muted = false,
  anchor = 50,
  height = 6
}: {
  rate: Rate
  muted?: boolean
  /** Where the dashed reference line sits; 50 for win rates, the expectation for deal rates. */
  anchor?: number | null
  height?: number
}): React.JSX.Element {
  const straddles = anchor !== null && rate.lo < anchor && rate.hi > anchor
  const tone = muted || straddles ? 'text.disabled' : rateTone(rate.rate, 'main')
  return (
    <Box
      aria-hidden
      sx={{
        flex: 1,
        minWidth: 48,
        height,
        borderRadius: height / 2,
        bgcolor: 'action.hover',
        position: 'relative'
      }}
    >
      {anchor !== null && (
        <Box
          sx={{
            position: 'absolute',
            top: -2,
            bottom: -2,
            left: `${anchor}%`,
            borderLeft: '1px dashed',
            borderColor: 'text.disabled'
          }}
        />
      )}
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${rate.lo}%`,
          width: `${Math.max(0, rate.hi - rate.lo)}%`,
          borderRadius: height / 2,
          bgcolor: tone,
          opacity: 0.35
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          top: -1,
          bottom: -1,
          left: `calc(${rate.rate}% - 1.5px)`,
          width: 3,
          borderRadius: 1.5,
          bgcolor: tone
        }}
      />
    </Box>
  )
}

/**
 * A difference and its interval on a diverging track centred at zero.
 *
 * ±`span` points fill the track; anything beyond is pinned. The dot is the
 * SHRUNK difference the contract sorts by, the whisker is the RAW interval it
 * shows, so the dot can sit off-centre in its own whisker - that is the
 * shrinkage, made visible, and it is why a huge whisker with a dot near zero
 * reads correctly as "we do not know yet".
 */
export function DivergingBar({
  value,
  lo,
  hi,
  muted = false,
  span = 30,
  height = 6
}: {
  value: number
  lo: number | null
  hi: number | null
  muted?: boolean
  span?: number
  height?: number
}): React.JSX.Element {
  const pos = (v: number): number => 50 + Math.max(-50, Math.min(50, (v / span) * 50))
  const straddles = lo !== null && hi !== null && lo < 0 && hi > 0
  const tone = muted || straddles ? 'text.disabled' : value >= 0 ? 'success.main' : 'error.main'
  return (
    <Box
      aria-hidden
      sx={{
        flex: 1,
        minWidth: 48,
        height,
        borderRadius: height / 2,
        bgcolor: 'action.hover',
        position: 'relative'
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: -2,
          bottom: -2,
          left: '50%',
          borderLeft: '1px dashed',
          borderColor: 'text.disabled'
        }}
      />
      {lo !== null && hi !== null && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${pos(lo)}%`,
            width: `${Math.max(0, pos(hi) - pos(lo))}%`,
            borderRadius: height / 2,
            bgcolor: tone,
            opacity: 0.35
          }}
        />
      )}
      <Box
        sx={{
          position: 'absolute',
          top: -1,
          bottom: -1,
          left: `calc(${pos(value)}% - 1.5px)`,
          width: 3,
          borderRadius: 1.5,
          bgcolor: tone
        }}
      />
    </Box>
  )
}

/* ---------------------------------------------------------------- cells */

/**
 * `52.3% (n=40)` with its whisker. The n is not optional.
 *
 * `emphasis` is for the column the page leads with; everything else is one
 * step quieter so the eye lands on the keep rate first.
 */
export function RateCell({
  rate,
  label,
  anchor = 50,
  muted = false,
  emphasis = false,
  caution
}: {
  rate: Rate
  /** What the rate is of, for the tooltip's first line. */
  label: string
  anchor?: number | null
  muted?: boolean
  emphasis?: boolean
  /** A warning to print in the tooltip and mark beside the number. */
  caution?: string | null
}): React.JSX.Element {
  const straddles = anchor !== null && rate.lo < anchor && rate.hi > anchor
  const colour = muted || straddles ? 'text.secondary' : rateTone(rate.rate, 'light')
  const tip = (
    <Box sx={{ ...NUMERIC, minWidth: 200 }}>
      <Typography variant="caption" component="div">
        {label}：{fmtRate(rate)}
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary">
        95% 區間 {fmtInterval(rate)}
      </Typography>
      {caution && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, color: 'warning.light' }}>
          {caution}
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
              fontSize: emphasis ? 15 : 13,
              fontWeight: emphasis ? 900 : 700,
              color: colour,
              lineHeight: 1.2
            }}
          >
            {rate.rate.toFixed(1)}%
          </Typography>
          <Typography
            component="span"
            variant="caption"
            sx={{ ...NUMERIC, color: 'text.secondary', lineHeight: 1.2 }}
          >
            {fmtN(rate.total)}
          </Typography>
          {caution && <CautionMark title={caution} />}
        </Stack>
        <IntervalBar rate={rate} anchor={anchor} muted={muted} height={5} />
      </Stack>
    </Tooltip>
  )
}

/**
 * The stand-in for a number the confidence rules forbid.
 *
 * `remaining` turns "n=7" into something actionable: the tooltip says how many
 * more it needs. The threshold is the contract's, not a guess made here.
 */
export function SampleOnly({
  sample,
  what,
  remaining
}: {
  /** `n=7` or `n=41 / 6` - already formatted by `sampleFor`. */
  sample: string
  /** What the missing number is - `保留率`, `勝率差`. */
  what: string
  remaining: number
}): React.JSX.Element {
  const tip =
    remaining > 0
      ? `${what}要再多 ${remaining} 場才會顯示成數字。門檻是這頁固定的，不是依你的資料調的。`
      : `${what}的樣本已達門檻，但另一半的資料還不夠。`
  return (
    <Tooltip title={tip} placement="top">
      <Typography
        component="span"
        data-testid="opening-sample-only"
        sx={{
          ...NUMERIC,
          fontSize: 12,
          fontWeight: 600,
          color: 'text.disabled',
          cursor: 'help',
          whiteSpace: 'nowrap'
        }}
      >
        {sample}
      </Typography>
    </Tooltip>
  )
}

const MISSING_ICON: Record<Missing, SvgIconComponent> = {
  'never-dealt': CheckRoundedIcon,
  'no-deck': LinkOffRoundedIcon,
  unidentified: VisibilityOffOutlinedIcon,
  'low-sample': HourglassEmptyRoundedIcon
}

/**
 * One of the four kinds of absence.
 *
 * - never-dealt: a solid, full-contrast pill with a tick. It is a real zero and
 *   is drawn with the weight of a real number.
 * - no-deck: a dashed outline, disabled text, a broken-link icon. Unknowable,
 *   not unknown - the frame is there and nothing can fill it.
 * - unidentified: a warning-tinted pill with an eye-off icon, the same colour
 *   family the per-match block uses for an unread slot. Something is waiting
 *   on the recogniser.
 * - low-sample: no pill at all; the sample size in disabled text. It is the
 *   quietest because it is the ordinary state of a young dataset, and a page
 *   full of warning pills for "not yet" would drown the three that matter.
 */
export function MissingPill({
  kind,
  sample,
  remaining
}: {
  kind: Missing
  /** For `low-sample`: what to print instead of the label. */
  sample?: string
  remaining?: number
}): React.JSX.Element {
  const spec = MISSING_SPEC[kind]
  if (kind === 'low-sample') {
    return <SampleOnly sample={sample ?? spec.label} what="這個數字" remaining={remaining ?? 0} />
  }
  const Icon = MISSING_ICON[kind]
  return (
    <Tooltip title={spec.explain} placement="top">
      <Box
        component="span"
        data-testid={`opening-missing-${kind}`}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          height: 22,
          px: 0.9,
          borderRadius: 11,
          fontSize: 11.5,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          cursor: 'help',
          color: spec.tone,
          ...(spec.variant === 'solid' && {
            bgcolor: 'action.selected',
            border: '1px solid',
            borderColor: 'divider'
          }),
          ...(spec.variant === 'dashed' && {
            border: '1px dashed',
            borderColor: 'text.disabled'
          }),
          ...(spec.variant === 'tinted' && {
            bgcolor: (t) => `${t.palette.warning.main}1f`,
            border: '1px solid',
            borderColor: (t) => `${t.palette.warning.main}55`
          })
        }}
      >
        <Icon sx={{ fontSize: 14 }} />
        {spec.label}
      </Box>
    </Tooltip>
  )
}

/** The small warning mark beside a number whose row was not read reliably. */
export function CautionMark({ title }: { title: string }): React.JSX.Element {
  return (
    <Tooltip title={title} placement="top">
      <WarningAmberRoundedIcon
        data-testid="opening-caution"
        sx={{ fontSize: 14, color: 'warning.light', cursor: 'help', flexShrink: 0 }}
      />
    </Tooltip>
  )
}

/**
 * `+8.4` with the diverging whisker and both arms' n.
 *
 * The two arms are printed under the difference rather than in two more
 * columns: the reader wants "is it better when dealt, and by how much", and
 * the arms are the working shown under the answer.
 */
export function DiffCell({
  diff,
  lo,
  hi,
  dealt,
  notDealt,
  sortable,
  caution
}: {
  diff: number
  lo: number | null
  hi: number | null
  dealt: Rate
  notDealt: Rate
  sortable: boolean
  caution?: string | null
}): React.JSX.Element {
  const straddles = lo !== null && hi !== null && lo < 0 && hi > 0
  const colour = straddles ? 'text.secondary' : diff >= 0 ? 'success.light' : 'error.light'
  const tip = (
    <Box sx={{ ...NUMERIC, minWidth: 240 }}>
      <Typography variant="caption" component="div">
        發到時：{fmtRate(dealt)} · 區間 {fmtInterval(dealt)}
      </Typography>
      <Typography variant="caption" component="div">
        沒發到時：{fmtRate(notDealt)} · 區間 {fmtInterval(notDealt)}
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
        差 {fmtDelta(diff)} 個百分點（已向零收縮）
        {lo !== null && hi !== null ? `；原始差的 95% 區間 ${fmtDelta(lo)} 到 ${fmtDelta(hi)}` : ''}
      </Typography>
      {!sortable && (
        <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
          兩邊各不到 {OPENING_THRESHOLDS.wrSort} 場，可以看、不參與排序。
        </Typography>
      )}
      {caution && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, color: 'warning.light' }}>
          {caution}
        </Typography>
      )}
    </Box>
  )
  return (
    <Tooltip title={tip} placement="top" slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
      <Stack spacing={0.35} sx={{ minWidth: 0, cursor: 'help' }}>
        <Stack direction="row" alignItems="baseline" spacing={0.75} sx={{ minWidth: 0 }}>
          <Typography
            component="span"
            sx={{ ...NUMERIC, fontSize: 15, fontWeight: 900, color: colour, lineHeight: 1.2 }}
          >
            {fmtDelta(diff)}
          </Typography>
          <Typography
            component="span"
            variant="caption"
            noWrap
            sx={{ ...NUMERIC, color: 'text.secondary', lineHeight: 1.2, minWidth: 0 }}
          >
            {dealt.rate.toFixed(0)}% (n={dealt.total}) vs {notDealt.rate.toFixed(0)}% (n=
            {notDealt.total})
          </Typography>
          {caution && <CautionMark title={caution} />}
        </Stack>
        <DivergingBar value={diff} lo={lo} hi={hi} muted={!sortable} height={5} />
      </Stack>
    </Tooltip>
  )
}
