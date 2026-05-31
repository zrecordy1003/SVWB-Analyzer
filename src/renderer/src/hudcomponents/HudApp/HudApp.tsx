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
  Chip,
  CssBaseline
} from '@mui/material'
import PushPinIcon from '@mui/icons-material/PushPin'
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined'
import OpacityIcon from '@mui/icons-material/Opacity'
import CloseIcon from '@mui/icons-material/Close'
import CircleIcon from '@mui/icons-material/Circle'
import type { ViewMode } from '../CategorySwitch/CategorySwitch'
import Recent from './component/Recent'
import type { ClassName, GameMode, Match } from '@prisma/client'
import type { RankedWinrateByOpponent } from './component/Analyze'

import { classesMap, modes } from '@renderer/map/classMap'
import type { BattleStatus } from '@shared/types'

// ---- 類型：把 view 與 filters 分離 ----
type ViewTab = ViewMode // 'recent' | 'analyze' (依你的元件定義)

const HudApp: React.FC = () => {
  // ---- 視圖狀態（控制顯示「近五場 / 分析」）----
  const [viewTab] = useState<ViewTab>('recent')
  // const [viewTab, setViewTab] = useState('ranked')

  // ---- 資料狀態 ----
  const [recentList, setRecentList] = useState<Match[]>([])
  const [, setAnalyzeData] = useState<RankedWinrateByOpponent | null>(null)

  // ---- HUD 外觀 ----
  const [hudOpacity, setHudOpacity] = useState<number>(0.85)
  const [isPinned, setIsPinned] = useState<boolean>(true)
  const [battleStatus, setBattleStatus] = useState<BattleStatus>()
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ---- 篩選條件（你新增的：職業／模式）----
  const [selectedClass, setSelectedClass] = useState<ClassName>('elf')
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode>('ranked')
  const loadSeqRef = useRef(0)

  const theme = useMemo(() => {
    // determine scrollbar colors based on mode
    // const trackColor = mode === 'light' ? '#f0f0f0' : '#303030'
    // const thumbColor = mode === 'light' ? '#c1c1c1' : '#555'
    const trackColor = '#303030'
    const thumbColor = '#555'

    return createTheme({
      palette: {
        mode: 'dark',
        background: {
          default: 'oklch(13% 0.012 255)',
          paper: 'oklch(18% 0.014 255)'
        },
        text: {
          primary: 'oklch(96% 0.006 250)',
          secondary: 'oklch(76% 0.018 250)'
        },
        primary: { main: '#66D8F5' },
        secondary: { main: '#E87AC5' }
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            // Global background and text color transition
            body: {
              fontFamily:
                '"Noto Sans TC", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
              backgroundColor: 'transparent',
              transition: 'background-color 180ms ease-out, color 180ms ease-out'
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

    const battleHandler = (_event: unknown, msg: BattleStatus) => {
      setBattleStatus(msg)
    }
    const unsubBattleStatus = window.electron.ipcRenderer.on('battle:status', battleHandler)

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
      unsubBattleStatus()
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
    const seq = ++loadSeqRef.current
    setIsLoading(true)
    setLoadError(null)

    try {
      if (tab === 'recent') {
        const data = await window.matches?.fetchRecent(5)
        if (seq === loadSeqRef.current) setRecentList(data ?? [])
      } else {
        const stats = await window.matches.getRankedWinrate({
          myClass,
          gameMode: gameMode
        })
        if (seq === loadSeqRef.current) setAnalyzeData(stats)
      }
    } catch (error) {
      console.warn('[HUD] failed to load data:', error)
      if (seq === loadSeqRef.current) setLoadError('資料讀取失敗')
    } finally {
      if (seq === loadSeqRef.current) setIsLoading(false)
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

  const battleClassLabel = battleStatus?.ownClass
    ? classesMap[battleStatus.ownClass]?.label
    : undefined
  const enemyClassLabel = battleStatus?.enemyClass
    ? classesMap[battleStatus.enemyClass]?.label
    : undefined
  const isInBattle = battleStatus?.inBattle === true

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          p: 1.25,
          border: '1px solid rgba(214,226,244,0.18)',
          borderRadius: 2,
          boxShadow: '0 18px 55px rgba(0,0,0,0.42)',
          backdropFilter: 'blur(14px) saturate(1.08)',
          background: 'linear-gradient(180deg, rgba(26,31,39,0.82), rgba(15,18,24,0.74))',
          color: 'text.primary',
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          WebkitAppRegion: 'drag'
        }}
        tabIndex={-1}
      >
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
              <CircleIcon
                sx={{
                  fontSize: 9,
                  color: isInBattle ? '#75E2A8' : 'rgba(214,226,244,0.42)',
                  filter: isInBattle ? 'drop-shadow(0 0 5px rgba(117,226,168,0.5))' : 'none'
                }}
              />
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 750,
                  letterSpacing: 0,
                  lineHeight: 1.15,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {isInBattle ? '對戰中' : '近期對戰'}
              </Typography>
            </Box>
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                color: 'text.secondary',
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {isInBattle && battleClassLabel && enemyClassLabel
                ? `${battleClassLabel} vs ${enemyClassLabel}`
                : '最近 5 場紀錄'}
            </Typography>
          </Box>

          {/* 透明度控制 */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              WebkitAppRegion: 'no-drag',
              px: 0.5,
              py: 0.25,
              borderRadius: 1,
              bgcolor: 'rgba(214,226,244,0.06)',
              border: '1px solid rgba(214,226,244,0.08)'
            }}
          >
            <Tooltip title="透明度" placement="bottom">
              <OpacityIcon sx={{ fontSize: 17, color: 'text.secondary' }} />
            </Tooltip>
            <Slider
              className="hud-slider"
              size="small"
              min={0.5}
              max={1}
              step={0.01}
              value={hudOpacity}
              onChange={handleOpacityChange}
              sx={{
                width: 58,
                opacity: 0.82,
                color: '#66D8F5',
                transition: 'opacity 160ms ease-out',
                '&:hover, &:focus-within': { opacity: 1 },
                '& .MuiSlider-thumb': {
                  width: 10,
                  height: 10
                },
                '& .MuiSlider-rail': {
                  opacity: 0.32
                }
              }}
            />
          </Box>
          <Tooltip title={isPinned ? '取消釘選' : '釘選'} placement="bottom">
            <IconButton
              size="small"
              onClick={togglePinned}
              sx={{
                WebkitAppRegion: 'no-drag',
                color: isPinned ? '#66D8F5' : 'text.secondary',
                bgcolor: isPinned ? 'rgba(102,216,245,0.11)' : 'rgba(214,226,244,0.05)',
                border: '1px solid rgba(214,226,244,0.08)',
                '&:hover': {
                  bgcolor: isPinned ? 'rgba(102,216,245,0.18)' : 'rgba(214,226,244,0.1)'
                },
                '& svg': { transform: 'rotate(0deg)', transition: 'transform 180ms ease-out' },
                '&:hover svg, &:focus-visible svg': { transform: 'rotate(24deg)' },
                '@media (prefers-reduced-motion: reduce)': { '& svg': { transition: 'none' } }
              }}
            >
              {isPinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
            </IconButton>
          </Tooltip>

          <Tooltip title="隱藏 HUD" placement="bottom">
            <IconButton
              size="small"
              onClick={() => window.hud?.hide()}
              sx={{
                WebkitAppRegion: 'no-drag',
                color: 'text.secondary',
                bgcolor: 'rgba(214,226,244,0.05)',
                border: '1px solid rgba(214,226,244,0.08)',
                '&:hover': {
                  color: 'oklch(96% 0.006 250)',
                  bgcolor: 'rgba(238,115,115,0.15)',
                  borderColor: 'rgba(238,115,115,0.22)'
                },
                '& svg': { transform: 'rotate(0deg)', transition: 'transform 180ms ease-out' },
                '&:hover svg, &:focus-visible svg': { transform: 'rotate(90deg)' },
                '@media (prefers-reduced-motion: reduce)': { '& svg': { transition: 'none' } }
              }}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {isInBattle && battleStatus?.ownClass && battleStatus?.enemyClass && (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
              alignItems: 'center',
              gap: 0.75,
              px: 1,
              py: 0.75,
              borderRadius: 1.25,
              bgcolor: 'rgba(214,226,244,0.055)',
              border: '1px solid rgba(214,226,244,0.1)'
            }}
          >
            <Typography
              variant="body2"
              sx={{
                color: classesMap[battleStatus.ownClass].color,
                fontWeight: 700,
                textAlign: 'right',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {classesMap[battleStatus.ownClass].label}
            </Typography>

            <Chip
              size="small"
              label={battleStatus.playOrder === 'first' ? '先攻' : '後攻'}
              sx={{
                height: 22,
                fontWeight: 700,
                bgcolor:
                  battleStatus.playOrder === 'first'
                    ? 'rgba(102,216,245,0.16)'
                    : 'rgba(232,122,197,0.16)',
                color: battleStatus.playOrder === 'first' ? '#66D8F5' : '#E87AC5',
                border: '1px solid rgba(214,226,244,0.1)'
              }}
            />

            <Typography
              variant="body2"
              sx={{
                color: classesMap[battleStatus.enemyClass].color,
                fontWeight: 700,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {classesMap[battleStatus.enemyClass].label}
            </Typography>
          </Box>
        )}

        <Divider sx={{ borderColor: 'rgba(214,226,244,0.1)' }} />

        {/* 內容 */}
        {viewTab === 'recent' && (
          <Recent fetchData={recentList} isLoading={isLoading} error={loadError} />
        )}
        {/* {viewTab === 'analyze' && <Analyze data={analyzeData} height={200} sortBy="total" />} */}
      </Box>
    </ThemeProvider>
  )
}

export default HudApp
