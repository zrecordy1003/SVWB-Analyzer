/**
 * iOS 式的分段切換：一條凹槽，選中的那段是一塊會滑過去的浮片。
 *
 * MUI 的 ToggleButtonGroup 是「一排各自獨立的按鈕」，每顆都有自己的邊框，選中
 * 靠底色深淺；那適合多選或可以全部不選的情況。這裡要表達的是「同一份資料的
 * 幾種看法，永遠剛好選中一種」- 一條凹槽加一塊浮片說的就是這件事，而且浮片
 * 滑過去的那一下也把「換了哪一段」講清楚了。
 */
import React from 'react'
import { Box, ButtonBase, Typography } from '@mui/material'

export type Segment<T extends string> = {
  id: T
  label: string
  icon?: React.ReactNode
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  height = 32,
  minSegmentWidth = 84,
  'aria-label': ariaLabel
}: {
  options: Segment<T>[]
  value: T
  onChange: (next: T) => void
  height?: number
  /** 每一段的最小寬度。標籤短（兩個字）的時候放小一點，免得整條吃掉半個工作列。 */
  minSegmentWidth?: number
  'aria-label'?: string
}): React.JSX.Element {
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value)
  )
  const segmentWidth = 100 / Math.max(1, options.length)

  return (
    <Box
      role="tablist"
      aria-label={ariaLabel}
      sx={{
        position: 'relative',
        display: 'inline-flex',
        height,
        p: '3px',
        borderRadius: 2,
        bgcolor: 'action.hover',
        border: '1px solid',
        borderColor: 'divider'
      }}
    >
      {/* 浮片。用 transform 移動而不是換每段的底色：位置本身就是動畫，
          瀏覽器也只需要合成一層。 */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          top: '3px',
          bottom: '3px',
          left: '3px',
          width: `calc(${segmentWidth}% - 3px)`,
          transform: `translateX(${index * 100}%)`,
          transition: 'transform .22s cubic-bezier(.32,.72,0,1)',
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          borderRadius: 1.5,
          bgcolor: 'rgba(255,255,255,0.12)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.35)'
        }}
      />

      {options.map((option) => {
        const selected = option.id === value
        return (
          <ButtonBase
            key={option.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.id)}
            sx={{
              position: 'relative',
              zIndex: 1,
              width: `${segmentWidth}%`,
              minWidth: minSegmentWidth,
              px: 1.5,
              gap: 0.75,
              borderRadius: 1.5,
              color: selected ? 'text.primary' : 'text.secondary',
              transition: 'color .18s',
              '&:hover': { color: 'text.primary' }
            }}
          >
            {option.icon}
            <Typography variant="body2" noWrap sx={{ fontWeight: selected ? 700 : 500 }}>
              {option.label}
            </Typography>
          </ButtonBase>
        )
      })}
    </Box>
  )
}

export default SegmentedControl
