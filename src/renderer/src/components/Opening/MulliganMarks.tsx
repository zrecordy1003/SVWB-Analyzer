/**
 * The two marks the 換牌建議 column and its drawer share: the basis mark that
 * says which comparison a card's verdict came from, and the difference cell
 * that carries the numbers behind it.
 *
 * Their own file rather than living in the column, because the drawer imports
 * both and the column imports one, and a component file that exports pieces
 * for another component's use is a component file that will be imported in a
 * circle the first time the drawer needs a new one.
 *
 * # Why the basis mark is still here at all
 *
 * The redesign took every number off the card row except the effect size.
 * It did not take this. A row computed from a wider comparison than the
 * column asks is answering a different question, and now that the row says
 * 建議留 rather than `+16.0 [9.5, 29.3]` a reader has nothing else to make them
 * pause. On the seeded data most verdicts outside the main matchup are exactly
 * this kind - the same few cards riding the all-opponents rung into every
 * column - so a column without this mark would print the same five names
 * against every class and call it advice.
 */
import { Box, Stack, Tooltip, Typography, type Theme } from '@mui/material'
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import HorizontalRuleRoundedIcon from '@mui/icons-material/HorizontalRuleRounded'
import type { SvgIconComponent } from '@mui/icons-material'
import React from 'react'

import type { KeepAdvice, Rate } from '@shared/openingStats'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import { Digits, DivergingBar, Hint, MissingPill, SampleOnly } from './cells'
import { armsRemaining, basisSpec, type BasisTone, type Pins } from './mulliganState'
import { fmtDelta, fmtInterval, fmtRate, NUMERIC } from './openingFormat'

/* ----------------------------------------------------------------- basis */

const BASIS_ICON: Record<BasisTone, SvgIconComponent> = {
  adjusted: LayersOutlinedIcon,
  pooled: HorizontalRuleRoundedIcon,
  widened: UnfoldMoreRoundedIcon
}

/**
 * Typed loosely because `SystemStyleObject` lives in `@mui/system`, which this
 * tsconfig does not resolve directly; the spread below is into an `sx` object
 * literal, which checks each key against the real type at the use site.
 */
const TONE_SX: Record<BasisTone, Record<string, unknown>> = {
  adjusted: {
    color: 'primary.light',
    bgcolor: (t: Theme) => `${t.palette.primary.main}22`,
    border: '1px solid',
    borderColor: (t: Theme) => `${t.palette.primary.main}55`
  },
  pooled: {
    color: 'text.secondary',
    border: '1px solid',
    borderColor: 'divider'
  },
  widened: {
    color: 'warning.light',
    bgcolor: (t: Theme) => `${t.palette.warning.main}1f`,
    border: '1px solid',
    borderColor: (t: Theme) => `${t.palette.warning.main}55`
  }
}

/**
 * The mark that says where a card's numbers came from.
 *
 * Three looks, chosen so they read as a ranking without being read:
 * - adjusted: the primary tint with a layers icon. The one the whole feature
 *   is for.
 * - pooled: a hairline outline in disabled text with a flat dash. Honoured the
 *   column, did nothing about the other three cards.
 * - widened: the warning tint with an unfold icon, because the row stepped
 *   outside the question the column asks. It is the same colour family the
 *   page uses for "something about this row is not what it looks like".
 *
 * Two sizes. `'pill'` carries the label and is what the drawer's title uses.
 * `'dot'` is for the card row: the icon alone in its tinted circle for the two
 * tones that honoured the column, and icon PLUS label for `'widened'`, because
 * that is the one tone a reader must not be able to miss and a column is too
 * narrow to spell out all three. The full explanation is on hover for both.
 */
export function BasisMark({
  advice,
  pins,
  size = 'pill'
}: {
  advice: KeepAdvice
  pins: Pins
  size?: 'pill' | 'dot'
}): React.JSX.Element {
  const spec = basisSpec(advice.basis, pins)
  const Icon = BASIS_ICON[spec.tone]
  const showLabel = size === 'pill' || spec.tone === 'widened'
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
        aria-label={spec.label}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          height: size === 'pill' ? 24 : 18,
          px: showLabel ? (size === 'pill' ? 0.9 : 0.6) : 0,
          width: showLabel ? undefined : 18,
          justifyContent: 'center',
          borderRadius: 12,
          fontSize: size === 'pill' ? 12 : 10.5,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          cursor: 'help',
          maxWidth: '100%',
          flexShrink: 0,
          ...(TONE_SX[spec.tone] as object)
        }}
      >
        <Icon sx={{ fontSize: size === 'pill' ? 14 : 12, flexShrink: 0 }} />
        {showLabel && (
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {spec.label}
          </Box>
        )}
      </Box>
    </Tooltip>
  )
}

/* ------------------------------------------------------------ difference */

/**
 * The kept-versus-swapped difference with its diverging bar, both arms' rates
 * and the unshrunk interval behind a hover. The drawer's cell; the card row
 * prints the number alone.
 *
 * The tooltip carries, at `'stratified'`, the sentence the contract owes the
 * reader: the difference is NOT the two rates beside it subtracted, and the
 * distance between them is the confounding the bands took out. Below that
 * rung the two coincide and the sentence is omitted rather than printed as a
 * falsehood.
 */
export function KeepDiffCell({
  advice,
  pins
}: {
  advice: KeepAdvice
  pins: Pins
}): React.JSX.Element {
  if (
    advice.confidence === 'hidden' ||
    advice.diff === null ||
    !advice.keptWr ||
    !advice.swappedWr
  ) {
    if (advice.dealt === 0) return <MissingPill kind={advice.missing ?? 'unidentified'} />
    return <SampleOnly sample={null} what="留 vs 換" remaining={armsRemaining(advice)} />
  }
  return (
    <DiffBody
      diff={advice.diff}
      lo={advice.diffLo}
      hi={advice.diffHi}
      kept={advice.keptWr}
      swapped={advice.swappedWr}
      stratified={advice.basis === 'stratified'}
      muted={advice.confidence !== 'sortable'}
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
  muted,
  basisExplain
}: {
  diff: number
  lo: number | null
  hi: number | null
  kept: Rate
  swapped: Rate
  stratified: boolean
  /** Below the `'sortable'` tier: the bar is drawn quieter, the number is not. */
  muted: boolean
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
    </Box>
  )
  return (
    <Tooltip title={tip} placement="top" slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, cursor: 'help' }}>
        <DivergingBar value={diff} lo={lo} hi={hi} muted={muted} height={6} />
        <Digits primary={fmtDelta(diff)} colour={colour} width={58} />
      </Stack>
    </Tooltip>
  )
}
