import React, { useEffect, useState } from 'react'
import { Box, IconButton, TextField, Tooltip } from '@mui/material'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'

import type { StatsRange } from './statsRange'

/**
 * Presets cover the common cases; the custom field exists because "how long
 * since the last balance patch" is a number only the player knows.
 */
const PRESETS: { label: string; value: StatsRange }[] = [
  { label: '7天', value: 7 },
  { label: '30天', value: 30 },
  { label: '全部', value: null }
]

const MIN_DAYS = 1
const MAX_DAYS = 3650

const chipSx = (selected: boolean): Record<string, unknown> => ({
  px: 0.75,
  py: 0.15,
  borderRadius: 0.75,
  cursor: 'pointer',
  fontSize: 10,
  fontWeight: selected ? 800 : 600,
  lineHeight: 1.7,
  userSelect: 'none',
  color: selected ? '#66D8F5' : 'rgba(181,192,204,0.8)',
  bgcolor: selected ? 'rgba(102,216,245,0.14)' : 'rgba(214,226,244,0.05)',
  border: `1px solid ${selected ? 'rgba(102,216,245,0.3)' : 'rgba(214,226,244,0.08)'}`,
  '&:hover': { bgcolor: 'rgba(214,226,244,0.1)' }
})

const StatsRangeControl: React.FC<{
  value: StatsRange
  onChange: (value: StatsRange) => void
}> = ({ value, onChange }) => {
  const isPreset = PRESETS.some((p) => p.value === value)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value ?? 7))

  useEffect(() => {
    if (!editing) setDraft(String(value ?? 7))
  }, [value, editing])

  const commit = (): void => {
    const parsed = Number(draft)
    if (Number.isInteger(parsed) && parsed >= MIN_DAYS && parsed <= MAX_DAYS) onChange(parsed)
    setEditing(false)
  }

  if (editing) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, WebkitAppRegion: 'no-drag' }}>
        <TextField
          autoFocus
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          slotProps={{ htmlInput: { inputMode: 'numeric', 'aria-label': '天數' } }}
          sx={{
            width: 62,
            '& .MuiInputBase-input': { py: 0.25, fontSize: 11, textAlign: 'center' }
          }}
        />
        <IconButton size="small" onClick={commit} sx={{ p: 0.25, color: '#75E2A8' }}>
          <CheckRoundedIcon sx={{ fontSize: 15 }} />
        </IconButton>
        <IconButton
          size="small"
          onClick={() => setEditing(false)}
          sx={{ p: 0.25, color: 'text.secondary' }}
        >
          <CloseRoundedIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Box>
    )
  }

  return (
    // The chips are plain boxes rather than buttons, so the passthrough hit
    // test has to be told that this row is a control.
    <Box
      data-hud-interactive
      sx={{ display: 'flex', alignItems: 'center', gap: 0.4, WebkitAppRegion: 'no-drag' }}
    >
      {PRESETS.map((preset) => (
        <Box
          key={preset.label}
          onClick={() => onChange(preset.value)}
          sx={chipSx(value === preset.value)}
        >
          {preset.label}
        </Box>
      ))}
      <Tooltip title="自訂天數" placement="bottom">
        <Box onClick={() => setEditing(true)} sx={chipSx(!isPreset)}>
          {isPreset ? '自訂' : `${value}天`}
        </Box>
      </Tooltip>
    </Box>
  )
}

export default StatsRangeControl
