import React from 'react'
import { MenuItem, Select } from '@mui/material'

import { DEFAULT_RECENT_COUNT, isRecentCount, RECENT_COUNT_OPTIONS } from './recentCount'
import type { RecentCount } from './recentCount'

/** Matches the caption row in HudInsights that this control sits in. */
const ROW_HEIGHT = 18

const RecentCountSelect: React.FC<{
  value: RecentCount
  onChange: (value: RecentCount) => void
}> = ({ value, onChange }) => (
  <Select
    // A control that governs the tally next to it must never read as blank, so
    // the display comes from the value itself rather than from finding a
    // matching MenuItem, and an unexpected value falls back to the default.
    value={isRecentCount(value) ? value : DEFAULT_RECENT_COUNT}
    renderValue={(selected) => String(selected)}
    onChange={(event) => onChange(Number(event.target.value) as RecentCount)}
    variant="standard"
    disableUnderline
    aria-label="統計場數"
    // The menu is portalled outside the HUD's drag region, and the scroll lock
    // pads the body - which would change the measured content height and
    // resize the window just from opening this.
    MenuProps={{ disableScrollLock: true, slotProps: { paper: { sx: { minWidth: 64 } } } }}
    sx={{
      WebkitAppRegion: 'no-drag',
      color: '#66D8F5',
      fontSize: 11,
      fontWeight: 800,
      fontVariantNumeric: 'tabular-nums',
      // The control is exactly as tall as the caption row it sits in, so the
      // three items centre against each other instead of drifting.
      height: ROW_HEIGHT,
      '& .MuiSelect-select': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        minWidth: 16,
        height: ROW_HEIGHT,
        // An explicit line box: zeroing the padding alone let the inner div
        // collapse, which is what made the number invisible.
        lineHeight: `${ROW_HEIGHT}px`,
        minHeight: `${ROW_HEIGHT}px !important`,
        py: 0,
        pl: 0.6,
        pr: '16px !important',
        borderRadius: 0.5,
        bgcolor: 'rgba(102,216,245,0.1)',
        '&:hover': { bgcolor: 'rgba(102,216,245,0.18)' }
      },
      '& .MuiSelect-icon': { color: '#66D8F5', right: 0, top: 'auto', fontSize: 14 }
    }}
  >
    {RECENT_COUNT_OPTIONS.map((option) => (
      <MenuItem key={option} value={option} sx={{ fontSize: 12, minHeight: 30 }}>
        {option}
      </MenuItem>
    ))}
  </Select>
)

export default RecentCountSelect
