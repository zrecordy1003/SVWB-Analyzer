/**
 * 手牌總覽 - the hand-level story, above the card table.
 *
 * Three pictures and almost no prose. Row one is the coverage funnel and the
 * swap-count distribution, side by side because both are short; row two is
 * the curve at full width, because it is the chart the page is built around
 * and it earns the room. Every explanation that used to be printed under a
 * chart is now the ⓘ beside that chart's title (`InfoHint`), so the panel
 * carries titles, numbers and bars, and a reader who wants the reasoning pays
 * one mouse movement for it.
 *
 * `pendingRetry` is printed as a live count beside the funnel rather than as
 * an alert: slots still waiting for a name are the normal state of a
 * freshly-installed recogniser, and a warning banner for the normal state
 * teaches people to ignore banners.
 */
import { Paper, Skeleton, Stack, Typography } from '@mui/material'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import React from 'react'

import { OPENING_THRESHOLDS, type OpeningSummary } from '@shared/openingStats'
import InfoHint from '@renderer/components/Common/InfoHint'

import { Hint } from './cells'
import CoverageFunnel from './CoverageFunnel'
import OpeningCurveChart from './OpeningCurveChart'
import SwapBandsChart from './SwapBandsChart'
import { NUMERIC } from './openingFormat'

/** A titled card with the title's ⓘ and an optional right-hand slot. */
function ChartCard({
  title,
  hint,
  hintLabel,
  aside,
  flex,
  children,
  testId
}: {
  title: string
  hint: React.ReactNode
  hintLabel: string
  aside?: React.ReactNode
  flex: string
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid={testId}
      sx={{
        flex,
        minWidth: 0,
        borderRadius: 2,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.75}>
        <Typography variant="subtitle2" fontWeight={800}>
          {title}
        </Typography>
        <InfoHint title={hint} label={hintLabel} size={15} />
        {aside && (
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ ml: 'auto' }}>
            {aside}
          </Stack>
        )}
      </Stack>
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
          <Skeleton variant="rounded" height={190} sx={{ flex: '0 1 340px' }} />
          <Skeleton variant="rounded" height={190} sx={{ flex: 1 }} />
        </Stack>
        <Skeleton variant="rounded" height={250} />
      </Stack>
    )
  }

  return (
    <Stack spacing={1.5} data-testid="opening-summary" sx={{ opacity: loading ? 0.7 : 1 }}>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="stretch">
        <ChartCard
          title="涵蓋"
          flex="0 1 340px"
          hintLabel="這四個數字是什麼"
          hint={
            <Hint>
              這頁每個數字的分母都是這四個之一：讀到換牌畫面的場次、換前四張全認出的、八格全認出的、有掛牌組的。愈往下愈少，所以卡片表的
              n 會比對局列表小。滑到每一條上看定義。
            </Hint>
          }
          aside={
            summary.pendingRetry > 0 && (
              <>
                <AutorenewIcon
                  data-testid="opening-pending"
                  sx={{
                    fontSize: 14,
                    color: 'info.light',
                    '@keyframes opening-spin': { to: { transform: 'rotate(360deg)' } },
                    animation: 'opening-spin 3s linear infinite'
                  }}
                />
                <Typography variant="caption" sx={{ ...NUMERIC, color: 'text.secondary' }}>
                  {summary.pendingRetry} 格待補認
                </Typography>
                <InfoHint
                  label="待補認是什麼意思"
                  title={
                    <Hint>
                      這些手牌格子還在背景等卡圖索引建完，建完會自動認出來，這頁的數字會跟著動。
                    </Hint>
                  }
                />
              </>
            )
          }
        >
          <CoverageFunnel summary={summary} />
        </ChartCard>

        <ChartCard
          title="換牌張數"
          flex="1 1 380px"
          hintLabel="換牌張數分佈怎麼讀"
          hint={
            <Hint>
              長條是準的：換了幾張是從畫面位置讀的，不用認出卡片，每一場讀到換牌畫面的都算。右邊的勝率則會偏
              -
              手牌差才會多換，所以「換得多、勝率低」大半是在講手牌本來就差，不是在講換牌這個決定。看分佈就好，勝率當參考；不到{' '}
              {OPENING_THRESHOLDS.wrShow} 手只印 n。
            </Hint>
          }
        >
          <SwapBandsChart
            all={summary.swapBands}
            byPlayOrder={summary.swapByPlayOrder}
            avgSwapped={summary.avgSwapped}
          />
        </ChartCard>
      </Stack>

      <ChartCard
        title="起手曲線"
        flex="1 1 auto"
        hintLabel="起手曲線怎麼讀"
        hint={
          <Hint>
            每個費用在手上平均有幾張：虛線框是發到的四張，實心是換完留下的四張，兩邊加起來都是
            4，所以差的就是你換掉了什麼、去找了什麼。上方的箭頭是平均費用從發到到留下的移動。只用八格全認出的手畫，不到{' '}
            {OPENING_THRESHOLDS.curve} 場不畫 - 少幾張卡算出來的不是比較粗的曲線，是錯的曲線。
          </Hint>
        }
      >
        <OpeningCurveChart
          curve={summary.curve}
          complete={summary.complete}
          avgCostPre={summary.avgCostPre}
          avgCostPost={summary.avgCostPost}
        />
      </ChartCard>
    </Stack>
  )
}
