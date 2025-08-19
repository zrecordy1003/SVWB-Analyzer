import React, { useCallback, useEffect, useState } from 'react'
import {
  Box,
  FormControlLabel,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { classes, classesMap, modes } from '@renderer/map/classMap'
import LineChart from './component/LineChart'

import type { ClassName, GameMode } from '@prisma/client'
import type { RankedWinrateByOpponent } from 'src/main/ipc/helper'

const Analyzer: React.FC = () => {
  const [analyzeData, setAnalyzeData] = useState<RankedWinrateByOpponent | null>(null)
  const [onlyToday, setOnlyToday] = useState<boolean>(true)

  const [selectedClass, setSelectedClass] = useState<ClassName>('elf')
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode>('ranked')

  // 初始載入：使用者上次選的職業/模式
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const [lastClass, lastMode] = await Promise.all([
        window.settings.get<ClassName>('analyzerMyClass'),
        window.settings.get<GameMode>('analyzerGameMode')
      ])
      if (!mounted) return

      if (lastClass && lastClass !== selectedClass) {
        setSelectedClass(lastClass)
      }
      if (lastMode && lastMode !== selectedGameMode) {
        setSelectedGameMode(lastMode)
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
  const loadDataFor = useCallback(async (myClass: ClassName, gameMode: GameMode) => {
    const stats = await window.matches.getRankedWinrate({
      myClass,
      gameMode: gameMode
    })
    setAnalyzeData(stats)
  }, [])

  // 視圖或篩選改變時載入
  useEffect(() => {
    loadDataFor(selectedClass, selectedGameMode)
  }, [selectedClass, selectedGameMode, loadDataFor])

  // 供 IPC 事件要求重抓資料
  useEffect(() => {
    const handler = (): Promise<void> => loadDataFor(selectedClass, selectedGameMode)
    const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsubscribeRefetch()
    }
  }, [loadDataFor, selectedClass, selectedGameMode])
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
            <ToggleButton sx={{ width: '100px' }} key={c.id} value={c.id}>
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
          <FormControlLabel
            control={<Switch checked={onlyToday} onChange={(_, v) => setOnlyToday(v)} />}
            label="只看今天"
          />
        </Box>
      </Box>
      <LineChart data={analyzeData} height={chartHeight} />
    </Box>
  )
}

export default Analyzer
