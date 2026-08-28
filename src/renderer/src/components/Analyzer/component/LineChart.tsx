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

import { classes, classesMap } from '@renderer/map/classMap'
import { LOW_SAMPLE_THRESHOLD, isLowSample } from '../confidence'

import type { RankedWinrateByOpponent } from '@shared/types'

type SortBy = 'class' | 'total' | 'winrate'

type LineChartProps = {
  data: RankedWinrateByOpponent | null | undefined
  height?: number
  /**
   * Defaults to the fixed class order. Sorting by volume moved a class between
   * rows every time the filters changed, which made two views impossible to
   * compare side by side.
   */
  sortBy?: SortBy
}

const FIRST_COLOR = '#64b5f6' // 先攻
const SECOND_COLOR = '#ce93d8' // 後攻
/** Same hue at 45%, for rows whose sample is too small to act on. */
const FIRST_COLOR_DIM = '#64b5f673'
const SECOND_COLOR_DIM = '#ce93d873'

// 0% 時給一個很細的可見寬度（僅用於繪圖，文字仍顯示 0.0%）
const MIN_BAR_PCT_RENDER = 1.0

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend)

/** ---------- Helpers ---------- */
const LABEL_FONT = '12px system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans TC", sans-serif'
const SUB_FONT = '11px system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans TC", sans-serif'

const CLASS_ORDER_INDEX = new Map<string, number>(classes.map((c, i) => [String(c.id), i]))

function measureMaxLabelWidthWithFont(lines: string[], font: string): number {
  if (!lines?.length) return 0
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  let max = 0
  for (const s of lines) max = Math.max(max, Math.ceil(ctx.measureText(String(s)).width))
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
    const textColor = 'rgba(255,255,255,0.95)'

    ctx.save()
    ctx.font = LABEL_FONT

    data.datasets.forEach((ds: any, di: number) => {
      const meta = chart.getDatasetMeta(di)

      if (meta.hidden || !chart.isDatasetVisible(di)) return

      meta.data.forEach((bar: any, i: number) => {
        if (!bar || bar.skip) return

        // 使用 rawVals（真實%）顯示文字；data 是繪圖值（可能被最小化）
        const rawVals: Array<number | null> = ds.rawVals ?? ds.data
        const raw = rawVals?.[i]
        if (raw == null) return

        const val = Number(raw)
        if (!Number.isFinite(val)) return

        const totals: number[] = ds.totals ?? []
        const t = totals[i] ?? 0
        const low: boolean[] = ds.lowSample ?? []
        const isLow = low[i] === true

        // 樣本不足的那一列標記出來：同一個百分比，可信度差了一個量級。
        const label = `${isLow ? '⚠ ' : ''}${val.toFixed(1)}% (${t})`
        const metrics = ctx.measureText(label)
        const textW = Math.ceil(metrics.width)
        const textH = 14

        let x = bar.x + margin
        const y = bar.y - textH / 2
        const willOverflowRight = x + padX * 2 + textW > chartArea.right - 2
        if (willOverflowRight) {
          x = bar.x - margin - (padX * 2 + textW)
        }

        ctx.fillStyle = isLow
          ? 'rgba(110, 110, 118, 1)'
          : val >= 50
            ? 'rgba(66, 133, 66, 1)'
            : 'rgba(158, 72, 72, 1)'

        roundRect(ctx, x, y - padY, textW + padX * 2, textH + padY * 2, 8)
        ctx.fill()

        ctx.fillStyle = textColor
        ctx.fillText(label, x + padX, y + textH - 7)
      })
    })
    ctx.restore()
  }
}

