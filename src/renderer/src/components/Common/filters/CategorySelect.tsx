/**
 * 牌組分類的下拉。
 *
 * 和 `ClassSelect`、`ModeSelect` 是同一個東西的第三份資料，所以長相與下拉面板
 * 都跟著它們走。建構器的工具列上，分類原本是 MUI 預設的 outlined + 浮動 label
 * 欄位，而它左邊 20px 處就站著一顆 `ClassSelect` 的軟填充藥丸——同一列裡兩個
 * 「挑一個」的控制項長成兩種東西，讀起來像兩個不同的功能。`CONTROL_SX` 那段
 * 註解講的就是這件事。
 *
 * 分類是使用者可以自己新增的（`deckCategories:create`），所以這裡是下拉而不是
 * 一排 chip：選項會長，但工具列的寬度不會。
 */
import React from 'react'
import { Box, MenuItem, Select, Typography } from '@mui/material'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import SellOutlinedIcon from '@mui/icons-material/SellOutlined'

import { CONTROL_SX, DROPDOWN_ITEM_SX, DROPDOWN_PAPER_SX } from './dropdownSurface'

/** 「未分類」在 `Select` 裡的值。DB 存的是 null，'' 是 MUI 的空值。 */
export const UNCATEGORISED = ''

export type CategoryOption = { id: string; name: string }

/**
 * 一列。未分類畫得比真的分類淡——它不是一個分類的名字，是「還沒分」，和牌組
 * 管理卡片上那顆 chip 同一個處理。
 */
function CategoryRow({ label, muted }: { label: string; muted?: boolean }): React.JSX.Element {
  return (
    <>
      <SellOutlinedIcon
        sx={{ fontSize: 15, color: muted ? 'rgba(255,255,255,0.32)' : 'text.secondary' }}
      />
      <Typography
        variant="body2"
        noWrap
        sx={{ fontWeight: muted ? 500 : 700, color: muted ? 'rgba(255,255,255,0.48)' : 'inherit' }}
      >
        {label}
      </Typography>
    </>
  )
}

export function CategorySelect({
  value,
  onChange,
  categories,
  height = 40,
  minWidth = 132,
  disabled = false
}: {
  /** 分類 id，或 `UNCATEGORISED`。 */
  value: string
  onChange: (categoryId: string) => void
  categories: CategoryOption[]
  height?: number
  minWidth?: number
  disabled?: boolean
}): React.JSX.Element {
  const nameOf = (id: string): string =>
    categories.find((category) => category.id === id)?.name ?? '未分類'

  return (
    <Select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(String(event.target.value))}
      IconComponent={KeyboardArrowDownRoundedIcon}
      displayEmpty
      inputProps={{ 'aria-label': '牌組分類' }}
      renderValue={(selected) => (
        <CategoryRow label={nameOf(String(selected))} muted={String(selected) === UNCATEGORISED} />
      )}
      MenuProps={{
        anchorOrigin: { vertical: 'bottom', horizontal: 'left' },
        transformOrigin: { vertical: 'top', horizontal: 'left' },
        slotProps: { paper: { sx: { ...DROPDOWN_PAPER_SX, minWidth: 176 } } }
      }}
      sx={{
        ...CONTROL_SX,
        height,
        minWidth,
        '& .MuiSelect-select': {
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          py: 0,
          pl: 1.5
        }
      }}
    >
      {categories.map((category) => (
        <MenuItem key={category.id} value={category.id} sx={DROPDOWN_ITEM_SX}>
          <CategoryRow label={category.name} />
          <Box flex={1} />
          {category.id === value && <CheckRoundedIcon fontSize="small" sx={{ ml: 1 }} />}
        </MenuItem>
      ))}
      <MenuItem value={UNCATEGORISED} sx={DROPDOWN_ITEM_SX}>
        <CategoryRow label="未分類" muted />
        <Box flex={1} />
        {value === UNCATEGORISED && <CheckRoundedIcon fontSize="small" sx={{ ml: 1 }} />}
      </MenuItem>
    </Select>
  )
}

export default CategorySelect
