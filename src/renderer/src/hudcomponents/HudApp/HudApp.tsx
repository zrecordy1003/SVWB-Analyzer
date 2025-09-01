import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Box,
  IconButton,
  Slider,
  Typography,
  Tooltip,
  Divider,
  createTheme,
  ThemeProvider,
  ToggleButtonGroup,
  ToggleButton
} from '@mui/material'
import PushPinIcon from '@mui/icons-material/PushPin'
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined'
import OpacityIcon from '@mui/icons-material/Opacity'
import CloseIcon from '@mui/icons-material/Close'
import CategorySwitch, { ViewMode } from '../CategorySwitch/CategorySwitch'
import Recent from './component/Recent'
import Analyze from './component/Analyze'
import type { ClassName, GameMode, Match } from '@prisma/client'
import type { RankedWinrateByOpponent } from './component/Analyze'

import { classes, classesMap, modes } from '@renderer/map/classMap'
import ModeSwitch from '../ModeSwitch/ModeSwitch'

// ---- 類型：把 view 與 filters 分離 ----
type ViewTab = ViewMode // 'recent' | 'analyze' (依你的元件定義)

const HudApp: React.FC = () => {
  // ---- 視圖狀態（控制顯示「近五場 / 分析」）----
  const [viewTab, setViewTab] = useState<ViewTab>('recent')
  // const [viewTab, setViewTab] = useState('ranked')

  // ---- 資料狀態 ----
  const [recentList, setRecentList] = useState<Match[]>([])
  const [analyzeData, setAnalyzeData] = useState<RankedWinrateByOpponent | null>(null)

  // ---- HUD 外觀 ----
  const [hudOpacity, setHudOpacity] = useState<number>(0.85)
  const [isPinned, setIsPinned] = useState<boolean>(true)

  // ---- 篩選條件（你新增的：職業／模式）----
  const [selectedClass, setSelectedClass] = useState<ClassName>('elf')
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode>('ranked')

  const theme = useMemo(() => {
    // determine scrollbar colors based on mode
    // const trackColor = mode === 'light' ? '#f0f0f0' : '#303030'
    // const thumbColor = mode === 'light' ? '#c1c1c1' : '#555'
    const trackColor = '#303030'
    const thumbColor = '#555'

    return createTheme({
      palette: {
        mode: 'dark'
        // primary: { main: '#1976d2' },
        // secondary: { main: '#dc004e' }
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            // Global background and text color transition
            body: {
              fontFamily: '"Noto Sans TC", "Roboto", sans-serif',
              transition: 'background-color 0.3s, color 0.3s'
            },
            // Custom scrollbar styling with transition
            '*::-webkit-scrollbar': {
              width: '8px',
              height: '8px'
            },
            '*::-webkit-scrollbar-track': {
              backgroundColor: trackColor,
              transition: 'background-color 0.3s'
            },
            '*::-webkit-scrollbar-thumb': {
              backgroundColor: thumbColor,
              borderRadius: '4px',
              transition: 'background-color 0.3s'
            }
          }
        }
      }
    })
  }, [])

  // 保留目前視圖給 IPC refetch 用
  const viewTabRef = useRef<ViewTab>(viewTab)
  useEffect(() => {
    viewTabRef.current = viewTab
  }, [viewTab])

  // 初始載入：HUD 設定 + 使用者上次選的職業/模式
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const [op, pin, lastClass, lastMode] = await Promise.all([
        window.settings.get<number>('hudOpacity'),
        window.settings.get<boolean>('hudPinned'),
        window.settings.get<ClassName>('hudMyClass'),
        window.settings.get<GameMode>('hudGameMode')
      ])
      if (!mounted) return
      if (typeof op === 'number' && op >= 0.2 && op <= 1) setHudOpacity(op)
      if (typeof pin === 'boolean') setIsPinned(pin)

      // 恢復上次選擇（存在且合法才套用）
      if (lastClass && lastClass in classesMap) {
        setSelectedClass(lastClass)
      }
      if (lastMode && modes.some((m) => m.id === lastMode)) {
        setSelectedGameMode(lastMode)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  // 當使用者變更職業/模式時，存到 settings
  useEffect(() => {
    window.settings.set('hudMyClass', selectedClass).catch(() => {})
  }, [selectedClass])
  useEffect(() => {
    window.settings.set('hudGameMode', selectedGameMode as string).catch(() => {})
  }, [selectedGameMode])

  // 資料載入
  const loadDataFor = useCallback(async (tab: ViewTab, myClass: ClassName, gameMode: GameMode) => {
    if (tab === 'recent') {
      const data = await window.matches?.fetchRecent(5)
      setRecentList(data ?? [])
    } else {
      const stats = await window.matches.getRankedWinrate({
        myClass,
        gameMode: gameMode
      })
      setAnalyzeData(stats)
    }
  }, [])

  // 視圖或篩選改變時載入
  useEffect(() => {
    loadDataFor(viewTab, selectedClass, selectedGameMode)
  }, [viewTab, selectedClass, selectedGameMode, loadDataFor])

  // 供 IPC 事件要求重抓資料
  useEffect(() => {
    const handler = (): Promise<void> =>
      loadDataFor(viewTabRef.current, selectedClass, selectedGameMode)
    const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsubscribeRefetch()
    }
  }, [loadDataFor, selectedClass, selectedGameMode])

  // UI handlers
  const handleOpacityChange = async (_: Event, value: number | number[]): Promise<void> => {
    const val = Array.isArray(value) ? value[0] : value
    setHudOpacity(val)
    await window.hud?.setOpacity(val)
  }
  const togglePinned = async (): Promise<void> => {
    const next = !isPinned
    const result = await window.hud?.setPinned(next)
    if (typeof result === 'boolean') setIsPinned(result)
  }

  return (
    <ThemeProvider theme={theme}>
      <Box
        sx={{
          p: 2,
          border: '1px solid gray',
          backdropFilter: 'blur(8px)',
          backgroundColor: 'rgba(20,20,20,0.65)',
          color: '#fff',
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          WebkitAppRegion: 'drag'
        }}
        tabIndex={-1}
      >
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>
            近期數據
          </Typography>

          {/* 透明度控制 */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              WebkitAppRegion: 'no-drag',
              '&:hover .hud-slider': { opacity: 1, width: '50px' }
            }}
          >
            <OpacityIcon fontSize="small" />
            <Slider
              className="hud-slider"
              size="small"
              min={0.5}
              max={1}
              step={0.01}
              value={hudOpacity}
              onChange={handleOpacityChange}
              sx={{
                width: 0, // 預設收起
                opacity: 0, // 預設隱藏
                transition: 'all 0.3s ease'
              }}
            />
          </Box>
          <Tooltip title={isPinned ? '取消釘選' : '釘選'} placement="bottom">
            <IconButton
              size="small"
              onClick={togglePinned}
              sx={{
                WebkitAppRegion: 'no-drag',
                '& svg': { transform: 'rotate(0deg)', transition: 'transform .3s ease' },
                '&:hover svg, &:focus-visible svg': { transform: 'rotate(30deg)' },
                '@media (prefers-reduced-motion: reduce)': { '& svg': { transition: 'none' } }
              }}
              // color="primary"
            >
              {isPinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
            </IconButton>
          </Tooltip>

          <IconButton
            size="small"
            onClick={() => window.hud?.hide()}
            sx={{
              WebkitAppRegion: 'no-drag',
              '& svg': { transform: 'rotate(0deg)', transition: 'transform .3s ease' },
              '&:hover svg, &:focus-visible svg': { transform: 'rotate(90deg)' },
              '@media (prefers-reduced-motion: reduce)': { '& svg': { transition: 'none' } }
            }}
            // color="primary"
          >
            <CloseIcon />
          </IconButton>
        </Box>

        {/* 視圖切換（只控制「顯示哪一頁」） */}
        {/* <ViewSwitch value={viewTab} onChange={setViewTab} /> */}
        {/* <Box display={'flex'} justifyContent={'center'}>
          <CategorySwitch value={viewTab} onChange={setViewTab} />
        </Box> */}

        {/* 篩選列：職業 / 模式（影響 Analyze 的查詢） */}
        {/* <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            WebkitAppRegion: 'no-drag'
          }}
        >
          <ToggleButtonGroup
            size="small"
            value={selectedClass}
            exclusive
            onChange={(_, val) => val && setSelectedClass(val)}
            sx={{
              '.Mui-selected': {
                bgcolor: classesMap[selectedClass].bgColor
              }
            }}
          >
            {classes.map((c) => (
              <ToggleButton key={c.id} value={c.id}>
                <Typography sx={{ color: c.color }}>{c.label}</Typography>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <ToggleButtonGroup
            size="small"
            value={selectedGameMode}
            exclusive
            onChange={(_, val) => val && setSelectedGameMode(val)}
          >
            {modes.map((m) => (
              <ToggleButton key={m.id} value={m.id}>
                <Typography color={m.color}>{m.label}</Typography>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box> */}
        {/* <ModeSwitch viewTab={viewTab} setViewTab={setViewTab} /> */}

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)' }} />

        {/* 內容 */}
        {viewTab === 'recent' && <Recent fetchData={recentList} />}
        {/* {viewTab === 'analyze' && <Analyze data={analyzeData} height={200} sortBy="total" />} */}
      </Box>
    </ThemeProvider>
  )
}

export default HudApp
