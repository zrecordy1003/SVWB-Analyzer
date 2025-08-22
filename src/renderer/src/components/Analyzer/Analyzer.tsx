import React, { useCallback, useEffect, useState } from 'react'
import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { classes, classesMap, modes } from '@renderer/map/classMap'
import LineChart from './component/LineChart'

import type { ClassName, GameMode } from '@prisma/client'
import type { RangeKey, RankedWinrateByOpponent } from 'src/main/ipc/helper'

const Analyzer: React.FC = () => {
  const [analyzeData, setAnalyzeData] = useState<RankedWinrateByOpponent | null>(null)

  const [rangeKey, setRangeKey] = useState<RangeKey>('today')

  const [selectedClass, setSelectedClass] = useState<ClassName>('elf')
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode>('ranked')

  // 初始載入：使用者上次選的職業/模式
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const [lastClass, lastMode, lastRangeKey] = await Promise.all([
        window.settings.get<ClassName>('analyzerMyClass'),
        window.settings.get<GameMode>('analyzerGameMode'),
        window.settings.get<RangeKey>('analyzerRangeKey')
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
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    window.settings.get<ClassName>('analyzerMyClass').then((v) => {
      if (v !== selectedClass) window.settings.set('analyzerMyClass', selectedClass).catch(() => {})
    })
  }, [selectedClass])

  useEffect(() => {
    window.settings.get<GameMode>('analyzerGameMode').then((v) => {
      if (v !== selectedGameMode)
        window.settings.set('analyzerGameMode', selectedGameMode).catch(() => {})
    })
  }, [selectedGameMode])

  useEffect(() => {
    window.settings.get<RangeKey>('analyzerRangeKey').then((v) => {
      if (v !== rangeKey) window.settings.set('analyzerRangeKey', rangeKey).catch(() => {})
    })
  }, [rangeKey])

  const [chartHeight, setChartHeight] = useState<number>(window.innerHeight * 0.3)

  const updateHeight = useCallback(() => {
    setChartHeight(window.innerHeight - 400)
  }, [])

  useEffect(() => {
    updateHeight()
    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [updateHeight])

  // 資料載入
  const loadDataFor = useCallback(
    async (myClass: ClassName, gameMode: GameMode, rangeKey: RangeKey) => {
      const stats = await window.matches.getRankedWinrate({
        myClass,
        gameMode: gameMode,
        rangeKey
      })
      setAnalyzeData(stats)
    },
    []
  )

  // 視圖或篩選改變時載入
  useEffect(() => {
    loadDataFor(selectedClass, selectedGameMode, rangeKey)
  }, [selectedClass, selectedGameMode, rangeKey, loadDataFor])

  // 供 IPC 事件要求重抓資料
  useEffect(() => {
    const handler = (): Promise<void> => loadDataFor(selectedClass, selectedGameMode, rangeKey)
    const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsubscribeRefetch()
    }
  }, [loadDataFor, selectedClass, selectedGameMode, rangeKey])
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1
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
        <ToggleButtonGroup
          size="small"
          value={rangeKey}
          exclusive
          onChange={(_, v: RangeKey) => v && setRangeKey(v)}
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
        </ToggleButtonGroup>
      </Box>
      <LineChart data={analyzeData} height={chartHeight} />
    </Box>
  )
}

export default Analyzer
