// MatchAnalytics.tsx

import React, { useEffect, useMemo, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js'
import { Bar, Pie, Line } from 'react-chartjs-2'
import { format, fromUnixTime } from 'date-fns'
import { Box, Typography, Button, useTheme } from '@mui/material'

// 註冊 Chart.js 元件
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
)

type Match = {
  result: boolean | null // 1=win,0=lose,null=ongoing
  play_order: 'first' | 'second'
  my_class: string
  oppo_class: string
  playedAt: number // ms timestamp
  endedAt: number // ms timestamp
}

// interface Props {
//   data: Match[]
// }

// 同七大職業
const CLASS_LIST = ['elf', 'royal', 'witch', 'dragon', 'bishop', 'nightmare', 'nemesis']

const MatchAnalytics: React.FC = () => {
  const theme = useTheme()
  const [matches, setMatches] = useState<Match[]>([])
  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const data = await window.electron.ipcRenderer.invoke('matches:fetchAll')
        setMatches(data)
      } catch (err) {
        console.error('Load matches failed', err)
      }
    }
    load()
  }, [])
  // 篩選日期狀態
  const [start, setStart] = useState<Date | null>(null)
  const [end, setEnd] = useState<Date | null>(null)

  // 根據日期 filter data
  const filtered = useMemo(() => {
    return matches.filter((m) => {
      if (start && m.playedAt < start.getTime()) return false
      if (end && m.playedAt > end.getTime()) return false
      return true
    })
  }, [matches, start, end])

  // 1. 勝率：算 each my_class 的 played, wins
  const winRateData = useMemo(() => {
    const stats: Record<string, { win: number; total: number }> = {}
    CLASS_LIST.forEach((c) => (stats[c] = { win: 0, total: 0 }))
    filtered.forEach((m) => {
      if (m.my_class in stats && m.result !== null) {
        stats[m.my_class].total++
        if (m.result === true) stats[m.my_class].win++
      }
    })
    const labels = CLASS_LIST
    const rates = labels.map((c) =>
      stats[c].total > 0 ? +((100 * stats[c].win) / stats[c].total).toFixed(1) : 0
    )
    return { labels, rates }
  }, [filtered])

  console.log(filtered)
  console.log(winRateData)
  // 2. 先/後攻比例
  const orderStats = useMemo(() => {
    let first = 0,
      second = 0
    filtered.forEach((m) => {
      if (m.play_order === 'first') first++
      else second++
    })
    return { first, second, total: first + second }
  }, [filtered])

  // 3. 平均時長 (分鐘) 以日為單位
  const durationData = useMemo(() => {
    const byDay: Record<string, { sum: number; cnt: number }> = {}
    filtered.forEach((m) => {
      if (m.endedAt && m.playedAt) {
        const day = format(fromUnixTime(m.playedAt / 1000), 'yyyy-MM-dd')
        const diffMin = (m.endedAt - m.playedAt) / 1000 / 60
        if (!byDay[day]) byDay[day] = { sum: 0, cnt: 0 }
        byDay[day].sum += diffMin
        byDay[day].cnt += 1
      }
    })
    const days = Object.keys(byDay).sort()
    const avgs = days.map((d) => +(byDay[d].sum / byDay[d].cnt).toFixed(1))
    return { labels: days, avgs }
  }, [filtered])

  return (
    <Box>
      <Typography variant="h6" mb={2}>
        比賽分析
      </Typography>

      {/* 日期篩選 */}
      <Box display="flex" gap={2} mb={4}>
        {/* <DatePicker
          label="開始時間"
          value={start}
          onChange={(v) => setStart(v)}
          renderInput={(params) => <TextField {...params} />}
        />
        <DatePicker
          label="結束時間"
          value={end}
          onChange={(v) => setEnd(v)}
          renderInput={(params) => <TextField {...params} />}
        /> */}
        <Button
          onClick={() => {
            setStart(null)
            setEnd(null)
          }}
        >
          重置
        </Button>
      </Box>

      {/* 勝率長條圖 */}
      <Box mb={6}>
        <Typography>各職業勝率 (%)</Typography>
        <Bar
          data={{
            labels: winRateData.labels,
            datasets: [
              {
                label: '勝率',
                data: winRateData.rates,
                backgroundColor: 'rgba(54,162,235,0.6)'
              }
            ]
          }}
          options={{
            scales: { y: { beginAtZero: true, max: 100 } },
            plugins: {
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.parsed.y}%`
                }
              }
            }
          }}
        />
      </Box>

      {/* 先/後攻圓餅圖 */}
      <Box mb={6}>
        <Typography>先攻 / 後攻 比例</Typography>
        <Pie
          data={{
            labels: ['先攻', '後攻'],
            datasets: [
              {
                data: [orderStats.first, orderStats.second],
                backgroundColor: [theme.palette.primary.main, theme.palette.secondary.main]
              }
            ]
          }}
          options={{
            plugins: {
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const raw = ctx.parsed
                    const pct =
                      orderStats.total > 0 ? ((raw / orderStats.total) * 100).toFixed(1) : 0
                    return ` ${ctx.label}: ${raw} 場 (${pct}%)`
                  }
                }
              }
            }
          }}
        />
      </Box>

      {/* 日均時長折線圖 */}
      <Box mb={6}>
        <Typography>每日平均遊戲時長 (分鐘)</Typography>
        <Line
          data={{
            labels: durationData.labels,
            datasets: [
              {
                label: '平均時長',
                data: durationData.avgs,
                borderColor: 'rgba(255,99,132,0.8)',
                tension: 0.3
              }
            ]
          }}
          options={{
            scales: { y: { beginAtZero: true } },
            plugins: {
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.parsed.y} 分鐘`
                }
              }
            }
          }}
        />
      </Box>
    </Box>
  )
}

export default MatchAnalytics