/** 左側職業名稱上色（不改 options） */
const coloredTicksPlugin = {
  id: 'coloredTicks',
  afterDraw(chart: Chart) {
    const { ctx, scales, data } = chart
    const yScale = (scales as any).y
    if (!yScale) return

    const labels: string[] = (data.labels as string[]) ?? []

    const opts: any = (chart.options as any)?.plugins?.coloredTicks ?? {}
    const bottomLabels: string[] = opts.bottomLabels ?? []
    const bottomColors: string[] = opts.bottomColors ?? []
    const dimmed: boolean[] = opts.dimmed ?? []

    ctx.save()
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'

    labels.forEach((label, i) => {
      const entry = Object.values(classesMap).find((c: any) => c.label === label) as
        | { label: string; color?: string }
        | undefined
      const color = entry?.color ?? 'rgba(255,255,255,0.9)'

      const x = yScale.left - 6
      const y = yScale.getPixelForValue(i)

      // 上行：職業名（原本顏色；沒對戰過的列整體壓暗）
      ctx.font = LABEL_FONT
      ctx.globalAlpha = dimmed[i] ? 0.4 : 1
      ctx.fillStyle = color
      ctx.fillText(label, x, y - 7)

      // 下行：勝率/場數（≥50% 綠、<50% 紅）
      const sub = bottomLabels[i] ?? ''
      if (sub) {
        ctx.font = SUB_FONT
        ctx.fillStyle = bottomColors[i] ?? 'rgba(255,255,255,0.7)'
        ctx.fillText(sub, x, y + 9)
      }
      ctx.globalAlpha = 1
    })

    ctx.restore()
  }
}

/**
 * 完全沒對戰過的職業：畫一個「尚無對戰」小膠囊。
 *
 * 這一列現在一定存在（後端固定回傳全部職業），所以必須主動說明它為什麼是空
 * 的 —— 一整條空白會被讀成繪圖出錯，而不是「還沒遇過這個職業」。
 */
const emptyRowMarkerPlugin = {
  id: 'emptyRowMarker',
  afterDatasetsDraw(chart: Chart) {
    const { ctx, chartArea, scales } = chart
    const xScale = (scales as any).x
    const yScale = (scales as any).y
    if (!xScale || !yScale) return

    const opts: any = (chart.options as any)?.plugins?.emptyRowMarker ?? {}
    const emptyRows: boolean[] = opts.emptyRows ?? []
    if (!emptyRows.some(Boolean)) return

    const padX = 8
    const padY = 3
    const textH = 14
    const label = '尚無對戰'

    ctx.save()
    ctx.font = SUB_FONT
    const textW = Math.ceil(ctx.measureText(label).width)
    const x = Math.min(xScale.getPixelForValue(2), chartArea.right - (textW + padX * 2) - 2)

    emptyRows.forEach((isEmpty, i) => {
      if (!isEmpty) return
      const y = yScale.getPixelForValue(i) - textH / 2

      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      roundRect(ctx, x, y - padY, textW + padX * 2, textH + padY * 2, 8)
      ctx.fill()

      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillText(label, x + padX, y + textH - 7)
    })

    ctx.restore()
  }
}

