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
  CssBaseline,
  Popover
} from '@mui/material'
import OpacityIcon from '@mui/icons-material/Opacity'
import CloseIcon from '@mui/icons-material/Close'
import CircleIcon from '@mui/icons-material/Circle'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import UnfoldLessRoundedIcon from '@mui/icons-material/UnfoldLessRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import Recent from './component/Recent'
import HudInsights from './component/HudInsights'
import MatchupCard from './component/MatchupCard'
import StatsRangeControl from './component/StatsRangeControl'
import MatchHistoryLink from './component/MatchHistoryLink'
import {
  DEFAULT_RECENT_COUNT,
  isRecentCount,
  VISIBLE_MATCH_ROWS,
  type RecentCount
} from './component/recentCount'
import { DEFAULT_STATS_DAYS, type StatsRange } from './component/statsRange'
import ModeFilterSelect from './component/ModeFilterSelect'
import { DEFAULT_MODE_FILTER, isModeFilter, type ModeFilter } from './component/modeFilter'
import { usePointerPassthrough } from './usePointerPassthrough'
import type { Match } from '@shared/domain'

import { classesMap } from '@renderer/map/classMap'
import type { GameMode } from '@shared/domain'
import type { BattleStatus, GameStatus } from '@shared/types'

/**
 * The header buttons are chrome, not content: at the default size they were the
 * heaviest thing in a 285px-wide window and read as the point of the row rather
 * than as its trailing controls. Small enough to recede, still a target.
 */
const HEADER_BUTTON_SX = {
  WebkitAppRegion: 'no-drag',
  width: 22,
  height: 22,
  borderRadius: 1,
  color: 'text.secondary',
  bgcolor: 'rgba(214,226,244,0.05)',
  border: '1px solid rgba(214,226,244,0.08)',
  '& svg': { fontSize: 14 }
} as const

