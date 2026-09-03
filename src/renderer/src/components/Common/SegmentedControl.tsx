/**
 * iOS 式的分段切換：一條凹槽，選中的那段是一塊會滑過去的浮片。
 *
 * MUI 的 ToggleButtonGroup 是「一排各自獨立的按鈕」，每顆都有自己的邊框，選中
 * 靠底色深淺；那適合多選或可以全部不選的情況。這裡要表達的是「同一份資料的
 * 幾種看法，永遠剛好選中一種」- 一條凹槽加一塊浮片說的就是這件事，而且浮片
 * 滑過去的那一下也把「換了哪一段」講清楚了。
 *
 * 有一個例外：`value` 對不到任何一段時，浮片整塊不畫。這不是「可以全部不選」，
 * 而是「這題還沒答」——手動新增紀錄的先後攻就是這種必填欄位，而預設把浮片停在
 * 第一段等於幫使用者答了一題他還沒看過的問題。
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
  error = false,
  'aria-label': ariaLabel
}: {
  options: Segment<T>[]
  value: T
  onChange: (next: T) => void
  height?: number
  /** 每一段的最小寬度。標籤短（兩個字）的時候放小一點，免得整條吃掉半個工作列。 */
  minSegmentWidth?: number
  /**
   * 必填卻還沒選——跟 `Select`／`ClassField` 的 `error` 是同一件事，畫法卻不能
   * 照抄：這裡沒有邊框以外的地方可以變色，浮片本來就只在選了之後才畫。所以
   * 交給外框自己在「還沒選」與「已經提交過一次」都成立時變紅。
   */
  error?: boolean
  'aria-label'?: string
}): React.JSX.Element {
  const index = options.findIndex((option) => option.id === value)
  const answered = index >= 0
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
        borderColor: error ? 'error.main' : 'divider',
        transition: 'border-color .15s'
      }}
    >
      {/* 浮片。用 transform 移動而不是換每段的底色：位置本身就是動畫，
          瀏覽器也只需要合成一層。 */}
      {answered && (
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
      )}

      {options.map((option) => {
        const selected = answered && option.id === value
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