const LineChart: React.FC<LineChartProps> = ({ data: stats, height = 440, sortBy = 'class' }) => {
  const chartData = useMemo(() => {
    if (!stats?.byOpponent) {
      return { labels: [], datasets: [] } as any
    }

    const rows = Object.entries(stats.byOpponent).map(([oppKey, s]) => {
      const label = classesMap[oppKey as keyof typeof classesMap]?.label ?? oppKey

      const fTotal = Number(s.first.total ?? 0)
      const sTotal = Number(s.second.total ?? 0)
      const allTotal = Number(s.all.total ?? 0)

      const rawF = fTotal > 0 ? +Number(s.first.winRate ?? 0).toFixed(1) : null
      const rawS = sTotal > 0 ? +Number(s.second.winRate ?? 0).toFixed(1) : null

      const renderF = rawF == null ? null : rawF === 0 ? MIN_BAR_PCT_RENDER : rawF
      const renderS = rawS == null ? null : rawS === 0 ? MIN_BAR_PCT_RENDER : rawS

      return {
        key: oppKey,
        label,
        total: allTotal,
        overallWinRate: Number(s.all.winRate ?? 0),
        overallWins: Number(s.all.wins ?? 0),
        rawFirstVal: rawF,
        rawSecondVal: rawS,
        renderFirstVal: renderF,
        renderSecondVal: renderS,
        firstWins: Number(s.first.wins ?? 0),
        firstTotal: fTotal,
        secondWins: Number(s.second.wins ?? 0),
        secondTotal: sTotal
      }
    })

    const sorted = [...rows].sort((a, b) => {
      if (sortBy === 'winrate') return b.overallWinRate - a.overallWinRate
      if (sortBy === 'total') return b.total - a.total
      // 固定職業順序：同一個職業永遠在同一列，兩個時間區間才比得起來。
      const ai = CLASS_ORDER_INDEX.get(a.key) ?? 9999
      const bi = CLASS_ORDER_INDEX.get(b.key) ?? 9999
      return ai - bi || a.label.localeCompare(b.label)
    })

    const labels = sorted.map((r) => r.label)
    const emptyRows = sorted.map((r) => r.total === 0)

    const bottomLabels = sorted.map((r) =>
      r.total === 0 ? '—' : `${r.overallWinRate.toFixed(1)}% (${r.total})`
    )
    const bottomColors = sorted.map((r) => {
      if (r.total === 0) return 'rgba(255,255,255,0.35)'
      if (isLowSample(r.total)) return 'rgba(255,255,255,0.55)'
      return r.overallWinRate >= 50 ? '#2e7d32' : '#c62828'
    })

    const firstLow = sorted.map((r) => isLowSample(r.firstTotal))
    const secondLow = sorted.map((r) => isLowSample(r.secondTotal))

    return {
      labels,
      _bottomLabels: bottomLabels,
      _bottomColors: bottomColors,
      _emptyRows: emptyRows,
      datasets: [
        {
          label: '先攻',
          data: sorted.map((r) => r.renderFirstVal),
          rawVals: sorted.map((r) => r.rawFirstVal),
          backgroundColor: firstLow.map((low) => (low ? FIRST_COLOR_DIM : FIRST_COLOR)),
          borderColor: FIRST_COLOR,
          borderWidth: firstLow.map((low) => (low ? 1 : 0)),
          borderRadius: 6,
          wins: sorted.map((r) => r.firstWins),
          totals: sorted.map((r) => r.firstTotal),
          lowSample: firstLow
        },
        {
          label: '後攻',
          data: sorted.map((r) => r.renderSecondVal),
          rawVals: sorted.map((r) => r.rawSecondVal),
          backgroundColor: secondLow.map((low) => (low ? SECOND_COLOR_DIM : SECOND_COLOR)),
          borderColor: SECOND_COLOR,
          borderWidth: secondLow.map((low) => (low ? 1 : 0)),
          borderRadius: 6,
          wins: sorted.map((r) => r.secondWins),
          totals: sorted.map((r) => r.secondTotal),
          lowSample: secondLow
        }
      ] as any
    }
  }, [stats, sortBy])

  // 依 labels 寬度動態計算左側 padding（在 React 端，不在 plugin 裡改 options）
  const leftPadding = useMemo(() => {
    const labels = (chartData.labels as string[]) ?? []
    const d: any = chartData
    const bot = (d._bottomLabels as string[]) ?? []

    const wTop = measureMaxLabelWidthWithFont(labels, LABEL_FONT)
    const wBot = measureMaxLabelWidthWithFont(bot, SUB_FONT)
    return Math.max(40, Math.max(wTop, wBot) + 18)
  }, [chartData])

  const bottomStuff = useMemo(() => {
    const dAny: any = chartData
    return {
      bottomLabels: (dAny?._bottomLabels as string[]) ?? [],
      bottomColors: (dAny?._bottomColors as string[]) ?? [],
      emptyRows: (dAny?._emptyRows as boolean[]) ?? []
    }
  }, [chartData])

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
            },
            afterLabel: (ctx: any) => {
              const totals: number[] = ctx.dataset?.totals ?? []
              const t = totals[ctx.dataIndex] ?? 0
              return t > 0 && t < LOW_SAMPLE_THRESHOLD ? '樣本不足，勝率僅供參考' : ''
            }
          }
        },
        coloredTicks: {
          bottomLabels: bottomStuff.bottomLabels,
          bottomColors: bottomStuff.bottomColors,
          dimmed: bottomStuff.emptyRows
        },
        emptyRowMarker: { emptyRows: bottomStuff.emptyRows }
      }
    }),
    [leftPadding, bottomStuff.bottomLabels, bottomStuff.bottomColors, bottomStuff.emptyRows]
  )

  // `byOpponent` now always carries every class, so an empty result set is
  // identified by the match count rather than by the shape of the object.
  if (!stats || !stats.byOpponent || stats.overall.all.total === 0) {
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
          這組篩選條件下沒有任何對戰紀錄，試著放寬時間區間或關閉牌組／CR 篩選
        </Typography>
      </Box>
    )
  }

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
            {stats.myDecks && stats.myDecks.length > 0 && (
              <Box display={'flex'} alignItems={'center'}>
                <Typography variant="h6" mr={1}>
                  使用牌組
                </Typography>

                <Typography variant="h6" display={'flex'}>
                  {'['}
                  <Box display={'flex'} mx={1}>
                    {stats.myDecks.map((v, index) => (
                      <Box key={v.id}>
                        {v.name}
                        {index < stats.myDecks!.length - 1 && '、'}
                      </Box>
                    ))}
                  </Box>
                  {']'}
                </Typography>
              </Box>
            )}
            <Typography variant="h6" fontWeight={700} color="rgba(255,255,255,0.9)">
              對各職業勝率
            </Typography>
          </Box>
          <Typography variant="caption" color="rgba(255,255,255,0.7)">
            {period}
          </Typography>
        </Box>
        {typeof stats.crMin === 'number' && typeof stats.crMax === 'number' && (
          <Typography component={'span'} variant="subtitle1" sx={{ opacity: 0.8 }}>
            CR 區間：{stats.crMin} ~ {stats.crMax}
          </Typography>
        )}
        <Box mt={1.5} display="flex" gap={2} flexWrap="nowrap" alignItems="baseline">
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
            {stats.overall.first.total > 0 ? (
              <>
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
              </>
            ) : (
              <Typography variant="subtitle1" component="span" sx={{ color: 'gray' }}>
                暫無數據
              </Typography>
            )}
          </Box>

          {/* 後攻勝率 */}
          <Box display="inline-flex" alignItems="baseline" sx={{ whiteSpace: 'nowrap' }}>
            <Typography variant="subtitle1" sx={{ opacity: 0.8 }} component="span">
              後攻勝率：
            </Typography>
            {stats.overall.second.total > 0 ? (
              <>
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
              </>
            ) : (
              <Typography variant="subtitle1" component="span" sx={{ color: 'gray' }}>
                暫無數據
              </Typography>
            )}
          </Box>
        </Box>

        <Typography variant="caption" sx={{ opacity: 0.55, display: 'block', mt: 0.5 }}>
          ⚠ 與半透明柱體代表樣本不足 {LOW_SAMPLE_THRESHOLD} 場，勝率僅供參考。
        </Typography>

        <Divider sx={{ my: 1 }} />

        <Box sx={{ width: '100%', height }}>
          <Bar
            data={chartData}
            options={options}
            plugins={[valueLabelPlugin, coloredTicksPlugin, emptyRowMarkerPlugin]}
          />
        </Box>
      </CardContent>
    </Card>
  )
}

export default LineChart
