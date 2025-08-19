/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useMemo } from 'react'
import { Card, CardContent, Box, Typography, Divider } from '@mui/material'
import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
  Chart
} from 'chart.js'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { classesMap } from '@renderer/map/classMap'

import type { ClassName } from '@prisma/client'

type Stat = { wins: number; total: number; winRate: number }
type SideStats = { first: Stat; second: Stat; all: Stat }
export type RankedWinrateByOpponent = {
  myClass: ClassName
  start: number | null
  end: number | null
  byOpponent: Record<string, SideStats>
  overall: SideStats
}

type LineChartProps = {
  data: RankedWinrateByOpponent | null | undefined
  height?: number
  sortBy?: 'total' | 'winrate'
}

const FIRST_COLOR = '#64b5f6' // 先攻
const SECOND_COLOR = '#ce93d8' // 後攻

// 0% 時給一個很細的可見寬度（僅用於繪圖，文字仍顯示 0.0%）
const MIN_BAR_PCT_RENDER = 1.0

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend)

/** ---------- Helpers ---------- */
const LABEL_FONT = '12px system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans TC", sans-serif'

function measureMaxLabelWidth(labels: string[], font = LABEL_FONT): number {
  if (!labels?.length) return 0
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  let max = 0
  for (const s of labels) {
    const w = Math.ceil(ctx.measureText(String(s)).width)
    if (w > max) max = w
  }
  return max
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, h / 2, w / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** 末端文字：% + (場數)。若將溢出右界，改畫在柱體左內側（膠囊底） */
const valueLabelPlugin = {
  id: 'valueLabel',
  afterDatasetsDraw(chart: Chart) {
    const { ctx, data, chartArea } = chart
    const margin = 6
    const padX = 6
    const padY = 3
    const pillBg = 'rgba(0,0,0,0.35)'
    const textColor = 'rgba(255,255,255,0.95)'

    ctx.save()
    ctx.font = LABEL_FONT

    data.datasets.forEach((ds: any, di: number) => {
      const meta = chart.getDatasetMeta(di)
      meta.data.forEach((bar: any, i: number) => {
        // 使用 rawVals（真實%）顯示文字；data 是繪圖值（可能被最小化）
        const rawVals: Array<number | null> = ds.rawVals ?? ds.data
        const raw = rawVals?.[i]
        if (raw == null) return

        const val = Number(raw)
        if (!Number.isFinite(val)) return

        const totals: number[] = ds.totals ?? []
        const t = totals[i] ?? 0

        const label = `${val.toFixed(1)}% (${t})`
        const metrics = ctx.measureText(label)
        const textW = Math.ceil(metrics.width)
        const textH = 14

        let x = bar.x + margin
        const y = bar.y - textH / 2
        const willOverflowRight = x + padX * 2 + textW > chartArea.right - 2
        if (willOverflowRight) {
          x = bar.x - margin - (padX * 2 + textW)
        }

        ctx.fillStyle = pillBg
        roundRect(ctx, x, y - padY, textW + padX * 2, textH + padY * 2, 8)
        ctx.fill()

        ctx.fillStyle = textColor
        ctx.fillText(label, x + padX, y + textH - 7)
      })
    })
    ctx.restore()
  }
}

/** 50% 參考線 */
// const midlinePlugin = {
//   id: 'midline',
//   afterDraw(chart: Chart) {
//     const { ctx, chartArea, scales } = chart
//     const xScale = (scales as any).x
//     if (!xScale) return
//     const x = xScale.getPixelForValue(50)
//     ctx.save()
//     ctx.strokeStyle = 'rgba(255,255,255,0.25)'
//     ctx.setLineDash([3, 3])
//     ctx.beginPath()
//     ctx.moveTo(x, chartArea.top)
//     ctx.lineTo(x, chartArea.bottom)
//     ctx.stroke()
//     ctx.restore()
//   }
// }

/** 左側職業名稱上色（不改 options） */
const coloredTicksPlugin = {
  id: 'coloredTicks',
  afterDraw(chart: Chart) {
    const { ctx, scales, data } = chart
    const yScale = (scales as any).y
    if (!yScale) return
    const labels: string[] = (data.labels as string[]) ?? []

    ctx.save()
    ctx.font = LABEL_FONT
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'

    labels.forEach((label, i) => {
      const entry = Object.values(classesMap).find((c: any) => c.label === label) as
        | { label: string; color?: string }
        | undefined
      const color = entry?.color ?? 'rgba(255,255,255,0.9)'
      const x = yScale.left - 6
      const y = yScale.getPixelForValue(i)
      ctx.fillStyle = color
      ctx.fillText(label, x, y)
    })

    ctx.restore()
  }
}

/** 沒有數據的那一側（先/後）顯示「尚無資料」小膠囊 */
// const emptySideMarkerPlugin = {
//   id: 'emptySideMarker',
//   afterDatasetsDraw(chart: Chart) {
//     const { ctx, data, chartArea, scales } = chart
//     const xScale = (scales as any).x
//     if (!xScale) return

//     const padX = 6
//     const padY = 3
//     const textH = 14
//     // const margin = 4
//     const pillBg = 'rgba(255,255,255,0.12)'
//     const textColor = 'rgba(255,255,255,0.75)'
//     const placeX = xScale.getPixelForValue(5) // 文字靠左側 ~5%

//     ctx.save()
//     ctx.font = LABEL_FONT

//     data.datasets.forEach((ds: any, di: number) => {
//       const meta = chart.getDatasetMeta(di)
//       meta.data.forEach((bar: any, i: number) => {
//         const v = ds.data?.[i]
//         // 僅在「該側為 null（未對戰）」時顯示
//         if (v != null) return

//         // const label = `${ds.label} - 尚無資料`
//         const label = ''
//         const w = Math.ceil(ctx.measureText(label).width)
//         let x = placeX
//         const y = bar?.y - textH / 2 // bar 物件仍存在，可取到 y

//         // 避免超出右邊界
//         if (x + w + padX * 2 > chartArea.right - 2) {
//           x = chartArea.right - 2 - (w + padX * 2)
//         }

//         ctx.fillStyle = pillBg
//         roundRect(ctx, x, y - padY, w + padX * 2, textH + padY * 2, 8)
//         ctx.fill()

//         ctx.fillStyle = textColor
//         ctx.fillText(label, x + padX, y + textH - 7)
//       })
//     })

//     ctx.restore()
//   }
// }

const LineChart: React.FC<LineChartProps> = ({ data: stats, height = 440, sortBy = 'total' }) => {
  if (!stats || !stats.byOpponent || Object.keys(stats.byOpponent).length === 0) {
    return (
      <Box
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        p={4}
        gap={1.5}
        sx={{
          border: '1px dashed',
          borderColor: 'rgba(255,255,255,0.2)',
          borderRadius: 2,
          backgroundColor: 'rgba(255,255,255,0.05)',
          minHeight: 200
        }}
      >
        <InfoOutlinedIcon color="disabled" sx={{ fontSize: 40, opacity: 0.6 }} />

        <Typography variant="body1" sx={{ opacity: 0.8 }}>
          尚無資料
        </Typography>

        <Typography variant="caption" sx={{ opacity: 0.6, textAlign: 'center' }}>
          完成更多對戰後，即可查看統計數據
        </Typography>
      </Box>
    )
  }

  // 轉 Chart.js 的資料：total=0 → null，不畫柱／交由 emptySideMarker 顯示「尚無資料」
  const chartData = useMemo(() => {
    const rows = Object.entries(stats.byOpponent).map(([oppKey, s]) => {
      const label = classesMap[oppKey as keyof typeof classesMap]?.label ?? oppKey

      const fTotal = Number(s.first.total ?? 0)
      const sTotal = Number(s.second.total ?? 0)

      const rawF = fTotal > 0 ? +Number(s.first.winRate ?? 0).toFixed(1) : null
      const rawS = sTotal > 0 ? +Number(s.second.winRate ?? 0).toFixed(1) : null

      // 視覺渲染值：0% → 最小 1% 寬，避免完全看不到
      const renderF = rawF == null ? null : rawF === 0 ? MIN_BAR_PCT_RENDER : rawF
      const renderS = rawS == null ? null : rawS === 0 ? MIN_BAR_PCT_RENDER : rawS

      return {
        label,
        total: Number(s.all.total ?? 0),
        rawFirstVal: rawF,
        rawSecondVal: rawS,
        renderFirstVal: renderF,
        renderSecondVal: renderS,
        firstWins: Number(s.first.wins ?? 0),
        firstTotal: fTotal,
        secondWins: Number(s.second.wins ?? 0),
        secondTotal: sTotal,
        overallWinRate: Number(s.all.winRate ?? 0)
      }
    })

    const sorted = rows.sort((a, b) =>
      sortBy === 'winrate' ? b.overallWinRate - a.overallWinRate : b.total - a.total
    )

    const labels = sorted.map((r) => r.label)
    const firstRenderVals = sorted.map((r) => r.renderFirstVal)
    const secondRenderVals = sorted.map((r) => r.renderSecondVal)
    const firstRawVals = sorted.map((r) => r.rawFirstVal)
    const secondRawVals = sorted.map((r) => r.rawSecondVal)
    const firstWins = sorted.map((r) => r.firstWins)
    const firstTotals = sorted.map((r) => r.firstTotal)
    const secondWins = sorted.map((r) => r.secondWins)
    const secondTotals = sorted.map((r) => r.secondTotal)

    return {
      labels,
      datasets: [
        {
          label: '先攻',
          data: firstRenderVals, // 用於繪圖（含 0%→1%）
          rawVals: firstRawVals, // 用於顯示文字（真實%）
          backgroundColor: FIRST_COLOR,
          borderRadius: 6,
          wins: firstWins,
          totals: firstTotals
        },
        {
          label: '後攻',
          data: secondRenderVals,
          rawVals: secondRawVals,
          backgroundColor: SECOND_COLOR,
          borderRadius: 6,
          wins: secondWins,
          totals: secondTotals
        }
      ] as any
    }
  }, [stats, sortBy])

  // 依 labels 寬度動態計算左側 padding（在 React 端，不在 plugin 裡改 options）
  const leftPadding = useMemo(() => {
    const labels = (chartData.labels as string[]) ?? []
    const maxW = measureMaxLabelWidth(labels)
    return Math.max(40, maxW + 18)
  }, [chartData.labels])

  const options = useMemo(
    () => ({
      indexAxis: 'y' as const,
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 8, left: leftPadding } },
      scales: {
        x: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(255,255,255,0.08)' },
          ticks: { color: 'rgba(255,255,255,0.85)', callback: (v: any) => `${v}%` }
        },
        y: {
          grid: { display: false },
          ticks: { display: false } // 交由 coloredTicksPlugin 自繪
        }
      },
      plugins: {
        legend: { labels: { color: 'rgba(255,255,255,0.9)' } },
        tooltip: {
          backgroundColor: '#1f2127',
          borderColor: 'rgba(255,255,255,.15)',
          borderWidth: 1,
          callbacks: {
            label: (ctx: any) => {
              const rawVals: Array<number | null> = ctx.dataset?.rawVals ?? []
              const raw = rawVals[ctx.dataIndex]
              const wins: number[] = ctx.dataset?.wins ?? []
              const totals: number[] = ctx.dataset?.totals ?? []
              const w = wins[ctx.dataIndex] ?? 0
              const t = totals[ctx.dataIndex] ?? 0
              if (raw == null || !t) return `${ctx.dataset.label}: 尚無資料`
              return `${ctx.dataset.label}: ${raw.toFixed(1)}% (${w}/${t})`
            }
          }
        }
      }
    }),
    [leftPadding]
  )

  const period =
    stats.start && stats.end
      ? `${new Date(stats.start).toLocaleDateString()} – ${new Date(stats.end).toLocaleDateString()}`
      : '全部期間'

  const winFirst = Number(stats.overall.first.winRate.toFixed(1))
  const winSecond = Number(stats.overall.second.winRate.toFixed(1))
  const winAll = Number(stats.overall.all.winRate.toFixed(1))

  return (
    <Card sx={{ background: 'rgba(255,255,255,0.06)', color: '#fff' }}>
      <CardContent>
        <Box display="flex" justifyContent="space-between" alignItems="baseline" mb={1}>
          <Box display="flex" alignItems="baseline" gap={1}>
            <Typography
              variant="h6"
              fontWeight={700}
              sx={{ color: classesMap[stats.myClass]?.color }}
            >
              {classesMap[stats.myClass]?.label ?? stats.myClass}
            </Typography>
            <Typography variant="h6" fontWeight={700} color="rgba(255,255,255,0.9)">
              對各職業勝率
            </Typography>
          </Box>
          <Typography variant="caption" color="rgba(255,255,255,0.7)">
            {period}
          </Typography>
        </Box>

        <Box
          mt={1.5}
          display="flex"
          gap={2}
          flexWrap="nowrap" // ← 不允許自動換行
          alignItems="baseline"
        >
          {/* 總場數 */}
          <Box display="inline-flex" alignItems="baseline" sx={{ whiteSpace: 'nowrap' }}>
            <Typography variant="subtitle1" sx={{ opacity: 0.8 }} component="span">
              總場數：
            </Typography>
            <Typography variant="subtitle1" component="span">
              {stats.overall.all.total}
            </Typography>
          </Box>
          {/* 總勝率 */}
          <Box display="inline-flex" alignItems="baseline" sx={{ whiteSpace: 'nowrap' }}>
            <Typography variant="subtitle1" sx={{ opacity: 0.8 }} component="span">
              總勝率：
            </Typography>
            <Typography
              variant="subtitle1"
              component="span"
              sx={{ color: winAll >= 50 ? 'success.main' : 'error.main' }}
            >
              {winAll.toFixed(1)}%
            </Typography>
          </Box>

          {/* 先攻勝率 */}
          <Box display="inline-flex" alignItems="baseline" sx={{ whiteSpace: 'nowrap' }}>
            <Typography variant="subtitle1" sx={{ opacity: 0.8 }} component="span">
              先攻勝率：
            </Typography>
            <Typography
              variant="subtitle1"
              component="span"
              sx={{ color: winFirst >= 50 ? 'success.main' : 'error.main' }}
            >
              {winFirst.toFixed(1)}%
            </Typography>
            <Typography variant="subtitle1" sx={{ opacity: 0.8 }} component="span">
              &nbsp;({stats.overall.first.total})
            </Typography>
          </Box>

          {/* 後攻勝率 */}
          <Box display="inline-flex" alignItems="baseline" sx={{ whiteSpace: 'nowrap' }}>
            <Typography variant="subtitle1" sx={{ opacity: 0.8 }} component="span">
              後攻勝率：
            </Typography>
            <Typography
              variant="subtitle1"
              component="span"
              sx={{ color: winSecond >= 50 ? 'success.main' : 'error.main' }}
            >
              {winSecond.toFixed(1)}%
            </Typography>
            <Typography variant="subtitle1" sx={{ opacity: 0.8 }} component="span">
              &nbsp;({stats.overall.second.total})
            </Typography>
          </Box>
        </Box>
        <Divider sx={{ my: 1 }} />

        <Box sx={{ width: '100%', height }}>
          <Bar
            data={chartData}
            options={options}
            plugins={[valueLabelPlugin, coloredTicksPlugin]}
          />
        </Box>
      </CardContent>
    </Card>
  )
}

export default LineChart
