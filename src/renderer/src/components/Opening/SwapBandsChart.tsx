/**
 * 換牌張數 - how often the user swaps 0, 1, 2, 3 or 4 cards, and how those
 * hands went.
 *
 * Five horizontal bars, one per band, longest first by construction of the
 * axis (0 at the top). Horizontal rather than the first pass's five columns
 * because the count and the win rate then sit on the same line as the bar,
 * and the chart is short enough to share a row with the coverage funnel. A
 * column chart wanted a row of its own and spent it on five labels.
 *
 * The distribution is the honest half: it is a count of decisions, and it
 * needs no caveat. The win rate at the end of each bar is the half that has
 * to be labelled - a player swaps more when the hand is bad, so "4 swaps →
 * 29%" mostly says the hand was bad, not that swapping four is a mistake.
 * That sentence used to be a paragraph under the chart; it is now the ⓘ
 * beside the card's title (`OpeningSummaryPanel`), and the rate itself is
 * drawn one step quieter than the count so the eye lands on the bar first.
 *
 * Win rates follow the page's rule: a band under `wrShow` prints its n only.
 * The contract has no per-band confidence, so the threshold is applied here,
 * with the same constant the card table uses, rather than inventing another.
 */
import { Box, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material'
import React from 'react'

import { OPENING_THRESHOLDS, type SwapBand } from '@shared/openingStats'
import { wilsonInterval } from '@renderer/components/Analyzer/confidence'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import { fmtN, NUMERIC, rateTone } from './openingFormat'

type Split = 'all' | 'first' | 'second'

const SPLIT_LABEL: Record<Split, string> = { all: '全部', first: '先手', second: '後手' }

const BAR_H = 16

/** Always five bands, 0 through 4, so an unused band keeps its place. */
function fillBands(bands: SwapBand[]): SwapBand[] {
  const by = new Map(bands.map((b) => [b.swapped, b]))
  return [0, 1, 2, 3, 4].map((n) => by.get(n) ?? { swapped: n, total: 0, wins: 0, rate: 0 })
}

export default function SwapBandsChart({
  all,
  byPlayOrder,
  avgSwapped
}: {
  all: SwapBand[]
  byPlayOrder: { first: SwapBand[]; second: SwapBand[] }
  avgSwapped: number | null
}): React.JSX.Element {
  const [split, setSplit] = React.useState<Split>('all')
  const source = split === 'all' ? all : byPlayOrder[split]
  const bands = fillBands(source)
  const hands = bands.reduce((sum, b) => sum + b.total, 0)
  const peak = Math.max(1, ...bands.map((b) => b.total))

  return (
    <Box data-testid="opening-swap-bands">
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        rowGap={0.75}
        sx={{ mb: 1.25 }}
      >
        {/* 平均換幾張：the one summary number this chart has. The unit is in
            the tooltip - "1.51 張 · 171 手" on screen was three words for one
            figure. */}
        <Tooltip title="每手平均換掉幾張，全部讀到換牌畫面的手都算" placement="top">
          <Stack
            direction="row"
            alignItems="baseline"
            spacing={0.75}
            sx={{ ...NUMERIC, cursor: 'help' }}
          >
            <Typography variant="caption" color="text.secondary">
              平均
            </Typography>
            <Typography component="span" sx={{ fontSize: 18, fontWeight: 900, lineHeight: 1 }}>
              {avgSwapped === null ? '—' : avgSwapped.toFixed(2)}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              {fmtN(hands)}
            </Typography>
          </Stack>
        </Tooltip>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={split}
          onChange={(_e, v: Split | null) => v && setSplit(v)}
          aria-label="先後手"
          sx={{ '& .MuiToggleButton-root': { px: 1.25, py: 0.25, fontSize: 12, lineHeight: 1.6 } }}
        >
          {(['all', 'first', 'second'] as Split[]).map((s) => (
            <ToggleButton key={s} value={s}>
              {SPLIT_LABEL[s]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>

      {hands === 0 ? (
        <Box
          sx={{
            height: 5 * (BAR_H + 8),
            display: 'grid',
            placeItems: 'center',
            color: 'text.disabled',
            textAlign: 'center',
            px: 2
          }}
        >
          <Typography variant="caption">
            {split === 'all' ? '還沒有讀到換牌畫面' : `沒有${SPLIT_LABEL[split]}的紀錄`}
          </Typography>
        </Box>
      ) : (
        <Stack spacing={1}>
          {bands.map((b) => {
            const share = hands > 0 ? (b.total / hands) * 100 : 0
            const showRate = b.total >= OPENING_THRESHOLDS.wrShow
            const ci = wilsonInterval(b.wins, b.total)
            const tip = (
              <Box sx={{ ...NUMERIC, minWidth: 200 }}>
                <Typography variant="caption" component="div" fontWeight={700}>
                  換 {b.swapped} 張：{b.total} 手（{share.toFixed(0)}%）
                </Typography>
                <Typography variant="caption" component="div">
                  {b.total > 0
                    ? `${b.wins} 勝 ${b.total - b.wins} 敗 · ${b.rate.toFixed(1)}% · 95% 區間 ${ci.low.toFixed(0)}–${ci.high.toFixed(0)}%`
                    : '沒有這樣的手'}
                </Typography>
                {!showRate && b.total > 0 && (
                  <Typography variant="caption" component="div" color="text.secondary">
                    不到 {OPENING_THRESHOLDS.wrShow} 手，勝率不印成數字。
                  </Typography>
                )}
              </Box>
            )
            return (
              <Tooltip
                key={b.swapped}
                title={tip}
                placement="top"
                slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
              >
                <Box
                  tabIndex={0}
                  aria-label={`換 ${b.swapped} 張，${b.total} 手`}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: '36px minmax(0, 1fr) 84px',
                    alignItems: 'center',
                    columnGap: 1,
                    cursor: 'help',
                    borderRadius: 1,
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      ...NUMERIC,
                      fontWeight: 800,
                      color: 'text.secondary',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    換 {b.swapped}
                  </Typography>
                  {/* bar + count riding its end */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                    <Box
                      sx={{
                        height: BAR_H,
                        width: `${(b.total / peak) * 100}%`,
                        minWidth: b.total > 0 ? 3 : 0,
                        borderRadius: 0.75,
                        bgcolor: 'primary.main',
                        opacity: 0.7,
                        transition: 'width .3s',
                        flexShrink: 1
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        ...NUMERIC,
                        fontWeight: 800,
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                        color: b.total === 0 ? 'text.disabled' : 'text.primary'
                      }}
                    >
                      {b.total}
                      <Box
                        component="span"
                        sx={{ color: 'text.disabled', fontWeight: 500, fontSize: 10.5, ml: 0.4 }}
                      >
                        {share.toFixed(0)}%
                      </Box>
                    </Typography>
                  </Box>
                  {/* 勝率：夠場數才印數字，不夠就印 n。一步比計數安靜。 */}
                  <Typography
                    variant="caption"
                    noWrap
                    sx={{
                      ...NUMERIC,
                      textAlign: 'right',
                      lineHeight: 1.2,
                      fontWeight: showRate ? 800 : 600,
                      color: showRate ? rateTone(b.rate, 'light') : 'text.disabled'
                    }}
                  >
                    {showRate ? (
                      <>
                        {b.rate.toFixed(0)}%
                        <Box
                          component="span"
                          sx={{ color: 'text.disabled', fontWeight: 500, fontSize: 10.5, ml: 0.4 }}
                        >
                          {fmtN(b.total)}
                        </Box>
                      </>
                    ) : (
                      fmtN(b.total)
                    )}
                  </Typography>
                </Box>
              </Tooltip>
            )
          })}
        </Stack>
      )}
    </Box>
  )
}
