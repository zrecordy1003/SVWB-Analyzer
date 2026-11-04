/**
 * 涵蓋 - the page's own coverage funnel, drawn once instead of printed four times.
 *
 * Every number on the page has one of four denominators: matches with a hand
 * at all, hands with all four dealt slots read, hands with all eight read, and
 * matches with a deck attached. The first pass printed those as four tiles of
 * label-number-percent. The information in them is the SHRINKAGE - 171 became
 * 152 became 140 - and shrinkage is a shape, so this draws it: four centred
 * bars, each as wide as its share of the first, stacked so the funnel narrows
 * downward. The counts stay beside the bars; the definitions move to hover.
 *
 * # Why the last bar is set apart
 *
 * The first three nest: every eight-slot hand is a four-slot hand is a hand.
 * "Has a deck attached" is not the next step down that chain - it is a
 * different cut of the same matches, and the demo fixture has it wider than
 * the eight-slot bar. Drawing it as a fourth funnel step would claim a nesting
 * the data does not have, so it sits under a dashed rule in its own colour.
 * The honest alternative - a Venn diagram - was rejected as unreadable at
 * this size and unfamiliar to the audience.
 */
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import React from 'react'

import type { OpeningSummary } from '@shared/openingStats'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import { NUMERIC } from './openingFormat'
import { motion } from '../Common/motion'

type Step = {
  key: 'matches' | 'preComplete' | 'complete' | 'withDeck'
  /** Two to four characters; the bar is the explanation. */
  label: string
  value: number
  /** Palette path for the bar. */
  tone: string
  /** The definition, for hover. */
  explain: string
}

const BAR_H = 18
const ROW_GAP = 0.75

function steps(summary: OpeningSummary): Step[] {
  return [
    {
      key: 'matches',
      label: '有起手',
      value: summary.matches,
      tone: 'primary.main',
      explain: '有讀到換牌畫面的對局。較早的對局沒有換牌紀錄，不會計入。'
    },
    {
      key: 'preComplete',
      label: '四張認出',
      value: summary.preComplete,
      tone: 'primary.main',
      explain: '換牌前四張都辨識出來的場數，用來計算保留率。'
    },
    {
      key: 'complete',
      label: '八格認出',
      value: summary.complete,
      tone: 'primary.main',
      explain: '換牌前後八張都辨識出來的場數，用來畫起手曲線。'
    },
    {
      key: 'withDeck',
      label: '掛牌組',
      value: summary.withDeck,
      tone: 'info.main',
      explain: '有掛上牌組的對局，用來計算「發到 vs 沒發到」。與上面三項分開計算。'
    }
  ]
}

export default function CoverageFunnel({
  summary
}: {
  summary: OpeningSummary
}): React.JSX.Element {
  const rows = steps(summary)
  const whole = Math.max(1, summary.matches)
  return (
    <Stack spacing={ROW_GAP} data-testid="opening-coverage">
      {rows.map((step, i) => {
        const share = Math.min(1, step.value / whole)
        const pct = summary.matches > 0 ? `${Math.round(share * 100)}%` : '—'
        const isDeck = step.key === 'withDeck'
        return (
          <React.Fragment key={step.key}>
            {isDeck && <Box sx={{ borderTop: '1px dashed', borderColor: 'divider', my: 0.25 }} />}
            <Tooltip
              title={
                <Typography variant="caption" component="div" sx={{ maxWidth: 280 }}>
                  <Box component="span" sx={{ fontWeight: 700 }}>
                    {step.label}
                  </Box>
                  {' · '}
                  <Box component="span" sx={NUMERIC}>
                    {step.value} 場（{pct}）
                  </Box>
                  <Box component="div" sx={{ mt: 0.5, color: 'text.secondary' }}>
                    {step.explain}
                  </Box>
                </Typography>
              }
              placement="right"
              slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
            >
              <Box
                tabIndex={0}
                aria-label={`${step.label} ${step.value} 場，${pct}`}
                data-testid={`opening-coverage-${step.key}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '64px minmax(0, 1fr) 56px',
                  alignItems: 'center',
                  columnGap: 1,
                  cursor: 'help',
                  borderRadius: 1,
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
                }}
              >
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 0.3 }}
                >
                  {step.label}
                </Typography>
                {/* The track is full width; the bar is centred in it so the
                    stack narrows symmetrically - the eye reads a funnel, not a
                    bar chart. */}
                <Box sx={{ height: BAR_H, display: 'flex', justifyContent: 'center' }}>
                  <Box
                    sx={{
                      width: `${Math.max(share * 100, step.value > 0 ? 2 : 0)}%`,
                      height: '100%',
                      borderRadius: 0.75,
                      bgcolor: step.tone,
                      // Each nested step a shade quieter than the one above,
                      // so the funnel also reads top-to-bottom by weight.
                      opacity: isDeck ? 0.55 : 0.85 - i * 0.15,
                      transition: motion(['width'], 'slow')
                    }}
                  />
                </Box>
                <Typography
                  component="div"
                  sx={{ ...NUMERIC, textAlign: 'right', lineHeight: 1.1, fontWeight: 900 }}
                >
                  <Box component="span" sx={{ fontSize: 15 }}>
                    {step.value}
                  </Box>
                  {i > 0 && (
                    <Box
                      component="span"
                      sx={{ fontSize: 10.5, fontWeight: 600, color: 'text.disabled', ml: 0.5 }}
                    >
                      {pct}
                    </Box>
                  )}
                </Typography>
              </Box>
            </Tooltip>
          </React.Fragment>
        )
      })}
    </Stack>
  )
}
