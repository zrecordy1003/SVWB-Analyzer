import React from 'react'
import { MenuItem, Select } from '@mui/material'

import { modesMap } from '@renderer/map/classMap'
import {
  DEFAULT_MODE_FILTER,
  isModeFilter,
  MODE_FILTER_OPTIONS,
  type ModeFilter
} from './modeFilter'

/** Row height shared with the sample-size control, so the two line up. */
const ROW_HEIGHT = 18

const NEUTRAL = 'rgba(214,226,244,0.75)'

/** A selected mode wears its own colour; "all modes" stays neutral. */
function toneOf(value: ModeFilter): string {
  return value === 'all' ? NEUTRAL : (modesMap[value]?.tone ?? NEUTRAL)
}

const ModeFilterSelect: React.FC<{
  value: ModeFilter
  onChange: (value: ModeFilter) => void
}> = ({ value, onChange }) => {
  const current = isModeFilter(value) ? value : DEFAULT_MODE_FILTER
  const tone = toneOf(current)

  return (
    <Select
      value={current}
      onChange={(event) => onChange(event.target.value as ModeFilter)}
      variant="standard"
      disableUnderline
      aria-label="模式篩選"
      // The scroll lock pads the body, which would change the measured content
      // height and resize the window just from opening this.
      MenuProps={{ disableScrollLock: true, slotProps: { paper: { sx: { minWidth: 108 } } } }}
      sx={{
        WebkitAppRegion: 'no-drag',
        maxWidth: '100%',
        color: tone,
        fontSize: 11,
        fontWeight: 800,
        height: ROW_HEIGHT,
        '& .MuiSelect-select': {
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
          height: ROW_HEIGHT,
          lineHeight: `${ROW_HEIGHT}px`,
          minHeight: `${ROW_HEIGHT}px !important`,
          py: 0,
          pl: 0.6,
          pr: '16px !important',
          borderRadius: 0.5,
          whiteSpace: 'nowrap',
          bgcolor: current === 'all' ? 'rgba(214,226,244,0.08)' : `${tone}1f`,
          '&:hover': { bgcolor: current === 'all' ? 'rgba(214,226,244,0.14)' : `${tone}33` }
        },
        '& .MuiSelect-icon': { color: tone, right: 0, top: 'auto', fontSize: 14 }
      }}
    >
      {MODE_FILTER_OPTIONS.map((option) => (
        <MenuItem
          key={option.value}
          value={option.value}
          sx={{ fontSize: 12, minHeight: 30, color: toneOf(option.value), fontWeight: 700 }}
        >
          {option.label}
        </MenuItem>
      ))}
    </Select>
  )
}

export default ModeFilterSelect
