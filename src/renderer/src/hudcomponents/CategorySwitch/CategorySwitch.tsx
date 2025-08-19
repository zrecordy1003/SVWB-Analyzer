// CategorySwitch.tsx
import React from 'react'
import { alpha, useTheme } from '@mui/material/styles'
import { Box, ToggleButtonGroup, ToggleButton } from '@mui/material'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import ListAltRoundedIcon from '@mui/icons-material/ListAltRounded'

export type ViewMode = 'recent' | 'analyze' | 'history'

export interface CategorySwitchProps {
  value: ViewMode
  onChange: (v: ViewMode) => void
  className?: string
}

const CategorySwitch: React.FC<CategorySwitchProps> = ({ value, onChange, className }) => {
  const t = useTheme()
  const surface = alpha(t.palette.common.white, t.palette.mode === 'dark' ? 0.05 : 0.08)
  const outline = alpha(t.palette.common.white, t.palette.mode === 'dark' ? 0.1 : 0.12)
  const selectedBg = alpha(t.palette.primary.main, 0.28)
  const selectedHover = alpha(t.palette.primary.main, 0.36)
  const hoverBg = alpha(t.palette.primary.main, 0.1)

  return (
    <Box
      className={className}
      sx={{
        WebkitAppRegion: 'no-drag',
        display: 'inline-flex', // 只佔內容寬
        padding: '6px',
        borderRadius: 12,
        bgcolor: surface,
        border: `1px solid ${outline}`,
        width: 'max-content',
        px: 1.5
      }}
    >
      <ToggleButtonGroup
        exclusive
        size="small"
        value={value}
        onChange={(_, v: ViewMode | null) => v && onChange(v)}
        sx={{
          gap: 0.5,
          '& .MuiToggleButton-root': {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.4,
            textTransform: 'none',
            border: 'none',
            borderRadius: 9,
            padding: '6px 10px',
            minWidth: 40,
            color: t.palette.getContrastText(t.palette.primary.main),
            backgroundColor: alpha(t.palette.common.white, 0.02),
            transition: 'all .15s ease',
            '&:hover': { backgroundColor: hoverBg },
            '& .MuiSvgIcon-root': { fontSize: 18, opacity: 0.9 },
            '&.Mui-selected': {
              color: t.palette.getContrastText(t.palette.primary.main),
              backgroundColor: selectedBg,
              outline: `1px solid ${alpha(t.palette.primary.main, 0.48)}`,
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)',
              '&:hover': { backgroundColor: selectedHover }
            }
          }
        }}
      >
        <ToggleButton value="recent" aria-label="Recent 5">
          <HistoryRoundedIcon />
          近五場
        </ToggleButton>

        <ToggleButton value="analyze" aria-label="Analyze">
          <QueryStatsRoundedIcon />
          分析
        </ToggleButton>

        <ToggleButton value="history" aria-label="History">
          <ListAltRoundedIcon />
          歷史
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  )
}

export default CategorySwitch
