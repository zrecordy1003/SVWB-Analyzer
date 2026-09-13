/**
 * 換牌張數分佈 - how often the user swaps 0, 1, 2, 3 or 4 cards, and how those
 * hands went.
 *
 * The distribution is the honest half: it is a count of decisions, and it
 * needs no caveat. The win rate under each column is the half that has to be
 * labelled, and the label is printed in the panel, not folded into a tooltip:
 * a player swaps more when the hand is bad, so "4 swaps → 29%" mostly says the
 * hand was bad, not that swapping four is a mistake. Every product that shows
 * this number shows it without that sentence. This one does not.
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

const TRACK_H = 96

/** Always five columns, 0 through 4, so an unused band keeps its place. */
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
        sx={{ mb: 1 }}
      >
        <Stack direction="row" alignItems="baseline" spacing={0.75} sx={NUMERIC}>
          <Typography variant="caption" color="text.secondary">
            平均換
          </Typography>
          <Typography variant="body2" fontWeight={800}>
            {avgSwapped === null ? '—' : `${avgSwapped.toFixed(2)} 張`}
          </Typography>
          <Typography variant="caption" color="text.disabled">
            · {hands} 手
          </Typography>
        </Stack>
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
            height: TRACK_H + 56,
            display: 'grid',
            placeItems: 'center',
            color: 'text.secondary',
            textAlign: 'center',
            px: 2
          }}
        >
          <Typography variant="caption">
            {split === 'all'
              ? '還沒有讀到任何一場的換牌畫面。讀到之後這裡就有分佈 - 換了幾張不需要認出卡片。'
              : `這個範圍內沒有讀到${SPLIT_LABEL[split]}的換牌畫面。`}
          </Typography>
        </Box>
      ) : (
        <Stack direction="row" spacing={1} alignItems="flex-end">
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
                <Stack
                  spacing={0.5}
                  alignItems="stretch"
                  tabIndex={0}
                  aria-label={`換 ${b.swapped} 張，${b.total} 手`}
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    cursor: 'help',
                    borderRadius: 1,
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
                  }}
                >
                  <Typography
                    variant="caption"
                    align="center"
                    sx={{ ...NUMERIC, fontWeight: 700, opacity: b.total === 0 ? 0.35 : 1 }}
                  >
                    {b.total}
                    <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                      {' '}
                      ({share.toFixed(0)}%)
                    </Box>
                  </Typography>
                  <Box
                    sx={{
                      height: TRACK_H,
                      bgcolor: 'action.hover',
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 0.75,
                      display: 'flex',
                      alignItems: 'flex-end',
                      overflow: 'hidden'
                    }}
                  >
                    <Box
                      sx={{
                        width: '100%',
                        height: `${(b.total / peak) * 100}%`,
                        bgcolor: 'primary.main',
                        opacity: 0.7,
                        transition: 'height .3s'
                      }}
                    />
                  </Box>
                  <Typography
                    variant="caption"
                    align="center"
                    sx={{ fontWeight: 800, lineHeight: 1.2 }}
                  >
                    換 {b.swapped}
                  </Typography>
                  {/* 勝率：夠場數才印數字，不夠就印 n。 */}
                  <Typography
                    variant="caption"
                    align="center"
                    noWrap
                    sx={{
                      ...NUMERIC,
                      lineHeight: 1.2,
                      fontWeight: showRate ? 800 : 600,
                      color: showRate
                        ? rateTone(b.rate, 'light')
                        : b.total === 0
                          ? 'text.disabled'
                          : 'text.disabled'
                    }}
                  >
                    {showRate ? `${b.rate.toFixed(0)}% (n=${b.total})` : fmtN(b.total)}
                  </Typography>
                </Stack>
              </Tooltip>
            )
          })}
        </Stack>
      )}

      {/* 選擇偏差的那句話，一定印在面板上，不收進 tooltip。這和辨識無關 - 換了幾張是
          從畫面的位置讀的，卡片認不認得出來都算得到，所以這一格不缺資料；它缺的是
          「換牌張數」和「勝率」之間的因果。兩件事分開講。 */}
      <Typography
        variant="caption"
        color="text.secondary"
        component="p"
        sx={{ mt: 1.25, lineHeight: 1.5 }}
      >
        分佔本身是準的：換了幾張是從畫面位置讀的，不用認出卡片，每一場讀到換牌畫面的都算。
        底下那排勝率則會偏 - 手牌差才會多換，所以「換得多、勝率低」大半是在講手牌本來就差，
        不是在講換牌這個決定。看分佈就好，勝率當參考。
      </Typography>
    </Box>
  )
}
