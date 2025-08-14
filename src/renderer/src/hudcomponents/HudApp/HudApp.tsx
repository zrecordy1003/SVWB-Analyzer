import React, { useEffect, useState, useCallback } from 'react'
import { Box, IconButton, Slider, Typography, Card, Tooltip, Divider } from '@mui/material'
import PushPinIcon from '@mui/icons-material/PushPin'
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined'
import OpacityIcon from '@mui/icons-material/Opacity'
import CategorySwitch, { ViewMode } from '../CategorySwitch/CategorySwitch'
import { classesMap } from '@renderer/map/classMap'
import { Match } from '@prisma/client'
import { Close } from '@mui/icons-material'

const HudApp: React.FC = () => {
  const [mode, setMode] = useState<ViewMode>('recent')

  const [matches, setMatches] = useState<Match[]>([])
  const [opacity, setOpacity] = useState<number>(0.85)
  const [pinned, setPinned] = useState<boolean>(true)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      const [op, pin] = await Promise.all([
        window.settings.get<number>('hudOpacity'),
        window.settings.get<boolean>('hudPinned')
      ])
      if (!mounted) return
      if (typeof op === 'number' && op >= 0.2 && op <= 1) setOpacity(op)
      if (typeof pin === 'boolean') setPinned(pin)
    })()
    return () => {
      mounted = false
    }
  }, [])

  const loadMatches = useCallback(async () => {
    const data = await window.matches?.fetchRecent(5)
    setMatches(data)
  }, [])

  const handleOpacityChange = async (_: Event, value: number | number[]): Promise<void> => {
    const val = Array.isArray(value) ? value[0] : value
    setOpacity(val)
    await window.hud?.setOpacity(val)
  }

  const togglePinned = async (): Promise<void> => {
    const newPinned = !pinned
    setPinned(await window.hud?.setPinned(newPinned))
  }

  useEffect(() => {
    loadMatches()
    const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch', loadMatches)
    return () => {
      unsubscribeRefetch()
    }
  }, [])

  return (
    <Box
      sx={{
        p: 2,
        border: '1px solid gray',
        backdropFilter: 'blur(8px)',
        backgroundColor: 'rgba(20,20,20,0.65)',
        // outline: '5px solid white',
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
      {/* 控制列 - 按鈕區才 no-drag */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>
          數據分析
        </Typography>

        <Tooltip title={pinned ? '取消釘選' : '釘選'} placement="left" sx={{ margin: 0 }}>
          <IconButton
            size="small"
            onClick={togglePinned}
            sx={{ WebkitAppRegion: 'no-drag' }}
            color="primary"
          >
            {pinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
          </IconButton>
        </Tooltip>

        <IconButton
          size="small"
          onClick={() => console.log('ss')}
          sx={{
            WebkitAppRegion: 'no-drag',
            '& svg': {
              transform: 'rotate(0deg)',
              transition: 'transform .3s ease'
            },
            '&:hover svg, &:focus-visible svg': {
              transform: 'rotate(90deg)'
            },
            '@media (prefers-reduced-motion: reduce)': {
              '& svg': { transition: 'none' }
            }
          }}
          color="primary"
        >
          <Close />
        </IconButton>
        {/* <Tooltip title="Reload Matches" placement="bottom-start">
          <IconButton
            size="small"
            onClick={loadMatches}
            sx={{ WebkitAppRegion: 'no-drag' }}
            color="primary"
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip> */}
      </Box>

      {/* 透明度控制 - 整個控制列 no-drag */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          WebkitAppRegion: 'no-drag'
        }}
      >
        <OpacityIcon fontSize="small" />
        <Slider
          min={0.2}
          max={1}
          step={0.01}
          value={opacity}
          onChange={handleOpacityChange}
          sx={{ width: '83%' }}
        />
      </Box>

      <CategorySwitch value={mode} onChange={setMode} />

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)' }} />

      {/* 比賽列表 - 預設可拖，只有卡片內互動元素需要 no-drag */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          minHeight: 'max-content'
        }}
      >
        {matches.length === 0 && (
          <Typography
            variant="body2"
            sx={{
              color: 'rgba(255,255,255,0.6)',
              textAlign: 'center',
              WebkitAppRegion: 'no-drag'
            }}
          >
            No matches yet.
          </Typography>
        )}
        {matches.map((m) => (
          <Card
            key={m.id}
            sx={{
              backgroundColor: 'rgba(255,255,255,0.06)',
              color: '#fff',
              borderLeft: `4px solid ${m.result ? '#4caf50' : '#f44336'}`
            }}
          >
            <Box sx={{ px: 2, py: 2.5, WebkitAppRegion: 'no-drag' }}>
              <Box display={'flex'} justifyContent={'space-between'} alignItems={'center'}>
                <Box display={'flex'} gap={1}>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                      color: classesMap[m.my_class]?.color
                    }}
                  >
                    {classesMap[m.my_class]?.label}
                  </Typography>
                  vs
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                      color: classesMap[m.oppo_class]?.color
                    }}
                  >
                    {classesMap[m.oppo_class]?.label}
                  </Typography>
                </Box>

                <Typography
                  variant="body2"
                  color={m.play_order === 'first' ? 'primary' : 'secondary'}
                  sx={{ fontWeight: 600 }}
                >
                  {m.play_order === 'first' ? '先攻' : '後攻'}
                </Typography>
              </Box>
              {/* <Typography variant="caption" sx={{ display: 'block', opacity: 0.7 }}>
                {new Date(m.playedAt).toLocaleString()}
              </Typography> */}
              {/* {m.bp && (
                <Typography
                  variant="caption"
                  sx={{ color: m.bp >= 0 ? '#4caf50' : '#f44336', fontWeight: 500 }}
                >
                  BP {m.bp >= 0 ? '+' : ''}
                  {m.bp}
                </Typography>
              )} */}
            </Box>
          </Card>
        ))}
      </Box>
    </Box>
  )
}

export default HudApp
