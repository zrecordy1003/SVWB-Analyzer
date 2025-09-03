import React, { useCallback, useEffect, useState } from 'react'
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'

import { classes, classesMap, modes } from '@renderer/map/classMap'
import LineChart from './component/LineChart'

import type { ClassName, GameMode } from '@prisma/client'
import type { RangeKey, RankedWinrateByOpponent } from 'src/main/ipc/helper'

function startOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function endOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

const datePickerStyle = {
  day: {
    sx: {
      '&.MuiPickersDay-dayOutsideMonth': { opacity: 0.35 },
      '&.Mui-disabled': {
        opacity: 1,
        color: 'text.disabled',
        backgroundColor: 'rgba(255,255,255,0.06)',
        border: '1px dashed',
        borderColor: 'divider',
        position: 'relative'
      },
      '&.Mui-selected.Mui-disabled': {
        backgroundColor: 'action.disabledBackground',
        color: 'text.disabled'
      }
    }
  }
}

const Analyzer: React.FC = () => {
  const localeText = pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText
  const [openStart, setOpenStart] = useState(false)
  const [openEnd, setOpenEnd] = useState(false)

  const [analyzeData, setAnalyzeData] = useState<RankedWinrateByOpponent | null>(null)

  const [rangeKey, setRangeKey] = useState<RangeKey>('today')
  const [startDate, setStartDate] = useState<Date | null>(new Date())
  const [endDate, setEndDate] = useState<Date | null>(new Date())

  const [selectedClass, setSelectedClass] = useState<ClassName>('elf')
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode>('ranked')

  // 初始載入：使用者上次選的職業/模式
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const [lastClass, lastMode, lastRangeKey, lastStartDate, lastEndDate] = await Promise.all([
        window.settings.get<ClassName>('analyzer.MyClass'),
        window.settings.get<GameMode>('analyzer.GameMode'),
        window.settings.get<RangeKey>('analyzer.RangeKey'),
        window.settings.get('analyzer.startDate'),
        window.settings.get('analyzer.endDate')
      ])
      if (!mounted) return

      if (lastClass && lastClass !== selectedClass) {
        setSelectedClass(lastClass)
      }

      if (lastMode && lastMode !== selectedGameMode) {
        setSelectedGameMode(lastMode)
      }

      if (lastRangeKey && lastRangeKey !== rangeKey) {
        setRangeKey(lastRangeKey)
      }

      if (lastStartDate && lastStartDate !== startDate) {
        setStartDate(new Date(lastStartDate))
      }

      if (lastEndDate && lastEndDate !== endDate) {
        setEndDate(new Date(lastEndDate))
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    window.settings.get<ClassName>('analyzer.myClass').then((v) => {
      if (v !== selectedClass)
        window.settings.set('analyzer.myClass', selectedClass).catch(() => {})
    })
  }, [selectedClass])

  useEffect(() => {
    window.settings.get<GameMode>('analyzer.gameMode').then((v) => {
      if (v !== selectedGameMode)
        window.settings.set('analyzer.gameMode', selectedGameMode).catch(() => {})
    })
  }, [selectedGameMode])

  useEffect(() => {
    window.settings.get<RangeKey>('analyzer.rangeKey').then((v) => {
      if (v !== rangeKey) window.settings.set('analyzer.rangeKey', rangeKey).catch(() => {})
    })
  }, [rangeKey])

  useEffect(() => {
    window.settings.get('analyzer.startDate').then((v) => {
      if (v !== startDate) window.settings.set('analyzer.startDate', startDate).catch(() => {})
    })
  }, [startDate])

  useEffect(() => {
    window.settings.get('analyzer.endDate').then((v) => {
      if (v !== endDate) window.settings.set('analyzer.endDate', endDate).catch(() => {})
    })
  }, [endDate])

  const [chartHeight, setChartHeight] = useState<number>(window.innerHeight * 0.3)

  const updateHeight = useCallback(() => {
    setChartHeight(window.innerHeight - 400 > 300 ? window.innerHeight - 400 : 300)
  }, [])

  useEffect(() => {
    updateHeight()
    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [updateHeight])

  // 資料載入
  const loadDataFor = useCallback(
    async (
      myClass: ClassName,
      gameMode: GameMode,
      rangeKey: RangeKey,
      s: Date | null,
      e: Date | null
    ) => {
      if (rangeKey === 'custom') {
        const stats = await window.matches.getRankedWinrate({
          myClass,
          gameMode: gameMode,
          start: s ?? undefined,
          end: e ?? undefined
        })
        setAnalyzeData(stats)
      } else {
        const stats = await window.matches.getRankedWinrate({
          myClass,
          gameMode: gameMode,
          rangeKey
        })
        setAnalyzeData(stats)
      }
    },
    []
  )

  // 視圖或篩選改變時載入
  useEffect(() => {
    loadDataFor(selectedClass, selectedGameMode, rangeKey, startDate, endDate)
  }, [selectedClass, selectedGameMode, rangeKey, startDate, endDate, loadDataFor])

  // 供 IPC 事件要求重抓資料
  useEffect(() => {
    const handler = (): Promise<void> =>
      loadDataFor(selectedClass, selectedGameMode, rangeKey, startDate, endDate)
    const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsubscribeRefetch()
    }
  }, [loadDataFor, selectedClass, selectedGameMode, rangeKey, startDate, endDate])

  const handleChangeStart = (d: Date | null): void => {
    setRangeKey('custom')
    if (d && endDate && endDate < d) {
      setStartDate(d)
      setEndDate(endOf(d))
    } else {
      setStartDate(d)
    }
  }
  const handleChangeEnd = (d: Date | null): void => {
    setRangeKey('custom')
    if (d && startDate && startDate > d) {
      setStartDate(startOf(d))
      setEndDate(d)
    } else {
      setEndDate(d)
    }
  }
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5
        }}
      >
        <ToggleButtonGroup
          size="small"
          value={selectedClass}
          exclusive
          onChange={(_, val) => val && setSelectedClass(val)}
          sx={{
            '& .Mui-selected': {
              bgcolor: classesMap[selectedClass ?? 'elf'].bgColor
            },
            '& .Mui-selected:hover': {
              bgcolor: classesMap[selectedClass ?? 'elf'].bgColor
            }
          }}
        >
          {classes.map((c) => (
            <ToggleButton sx={{ width: '100px', minWidth: '100px' }} key={c.id} value={c.id}>
              <Typography sx={{ color: c.color }}>{c.label}</Typography>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Box display={'flex'} justifyContent={'space-between'}>
          <ToggleButtonGroup
            size="small"
            value={selectedGameMode}
            exclusive
            onChange={(_, val) => val && setSelectedGameMode(val)}
          >
            {modes.map((m) => (
              <ToggleButton sx={{ width: '100px' }} key={m.id} value={m.id}>
                <Typography color={m.color}>{m.label}</Typography>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
        <Box display={'flex'} gap={2}>
          <ToggleButtonGroup
            size="small"
            value={rangeKey}
            exclusive
            onChange={(_, v: RangeKey) => v && setRangeKey(v)}
            sx={{ mb: 1 }}
          >
            <ToggleButton sx={{ width: '80px' }} value="today">
              <Typography>今天</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="7d">
              <Typography>7 天內</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="30d">
              <Typography>30 天內</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="all">
              <Typography>生涯</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="custom">
              <Typography>自訂</Typography>
            </ToggleButton>
          </ToggleButtonGroup>
          {rangeKey === 'custom' && (
            <LocalizationProvider
              dateAdapter={AdapterDateFns}
              adapterLocale={dfZhTW}
              localeText={localeText}
            >
              <Box display="flex" gap={2}>
                <DatePicker
                  reduceAnimations
                  label="開始日期"
                  open={openStart}
                  onOpen={() => setOpenStart(true)}
                  onClose={() => setOpenStart(false)}
                  value={startDate}
                  onChange={handleChangeStart}
                  format="yyyy/MM/dd"
                  disableFuture
                  slotProps={{
                    day: datePickerStyle.day,
                    textField: { size: 'small', onClick: () => setOpenStart(true) },
                    popper: { keepMounted: true }
                  }}
                />
                <DatePicker
                  reduceAnimations
                  label="結束日期"
                  open={openEnd}
                  onOpen={() => setOpenEnd(true)}
                  onClose={() => setOpenEnd(false)}
                  value={endDate}
                  onChange={handleChangeEnd}
                  format="yyyy/MM/dd"
                  disableFuture
                  slotProps={{
                    day: datePickerStyle.day,
                    textField: { size: 'small', onClick: () => setOpenEnd(true) },
                    popper: { keepMounted: true }
                  }}
                />
              </Box>
            </LocalizationProvider>
          )}
        </Box>
      </Box>
      <LineChart data={analyzeData} height={chartHeight} />
    </Box>
  )
}

export default Analyzer
