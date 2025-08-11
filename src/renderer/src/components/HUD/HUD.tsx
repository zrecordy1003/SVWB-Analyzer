// renderer/Hud.tsx
import React, { useEffect, useMemo, useState } from 'react'
import { Box, Card, Slider, IconButton, Typography, Switch, Tooltip } from '@mui/material'
import PushPinIcon from '@mui/icons-material/PushPin'
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined'

// 型別可依你的資料表調整
type Match = {
  id: number
  result: boolean
  my_class: string
  oppo_class: string
  play_order: string | null
  playedAt: string
  bpGain?: number | null
}

declare global {
  interface Window {
    hud: {
      show(): Promise<void>
      hide(): Promise<void>
      setOpacity(v: number): Promise<number>
      setPinned(p: boolean): Promise<boolean>
      setClickThrough(b: boolean): Promise<boolean>
    }
    matches: {
      fetchRecent(n: number): Promise<Match[]>
      onNewMatch(cb: (m: Match) => void): () => void
    }
  }
}

const Hud: React.FC = () => {
  const [opacity, setOpacity] = useState(0.85)
  const [pinned, setPinned] = useState(true)
  const [clickThrough, setClickThrough] = useState(false)
  const [items, setItems] = useState<Match[]>([])

  const load = async () => {
    const data = await window.matches.fetchRecent(5)
    setItems(data)
  }

  useEffect(() => {
    load()
    const off = window.matches.onNewMatch((_m) => load())
    return off
  }, [])

  const handleOpacity = async (_: Event, v: number | number[]) => {
    const val = Array.isArray(v) ? v[0] : v
    setOpacity(val)
    await window.hud.setOpacity(val)
  }

  const togglePinned = async () => {
    const next = !pinned
    setPinned(await window.hud.setPinned(next))
  }

  const toggleClickThrough = async () => {
    const next = !clickThrough
    setClickThrough(await window.hud.setClickThrough(next))
  }

  // 簡易呈現最近 5 場
  const rows = useMemo(
    () =>
      items.map((i) => ({
        id: i.id,
        summary: `${i.my_class} vs ${i.oppo_class} ${i.play_order ?? ''}`,
        result: i.result ? 'Win' : 'Lose',
        time: new Date(i.playedAt).toLocaleString()
      })),
    [items]
  )

  return (
    <Box
      sx={{
        p: 1,
        borderRadius: '16px',
        bgcolor: 'rgba(30,30,30,0.6)',
        backdropFilter: 'blur(10px)',
        color: '#fff',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        // 整塊可拖曳
        WebkitAppRegion: 'drag'
      }}
    >
      {/* 控制列（避免被拖曳攔截） */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, WebkitAppRegion: 'no-drag' }}>
        <Typography variant="subtitle1" sx={{ flex: 1 }}>
          Recent 5 Matches
        </Typography>
        <Tooltip title={pinned ? 'Unpin' : 'Pin'}>
          <IconButton size="small" onClick={togglePinned}>
            {pinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Click-through">
          <Box display="flex" alignItems="center" gap={0.5}>
            <Typography variant="caption">CT</Typography>
            <Switch size="small" checked={clickThrough} onChange={toggleClickThrough} />
          </Box>
        </Tooltip>
      </Box>

      <Box sx={{ mt: 1, WebkitAppRegion: 'no-drag' }}>
        <Typography variant="caption">Opacity</Typography>
        <Slider
          size="small"
          min={0.2}
          max={1}
          step={0.05}
          value={opacity}
          onChange={handleOpacity}
        />
      </Box>

      <Box sx={{ mt: 1, display: 'grid', gap: 0.5 }}>
        {rows.map((r) => (
          <Card key={r.id} sx={{ p: 1, bgcolor: 'rgba(255,255,255,0.06)' }}>
            <Typography variant="body2">{r.summary}</Typography>
            <Typography variant="caption">{r.time}</Typography>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              {r.result}
            </Typography>
          </Card>
        ))}
      </Box>
    </Box>
  )
}

export default Hud
