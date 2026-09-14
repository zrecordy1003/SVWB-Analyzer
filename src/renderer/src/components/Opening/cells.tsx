/**
 * The small pieces every number on the 起手 page is built from.
 *
 * Three of them carry the page's rules, and they are components rather than
 * conventions so that the rules cannot be skipped at a call site:
 *
 * - `RateCell` prints a `Rate` as bar + point estimate + n. There is no prop
 *   to drop the n.
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
 *
 * # Bar first, digits second
 *
 * In every cell here the bar is the primary mark and the digits sit after it,
 * smaller and in a fixed-width column. The first pass had it the other way
 * round - a 15px number with a 5px bar under it - and a column of those reads
 * as a column of numbers with decoration. Swapping the weights lets a reader
 * scan a column and see the shape of their deck (which cards they keep, which
 * comparisons lean which way) without reading a digit; the digits are still
 * there, at the same x on every line, for the reader who wants them. The
 * alternative - hiding the digits until row hover - was rejected: a table
 * whose numbers appear and disappear under the mouse is a table nobody
 * trusts, and it is unreadable on a screenshot.
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
 * The whisker is `lo..hi`, the dot is the estimate, the dashed mark is the
 * anchor. Colour follows the estimate's side of the anchor only when the
 * whole interval is on that side; an interval that straddles it is neutral,
 * because "probably above half" is not what a green bar says.
 */
export function IntervalBar({
  rate,
  muted = false,
  anchor = 50,
  height = 6,
  fill = false
}: {
  rate: Rate
  muted?: boolean
  /** Where the dashed reference line sits; 50 for win rates, null for a rate with no natural anchor. */
  anchor?: number | null
  height?: number
  /**
   * Also paint the track from 0 to the estimate.
   *
   * A whisker alone is a marker: it says WHERE, and a column of markers has
   * to be read one by one. A fill from zero is a magnitude, and a column of
   * fills is a shape. The keep-rate column wants the shape - "which of my
   * cards do I keep" is a question about the whole column - so it fills. A
   * win rate against a 50% anchor does not: there the question is which side
   * of the line, and a fill from zero makes 48% and 52% look nearly identical
   * when they are the two answers.
   */
  fill?: boolean
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
      {fill && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${rate.rate}%`,
            borderRadius: height / 2,
            bgcolor: muted ? 'text.disabled' : 'primary.main',
            opacity: muted ? 0.22 : 0.5
          }}
        />
      )}
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
 *
 * The segment from the centre to the dot is painted, not just the dot: a
 * diverging bar that grows out of its axis reads as a magnitude and a
 * direction at once, which is the whole reason to draw a difference this way
 * instead of two rates side by side.
 */
export function DivergingBar({
  value,
  lo,
  hi,
  muted = false,
  span = 30,
  height = 6,
  tone: toneOverride
}: {
  value: number
  lo: number | null
  hi: number | null
  muted?: boolean
  span?: number
  height?: number
  /**
   * Replace the good/bad colouring with one palette path.
   *
   * For the deal-rate check, where the sign carries no value judgement: being
   * dealt a card more often than the deck predicts is luck, not merit, and a
   * green bar would say otherwise. The deviation there is grey until it is
   * large enough to accuse the recogniser, and then it is warning-coloured
   * whichever way it points.
   */
  tone?: string
}): React.JSX.Element {
  const pos = (v: number): number => 50 + Math.max(-50, Math.min(50, (v / span) * 50))
  const straddles = lo !== null && hi !== null && lo < 0 && hi > 0
  const tone =
    toneOverride ??
    (muted || straddles ? 'text.disabled' : value >= 0 ? 'success.main' : 'error.main')
  const from = Math.min(50, pos(value))
  const to = Math.max(50, pos(value))
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
          top: 0,
          bottom: 0,
          left: `${from}%`,
          width: `${to - from}%`,
          bgcolor: tone,
          opacity: muted ? 0.3 : 0.6
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
            opacity: 0.22
          }}
        />
      )}
      <Box
        sx={{
          position: 'absolute',
          top: -2,
          bottom: -2,
          left: '50%',
          borderLeft: '1px solid',
          borderColor: 'text.secondary'
        }}
      />
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
 * The digits column every bar cell ends with: the estimate over its n.
 *
 * Fixed width and right-aligned, so a column of these lines up whether the
 * value is `8.4` or `−12.1`. Two lines rather than one so the cell stays
 * narrow enough for the bar to keep most of the width.
 */
export function Digits({
  primary,
  secondary,
  colour = 'text.primary',
  emphasis = false,
  width = 60
}: {
  primary: string
  secondary: string
  colour?: string
  emphasis?: boolean
  width?: number
}): React.JSX.Element {
  return (
    <Box sx={{ width, flexShrink: 0, textAlign: 'right' }}>
      <Typography
        component="div"
        sx={{
          ...NUMERIC,
          fontSize: emphasis ? 13 : 12,
          fontWeight: 800,
          color: colour,
          lineHeight: 1.15,
          whiteSpace: 'nowrap'
        }}
      >
        {primary}
      </Typography>
      <Typography
        component="div"
        sx={{
          ...NUMERIC,
          fontSize: 10.5,
          color: 'text.disabled',
          lineHeight: 1.15,
          whiteSpace: 'nowrap'
        }}
      >
        {secondary}
      </Typography>
    </Box>
  )
}

/**
 * A `Rate` as bar + digits. The n is not optional.
 *
 * Layout is `[bar ........][52.3% / n=40]`: the bar takes the width, the
 * digits sit in a fixed column on the right so they align down the table.
 * `emphasis` is for the column the page leads with - a taller bar with the
 * zero-to-rate fill - and everything else is a whisker on a thinner track.
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
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, cursor: 'help' }}>
        <IntervalBar
          rate={rate}
          anchor={anchor}
          muted={muted}
          height={emphasis ? 9 : 6}
          fill={emphasis}
        />
        <Digits
          primary={`${rate.rate.toFixed(1)}%`}
          secondary={fmtN(rate.total)}
          colour={colour}
          emphasis={emphasis}
        />
        {caution && <CautionMark title={caution} />}
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
 * The diverging bar with `+8.4` and both arms' n after it.
 *
 * The arms' rates live in the tooltip, not the cell: the reader wants "is it
 * better when dealt, and by how much", and the two n's are what say how far
 * to trust the answer. Two more percentages in a 230px cell were the noise
 * the first pass got wrong.
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
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, cursor: 'help' }}>
        <DivergingBar value={diff} lo={lo} hi={hi} muted={!sortable} height={9} />
        <Digits
          primary={fmtDelta(diff)}
          secondary={`n=${dealt.total}/${notDealt.total}`}
          colour={colour}
          emphasis
          width={66}
        />
        {caution && <CautionMark title={caution} />}
      </Stack>
    </Tooltip>
  )
}

/**
 * A tooltip body for an ⓘ: caption text at a width that wraps into a
 * paragraph instead of one long line. Every `InfoHint` on the page uses it,
 * so the hover surfaces read as one family.
 */
export function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Typography variant="caption" component="div" sx={{ maxWidth: 320, lineHeight: 1.6 }}>
      {children}
    </Typography>
  )
}
