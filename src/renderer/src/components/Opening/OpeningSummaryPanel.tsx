/**
 * 手牌總覽 - the hand-level story, above the card table.
 *
 * Four headline numbers, then the two charts side by side. The four are the
 * page's own coverage funnel - matches with a hand → four slots read → eight
 * slots read - because every number below them has one of those as its
 * denominator, and a user who sees 171 → 152 → 140 knows why the card table
 * has smaller n's than the match list. `pendingRetry` is printed as a live
 * note beside the funnel rather than as an alert: slots still waiting for a
 * name are the normal state of a freshly-installed recogniser, and a warning
 * banner for the normal state teaches people to ignore banners.
 */
import { Box, Paper, Skeleton, Stack, Tooltip, Typography } from '@mui/material'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import React from 'react'

import type { OpeningSummary } from '@shared/openingStats'

import OpeningCurveChart from './OpeningCurveChart'
import SwapBandsChart from './SwapBandsChart'
import { fmtCards, NUMERIC } from './openingFormat'

function Stat({
  label,
  value,
  sub,
  tip
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tip: string
}): React.JSX.Element {
  return (
    <Tooltip title={tip} placement="top">
      <Box
        sx={{
          flex: '1 1 150px',
          minWidth: 0,
          px: 1.75,
          py: 1.25,
          borderRadius: 2,
          bgcolor: 'action.hover',
          cursor: 'help'
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          noWrap
          sx={{ letterSpacing: 0.3 }}
        >
          {label}
        </Typography>
        <Typography
          component="div"
          sx={{ ...NUMERIC, fontSize: 22, fontWeight: 900, lineHeight: 1.25, mt: 0.25 }}
        >
          {value}
        </Typography>
        {sub && (
          <Typography variant="caption" color="text.disabled" component="div" sx={NUMERIC}>
            {sub}
          </Typography>
        )}
      </Box>
    </Tooltip>
  )
}

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : '—'

function ChartCard({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      sx={{
        flex: '1 1 380px',
        minWidth: 0,
        borderRadius: 2,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1
      }}
    >
      <Typography variant="subtitle2" fontWeight={800}>
        {title}
      </Typography>
      {children}
    </Paper>
  )
}

export default function OpeningSummaryPanel({
  summary,
  loading
}: {
  summary: OpeningSummary | null
  loading: boolean
}): React.JSX.Element {
  if (!summary) {
    return (
      <Stack spacing={1.5} data-testid="opening-summary-loading">
        <Stack direction="row" spacing={1.5}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} variant="rounded" height={76} sx={{ flex: 1 }} />
          ))}
        </Stack>
        <Stack direction="row" spacing={1.5}>
          <Skeleton variant="rounded" height={260} sx={{ flex: 1 }} />
          <Skeleton variant="rounded" height={260} sx={{ flex: 1 }} />
        </Stack>
      </Stack>
    )
  }

  return (
    <Stack spacing={1.5} data-testid="opening-summary" sx={{ opacity: loading ? 0.7 : 1 }}>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
        <Stat
          label="有起手紀錄的場次"
          value={summary.matches}
          sub={summary.withDeck > 0 ? `${summary.withDeck} 場有掛牌組` : undefined}
          tip="這個範圍內，換牌畫面有被讀到的對局。1.3.5 之前的紀錄沒有這個畫面。"
        />
        <Stat
          label="四張全辨識"
          value={summary.preComplete}
          sub={pct(summary.preComplete, summary.matches)}
          tip="換前四張都認出是哪張卡的場次。發到率和「發到 vs 沒發到」用的是這個分母。"
        />
        <Stat
          label="八格全辨識"
          value={summary.complete}
          sub={pct(summary.complete, summary.matches)}
          tip="換前、換後八格都認出來的場次。曲線只用這些手畫。"
        />
        <Stat
          label="平均換牌張數"
          value={fmtCards(summary.avgSwapped)}
          tip="每手平均換掉幾張。換了幾張是從畫面位置讀的，不用認出卡片，所以每一場讀到換牌畫面的都算 - 這是這頁唯一不受辨識影響的數字。"
        />
      </Stack>

      {summary.pendingRetry > 0 && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={0.75}
          data-testid="opening-pending"
          sx={{ px: 0.5, color: 'text.secondary' }}
        >
          <AutorenewIcon
            sx={{
              fontSize: 15,
              color: 'info.light',
              '@keyframes opening-spin': { to: { transform: 'rotate(360deg)' } },
              animation: 'opening-spin 3s linear infinite'
            }}
          />
          <Typography variant="caption">
            {summary.pendingRetry} 格還在背景等待補認 -
            卡圖索引建完就會自動補上，這頁的數字會跟著動。
          </Typography>
        </Stack>
      )}

      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
        <ChartCard title="起手曲線">
          <OpeningCurveChart
            curve={summary.curve}
            complete={summary.complete}
            avgCostPre={summary.avgCostPre}
            avgCostPost={summary.avgCostPost}
          />
        </ChartCard>
        <ChartCard title="換牌張數分佈">
          <SwapBandsChart
            all={summary.swapBands}
            byPlayOrder={summary.swapByPlayOrder}
            avgSwapped={summary.avgSwapped}
          />
        </ChartCard>
      </Stack>
    </Stack>
  )
}
