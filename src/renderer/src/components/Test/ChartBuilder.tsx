import React, { useState, useEffect } from 'react'
import {
  Box,
  Grid,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  ListItemText,
  Typography,
  TextField
} from '@mui/material'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import { Chart, registerables } from 'chart.js'
import { Bar, Line, Pie } from 'react-chartjs-2'

// 註冊 Chart.js 元件
Chart.register(...registerables)

// i18n 中文示例
const translations = {
  metricsLabel: '選擇統計項目',
  chartTypeLabel: '選擇圖表類型',
  classFilterLabel: '篩選職業',
  deckFilterLabel: '篩選牌組',
  startDateLabel: '開始日期',
  endDateLabel: '結束日期',
  loading: '載入中...',
  chartTitle: '數據分析'
}

const metricsOptions = [
  { value: 'winRateOverall', label: '各職業勝率' },
  { value: 'winRateFirst', label: '先攻勝率' },
  { value: 'winRateSecond', label: '後攻勝率' },
  { value: 'matchupWinRate', label: '對戰勝率' }
]
const chartTypes = [
  { value: 'bar', label: '長條圖' },
  { value: 'line', label: '折線圖' },
  { value: 'pie', label: '圓餅圖' }
]
const classOptions = [
  { value: 'elf', label: '精靈' },
  { value: 'royal', label: '皇家護衛' },
  { value: 'witch', label: '巫師' },
  { value: 'dragon', label: '龍族' },
  { value: 'nightmare', label: '夢魘' },
  { value: 'nemesis', label: '復仇者' },
  { value: 'bishop', label: '主教' }
]
const deckOptions = [
  { value: 'Aggro', label: '快攻' },
  { value: 'Control', label: '控場' },
  { value: 'Midrange', label: '中速' }
]

type Metric = (typeof metricsOptions)[number]['value']
type ChartType = (typeof chartTypes)[number]['value']

interface ChartDataResponse {
  labels: string[]
  datasets: { label: string; data: number[] }[]
}

async function fetchChartData(params: {
  metrics: Metric[]
  classes: string[]
  decks: string[]
  startDate: Date | null
  endDate: Date | null
}): Promise<ChartDataResponse> {
  return await window.electron.ipcRenderer.invoke('get-chart-data', {
    metrics: params.metrics,
    classes: params.classes,
    decks: params.decks,
    startDate: params.startDate?.toISOString() ?? null,
    endDate: params.endDate?.toISOString() ?? null
  })
}

export const ChartBuilder: React.FC = () => {
  const [metrics, setMetrics] = useState<Metric[]>(['winRateOverall'])
  const [chartType, setChartType] = useState<ChartType>('bar')
  const [classFilter, setClassFilter] = useState<string[]>([])
  const [deckFilter, setDeckFilter] = useState<string[]>([])
  const [startDate, setStartDate] = useState<Date | null>(null)
  const [endDate, setEndDate] = useState<Date | null>(null)
  const [chartData, setChartData] = useState<ChartDataResponse | null>(null)

  useEffect(() => {
    fetchChartData({ metrics, classes: classFilter, decks: deckFilter, startDate, endDate }).then(
      (data) => setChartData(data)
    )
  }, [metrics, classFilter, deckFilter, startDate, endDate])

  return (
    <Box p={2}>
      <Typography variant="h6" gutterBottom>
        {translations.chartTitle}
      </Typography>
      <Grid container spacing={2} alignItems="center">
        {/* 指標選擇 */}
        <Grid item xs={12} md={3}>
          <FormControl fullWidth>
            <InputLabel>{translations.metricsLabel}</InputLabel>
            <Select
              multiple
              value={metrics}
              onChange={(e) => setMetrics(e.target.value as Metric[])}
              renderValue={(selected) =>
                (selected as string[])
                  .map((v) => metricsOptions.find((o) => o.value === v)!.label)
                  .join(', ')
              }
            >
              {metricsOptions.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  <Checkbox checked={metrics.includes(opt.value)} />
                  <ListItemText primary={opt.label} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        {/* 圖表類型 */}
        <Grid item xs={6} md={2}>
          <FormControl fullWidth>
            <InputLabel>{translations.chartTypeLabel}</InputLabel>
            <Select value={chartType} onChange={(e) => setChartType(e.target.value as ChartType)}>
              {chartTypes.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        {/* 職業篩選 */}
        <Grid item xs={6} md={2}>
          <FormControl fullWidth>
            <InputLabel>{translations.classFilterLabel}</InputLabel>
            <Select
              multiple
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value as string[])}
              renderValue={(selected) =>
                (selected as string[])
                  .map((v) => classOptions.find((o) => o.value === v)!.label)
                  .join(', ')
              }
            >
              {classOptions.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  <Checkbox checked={classFilter.includes(opt.value)} />
                  <ListItemText primary={opt.label} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        {/* 牌組篩選 */}
        <Grid item xs={6} md={2}>
          <FormControl fullWidth>
            <InputLabel>{translations.deckFilterLabel}</InputLabel>
            <Select
              multiple
              value={deckFilter}
              onChange={(e) => setDeckFilter(e.target.value as string[])}
              renderValue={(selected) =>
                (selected as string[])
                  .map((v) => deckOptions.find((o) => o.value === v)!.label)
                  .join(', ')
              }
            >
              {deckOptions.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  <Checkbox checked={deckFilter.includes(opt.value)} />
                  <ListItemText primary={opt.label} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Grid>
        {/* 日期篩選 */}
        <Grid item xs={6} md={3}>
          <LocalizationProvider dateAdapter={AdapterDateFns}>
            <DatePicker
              label={translations.startDateLabel}
              value={startDate}
              onChange={(date) => setStartDate(date)}
              renderInput={(params) => <TextField {...params} fullWidth />}
            />
          </LocalizationProvider>
        </Grid>
        <Grid item xs={6} md={3}>
          <LocalizationProvider dateAdapter={AdapterDateFns}>
            <DatePicker
              label={translations.endDateLabel}
              value={endDate}
              onChange={(date) => setEndDate(date)}
              renderInput={(params) => <TextField {...params} fullWidth />}
            />
          </LocalizationProvider>
        </Grid>
      </Grid>

      <Box mt={4}>
        {chartData ? (
          chartType === 'bar' ? (
            <Bar data={chartData} />
          ) : chartType === 'line' ? (
            <Line data={chartData} />
          ) : (
            <Pie data={chartData} />
          )
        ) : (
          <Typography>{translations.loading}</Typography>
        )}
      </Box>
    </Box>
  )
}