const HudApp: React.FC = () => {
  // ---- 資料狀態 ----
  const [recentList, setRecentList] = useState<Match[]>([])

  // ---- HUD 外觀 ----
  const [hudOpacity, setHudOpacity] = useState<number>(0.85)
  const [isCompact, setIsCompact] = useState<boolean>(true)
  const [appearanceAnchor, setAppearanceAnchor] = useState<HTMLElement | null>(null)
  const [battleStatus, setBattleStatus] = useState<BattleStatus>()
  const [gameStatus, setGameStatus] = useState<GameStatus>()
  const [statsDays, setStatsDays] = useState<StatsRange>(DEFAULT_STATS_DAYS)
  const [recentCount, setRecentCount] = useState<RecentCount>(DEFAULT_RECENT_COUNT)
  const [modeFilter, setModeFilter] = useState<ModeFilter>(DEFAULT_MODE_FILTER)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadSeqRef = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)

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
          // MUI colour utilities only support legacy CSS colour formats.
          // Keep these as hex so Skeleton/alpha can safely derive variants.
          default: '#11151c',
          paper: '#202630'
        },
        text: {
          primary: '#f2f5f8',
          secondary: '#b5c0cc'
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

  // 初始載入：HUD 視窗狀態 + 統計區間
  useEffect(() => {
    let mounted = true

    const battleHandler = (_event: unknown, msg: BattleStatus): void => setBattleStatus(msg)
    const gameHandler = (_event: unknown, msg: GameStatus): void => setGameStatus(msg)
    const unsubBattleStatus = window.electron.ipcRenderer.on('battle:status', battleHandler)
    const unsubGameStatus = window.electron.ipcRenderer.on('game:status', gameHandler)
    // The tray entry and the global shortcuts change the same state, so the
    // buttons here have to follow rather than own it.
    const unsubHudState = window.hud?.onState?.((state) => {
      if (!mounted) return
      setHudOpacity(state.opacity)
      setIsCompact(state.compact)
    })

    ;(async () => {
      const defaultHudState = { opacity: 0.85, compact: true }
      const hudStateRequest = window.hud?.getState?.()
      const [hudState, savedDays, savedCount, initialGameStatus] = await Promise.all([
        hudStateRequest?.catch((error) => {
          console.warn('[HUD] failed to read window state:', error)
          return defaultHudState
        }) ?? Promise.resolve(defaultHudState),
        window.settings.get<number | null>('hudStatsDays'),
        window.settings.get<number>('hudRecentCount'),
        // Broadcast only fires on change, so the current value has to be pulled.
        window.electron?.ipcRenderer
          .invoke('game:getStatus')
          .catch(() => null) as Promise<GameStatus | null>
      ])
      if (!mounted) return
      if (initialGameStatus) setGameStatus(initialGameStatus)
      setHudOpacity(hudState.opacity)
      setIsCompact(hudState.compact)
      // null is a meaningful choice ("all matches"); only an absent key falls
      // back to the default.
      if (savedDays === null || (typeof savedDays === 'number' && savedDays > 0)) {
        setStatsDays(savedDays)
      }
      // The store declares a default, so this normally resolves; the coercion
      // covers a value persisted by an older build as a string.
      const parsedCount = Number(savedCount)
      if (isRecentCount(parsedCount)) setRecentCount(parsedCount)
    })()
    return () => {
      mounted = false
      unsubBattleStatus()
      unsubGameStatus()
      unsubHudState?.()
    }
  }, [])

  const changeStatsDays = useCallback((days: StatsRange) => {
    setStatsDays(days)
    window.settings.set('hudStatsDays', days).catch(() => {})
  }, [])

  const changeRecentCount = useCallback((count: RecentCount) => {
    setRecentCount(count)
    window.settings.set('hudRecentCount', count).catch(() => {})
  }, [])

  /**
   * A manual pick, which stands only until the next match says otherwise.
   *
   * Deliberately not persisted any more. The filter now follows the match being
   * played, so a stored preference would be restored on launch and overwritten
   * by the first mode signal - state that looks like a setting but never
   * survives long enough to be one.
   */
  const changeModeFilter = useCallback((mode: ModeFilter) => {
    appliedAutoModeRef.current = mode
    setModeFilter(mode)
  }, [])

  /**
   * The mode the HUD is scoped to follows the match being played.
   *
   * Two sources, in order. A battle in progress whose mode is known wins: 2Pick
   * is labelled on the versus screen and CPU before that, so those retarget the
   * HUD as the match opens rather than when it ends. Otherwise the newest
   * recorded match decides, which covers ranked - it has no mode evidence until
   * its result screen - and covers being idle between matches.
   *
   * `appliedAutoModeRef` is what makes a manual pick usable: the automatic value
   * is applied when it CHANGES, not on every render, so choosing another mode to
   * browse is not undone a moment later by the same signal arriving again. The
   * next real change still wins, which is the point.
   */
  const appliedAutoModeRef = useRef<ModeFilter | null>(null)
  const [lastRecordedMode, setLastRecordedMode] = useState<GameMode | null>(null)

  const refreshLastRecordedMode = useCallback(async () => {
    try {
      const mode = await window.matches?.latestMode()
      setLastRecordedMode(mode ?? null)
    } catch (error) {
      console.warn('[HUD] failed to read the last match mode:', error)
    }
  }, [])

  useEffect(() => {
    void refreshLastRecordedMode()
  }, [refreshLastRecordedMode])

  const autoMode = useMemo<ModeFilter | null>(() => {
    if (battleStatus?.inBattle && battleStatus.mode) return battleStatus.mode
    return lastRecordedMode
  }, [battleStatus?.inBattle, battleStatus?.mode, lastRecordedMode])

  useEffect(() => {
    if (!autoMode || !isModeFilter(autoMode)) return
    if (appliedAutoModeRef.current === autoMode) return
    appliedAutoModeRef.current = autoMode
    setModeFilter(autoMode)
  }, [autoMode])

  // 資料載入
  const loadRecent = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setIsLoading(true)
    setLoadError(null)
    try {
      const data = await window.matches?.fetchRecent(recentCount, modeFilter)
      if (seq === loadSeqRef.current) setRecentList(data ?? [])
    } catch (error) {
      console.warn('[HUD] failed to load data:', error)
      if (seq === loadSeqRef.current) setLoadError('資料讀取失敗')
    } finally {
      if (seq === loadSeqRef.current) setIsLoading(false)
    }
  }, [recentCount, modeFilter])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  // 供 IPC 事件要求重抓資料
  useEffect(() => {
    const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch', () => {
      void loadRecent()
      // The row that just landed may be the one the filter should follow.
      void refreshLastRecordedMode()
    })
    return () => {
      unsubscribeRefetch()
    }
  }, [loadRecent, refreshLastRecordedMode])

  /**
   * Height follows the content instead of two hard-coded sizes, so switching
   * layouts or gaining a matchup card cannot leave a blank strip or clip a row.
   */
  useEffect(() => {
    const node = rootRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const report = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        // The window has no chrome, so content height *is* window height.
        void window.hud?.setContentHeight?.(Math.ceil(node.getBoundingClientRect().height))
      })
    }
    const observer = new ResizeObserver(report)
    observer.observe(node)
    report()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  // UI handlers
  const handleOpacityChange = async (_: Event, value: number | number[]): Promise<void> => {
    const val = Array.isArray(value) ? value[0] : value
    setHudOpacity(val)
    await window.hud?.setOpacity(val)
  }
  const toggleCompact = async (): Promise<void> => {
    const result = await window.hud.setCompact(!isCompact)
    if (typeof result === 'boolean') setIsCompact(result)
  }

  /**
   * Positioning mode is the one time the whole HUD is the target: it exists to
   * be dragged, and only the title row could be grabbed otherwise.
   */
  usePointerPassthrough()

  const isInBattle = battleStatus?.inBattle === true

  /**
   * Three states, because "no matches recorded" and "the game was never found"
   * look identical to a user and need completely different actions.
   */
  const detection: { color: string; label: string; hint: string } = isInBattle
    ? { color: '#75E2A8', label: '對戰中', hint: '' }
    : gameStatus?.capturing
      ? { color: '#66D8F5', label: '待機中', hint: '已偵測到遊戲，等待對戰開始。' }
      : gameStatus?.running
        ? {
            color: '#F2C879',
            label: '已暫停',
            hint: '遊戲已最小化或不在前景，畫面擷取暫停中。'
          }
        : {
            color: 'rgba(214,226,244,0.42)',
            label: '未偵測到遊戲',
            hint: '請先啟動 Shadowverse: Worlds Beyond；偵測到之後才會開始記錄。'
          }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        ref={rootRef}
        sx={{
          p: 1.25,
          border: '1px solid rgba(214,226,244,0.18)',
          borderRadius: 2,
          boxShadow: '0 18px 55px rgba(0,0,0,0.42)',
          backdropFilter: 'blur(14px) saturate(1.08)',
          background: 'linear-gradient(180deg, rgba(26,31,39,0.82), rgba(15,18,24,0.74))',
          color: 'text.primary',
          width: '100%',
          // Height is measured and applied by main (see the ResizeObserver
          // above), so the content decides it rather than a fixed window size.
          height: 'auto',
          boxSizing: 'border-box',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          // No `-webkit-app-region: drag`: the OS drag path does not work on
          // this click-through overlay, and a region that pretended otherwise
          // would swallow clicks whenever it did engage. Dragging is manual -
          // see the header's pointer handlers.
          WebkitAppRegion: 'no-drag'
        }}
        tabIndex={-1}
      >
        {/*
          Header. Marked interactive as a whole row rather than only at its
          buttons: it is the HUD's drag handle as well as its only
          always-present target.
        */}
        <Box
          data-hud-interactive
          sx={{ display: 'flex', alignItems: 'center', gap: 0.75, cursor: 'move' }}
          onPointerDown={(e) => {
            // The header is the drag handle, but its buttons are still buttons.
            if ((e.target as HTMLElement).closest('button,[role="button"],a,input')) return
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            void window.hud?.dragStart?.()
          }}
          onPointerMove={(e) => {
            // Only while this pointer is captured by the press above; hover
            // moves must not stream IPC.
            if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
            window.hud?.dragMove?.(e.screenX, e.screenY)
          }}
          onPointerUp={(e) => {
            ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
            void window.hud?.dragEnd?.()
          }}
          onPointerCancel={() => void window.hud?.dragEnd?.()}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
              <Tooltip title={detection.hint || detection.label} placement="bottom">
                <CircleIcon
                  sx={{
                    fontSize: 9,
                    color: detection.color,
                    filter: isInBattle ? 'drop-shadow(0 0 5px rgba(117,226,168,0.5))' : 'none'
                  }}
                />
              </Tooltip>
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
                {detection.label}
              </Typography>
            </Box>
            {/*
              Only the matchup earns this line. The sample size is stated by the
              selector that sets it, and repeating it here said nothing the rest
              of the HUD did not already show.
            */}
            {isInBattle && battleStatus?.ownClass && battleStatus?.enemyClass ? (
              <Typography
                variant="caption"
                sx={{
                  display: 'block',
                  lineHeight: 1.25,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {/*
                  Class colour is how the rest of the HUD names a class, and
                  this line is now the only place the matchup is stated.
                */}
                <Box
                  component="span"
                  sx={{ color: classesMap[battleStatus.ownClass]?.color, fontWeight: 800 }}
                >
                  {classesMap[battleStatus.ownClass]?.label}
                </Box>
                <Box component="span" sx={{ color: 'rgba(214,226,244,0.45)', mx: 0.4 }}>
                  vs
                </Box>
                <Box
                  component="span"
                  sx={{ color: classesMap[battleStatus.enemyClass]?.color, fontWeight: 800 }}
                >
                  {classesMap[battleStatus.enemyClass]?.label}
                </Box>
              </Typography>
            ) : null}
          </Box>

          <Tooltip title={isCompact ? '展開 HUD' : '縮小 HUD'} placement="bottom">
            <IconButton size="small" onClick={toggleCompact} sx={HEADER_BUTTON_SX}>
              {isCompact ? <UnfoldMoreRoundedIcon /> : <UnfoldLessRoundedIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title="外觀設定" placement="bottom">
            <IconButton
              size="small"
              onClick={(event) => setAppearanceAnchor(event.currentTarget)}
              sx={{
                ...HEADER_BUTTON_SX,
                ...(appearanceAnchor
                  ? { color: '#66D8F5', bgcolor: 'rgba(102,216,245,0.11)' }
                  : null)
              }}
            >
              <TuneRoundedIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="隱藏 HUD" placement="bottom">
            <IconButton
              size="small"
              onClick={() => window.hud?.hide()}
              sx={{
                ...HEADER_BUTTON_SX,
                '&:hover': {
                  color: '#f2f5f8',
                  bgcolor: 'rgba(238,115,115,0.15)',
                  borderColor: 'rgba(238,115,115,0.22)'
                },
                '& svg': {
                  ...HEADER_BUTTON_SX['& svg'],
                  transform: 'rotate(0deg)',
                  transition: 'transform 180ms ease-out'
                },
                '&:hover svg, &:focus-visible svg': { transform: 'rotate(90deg)' },
                '@media (prefers-reduced-motion: reduce)': { '& svg': { transition: 'none' } }
              }}
            >
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {/*
          Floating rather than inline: the HUD height follows its content, so an
          inline panel would push the match list down and resize the window
          every time the slider is opened.
        */}
        <Popover
          open={appearanceAnchor !== null}
          anchorEl={appearanceAnchor}
          onClose={() => setAppearanceAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          // The scroll lock pads the body, which would change the measured
          // content height and resize the window just from opening this.
          disableScrollLock
          slotProps={{
            paper: {
              sx: {
                mt: 0.75,
                px: 1.25,
                py: 0.9,
                borderRadius: 1.5,
                bgcolor: 'rgba(22,27,34,0.97)',
                border: '1px solid rgba(214,226,244,0.16)',
                backdropFilter: 'blur(12px)',
                WebkitAppRegion: 'no-drag'
              }
            }
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 210 }}>
            <OpacityIcon sx={{ fontSize: 17, color: 'text.secondary' }} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              透明度
            </Typography>
            <Slider
              className="hud-slider"
              size="small"
              min={0.5}
              max={1}
              step={0.01}
              value={hudOpacity}
              onChange={handleOpacityChange}
              sx={{
                flex: 1,
                color: '#66D8F5',
                '& .MuiSlider-thumb': { width: 11, height: 11 },
                '& .MuiSlider-rail': { opacity: 0.32 }
              }}
            />
            <Typography
              variant="caption"
              sx={{ fontVariantNumeric: 'tabular-nums', width: 26, textAlign: 'right' }}
            >
              {Math.round(hudOpacity * 100)}
            </Typography>
          </Box>
        </Popover>

        {/*
          Mid-battle the matchup history is the only thing on screen that the
          game itself will not tell you, so it takes the place of the recent
          list rather than sitting below it.
        */}
        {isInBattle && battleStatus?.ownClass && battleStatus?.enemyClass && (
          <>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 0.5
              }}
            >
              {/*
                The mode filter lives in HudInsights the rest of the time, which
                is hidden during a battle - so it moves here, next to the range
                control and directly above the card both of them scope.
              */}
              <ModeFilterSelect value={modeFilter} onChange={changeModeFilter} />
              <StatsRangeControl value={statsDays} onChange={changeStatsDays} />
            </Box>
            <MatchupCard
              myClass={battleStatus.ownClass}
              enemyClass={battleStatus.enemyClass}
              playOrder={battleStatus.playOrder}
              gameMode={modeFilter}
              days={statsDays}
            />
          </>
        )}

        {/*
          Mid-battle everything below is deliberately absent. The recent tally
          and the match list are between-games reading; during a match the only
          thing worth the screen space is the matchup the player is in.
        */}
        {!isInBattle && (
          <>
            <Divider sx={{ borderColor: 'rgba(214,226,244,0.1)' }} />

            {!isCompact && (
              <HudInsights
                matches={recentList}
                recentCount={recentCount}
                onRecentCountChange={changeRecentCount}
                modeFilter={modeFilter}
                onModeFilterChange={changeModeFilter}
              />
            )}
            <Recent
              fetchData={recentList.slice(0, VISIBLE_MATCH_ROWS)}
              isLoading={isLoading}
              error={loadError}
              compact={isCompact}
            />

            {recentList.length > 0 && <MatchHistoryLink />}
          </>
        )}

        {/*
          Without this, an empty list is indistinguishable from a broken
          detection - and the empty list is the first thing a new user sees.
        */}
        {!isLoading && recentList.length === 0 && detection.hint && (
          <Typography
            variant="caption"
            sx={{
              color: 'rgba(181,192,204,0.75)',
              lineHeight: 1.5,
              px: 0.25,
              WebkitAppRegion: 'no-drag'
            }}
          >
            {detection.hint}
          </Typography>
        )}
      </Box>
    </ThemeProvider>
  )
}

export default HudApp
