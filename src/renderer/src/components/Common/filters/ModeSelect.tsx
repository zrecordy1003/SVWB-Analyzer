/**
 * 工作列的模式下拉，分析器與對局列表共用。
 *
 * Mode is a qualifier on the class view, not a peer of it - the query requires
 * a class and defaults the mode, and CR only exists in ranked at all - so it
 * gets one dropdown rather than a row of buttons.
 *
 * Built on `Select` rather than a hand-rolled popover: keyboard navigation,
 * type-ahead and the listbox aria roles come for free, and everything that made
 * the default look like a form field is restyled away.
 */
import React from 'react'
import { Box, MenuItem, Select, Typography } from '@mui/material'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'

import { modes } from '@renderer/map/classMap'
import { DROPDOWN_ITEM_SX, DROPDOWN_PAPER_SX } from './dropdownSurface'

import type { GameMode } from '@shared/domain'

/** `'all'` 代表不篩模式 - 兩個頁面的後端查詢本來就都吃這個值。 */
export type ModeChoiceId = GameMode | 'all'

type ModeChoice = { id: ModeChoiceId; label: string; tone: string }

/**
 * `'all'` first, and never the unrecognised bucket. Its grey is a hex like all
 * the others so the tint and the glow can be derived from it by suffix.
 */
const MODE_OPTIONS: ModeChoice[] = [
  { id: 'all', label: '全部模式', tone: '#9AA0A6' },
  ...modes
    .filter((m) => m.id !== 'unknown')
    .map((m) => ({ id: m.id as ModeChoiceId, label: m.label, tone: m.tone }))
]

function ModeRow({ option }: { option: ModeChoice }): React.JSX.Element {
  return (
    <Box display="flex" alignItems="center" gap={1.25} minWidth={0}>
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          bgcolor: option.tone,
          // A soft ring instead of a bare dot - it reads as a status light.
          boxShadow: `0 0 0 3px ${option.tone}26`
        }}
      />
      <Typography variant="body2" noWrap>
        {option.label}
      </Typography>
    </Box>
  )
}

export function ModeSelect({
  value,
  onChange,
  height
}: {
  value: ModeChoiceId
  onChange: (mode: ModeChoiceId) => void
  height: number
}): React.JSX.Element {
  const selected = MODE_OPTIONS.find((m) => m.id === value) ?? MODE_OPTIONS[0]

  return (
    <Select
      value={value}
      onChange={(event) => onChange(event.target.value as ModeChoiceId)}
      IconComponent={KeyboardArrowDownRoundedIcon}
      renderValue={() => <ModeRow option={selected} />}
      MenuProps={{
        anchorOrigin: { vertical: 'bottom', horizontal: 'left' },
        transformOrigin: { vertical: 'top', horizontal: 'left' },
        slotProps: { paper: { sx: { ...DROPDOWN_PAPER_SX, minWidth: 208 } } }
      }}
      sx={{
        height,
        minWidth: 156,
        borderRadius: 2,
        bgcolor: 'action.hover',
        transition: 'background-color .15s, box-shadow .15s',
        '&:hover': { bgcolor: 'action.selected' },
        '& .MuiSelect-select': { display: 'flex', alignItems: 'center', py: 0, pl: 1.5 },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: 'divider' },
        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'text.disabled' },
        '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderWidth: 1 },
        '& .MuiSelect-icon': { transition: 'transform .2s', color: 'text.secondary' }
      }}
    >
      {MODE_OPTIONS.map((option) => (
        <MenuItem
          key={option.id}
          value={option.id}
          sx={{
            ...DROPDOWN_ITEM_SX,
            // The selected row lights up in that mode's own colour rather than
            // in the generic grey every other menu uses.
            '&.Mui-selected': { bgcolor: `${option.tone}22` },
            '&.Mui-selected:hover': { bgcolor: `${option.tone}33` }
          }}
        >
          <ModeRow option={option} />
          <Box flex={1} />
          {option.id === value && (
            <CheckRoundedIcon fontSize="small" sx={{ color: option.tone, ml: 1 }} />
          )}
        </MenuItem>
      ))}
    </Select>
  )
}
