/**
 * 工作列的職業下拉。
 *
 * 和模式下拉是同一個東西的兩份資料，所以長相、行為與下拉面板都跟著 ModeSelect
 * 走：七顆並排的按鈕比一個下拉多吃三倍寬度，而旁邊就擺著一個下拉時，兩種控制
 * 項講同一件事（挑一個）卻長得完全不同，讀起來像兩個不同的功能。
 */
import React from 'react'
import { Box, MenuItem, Select, Typography } from '@mui/material'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'

import { classes, classesMap } from '@renderer/map/classMap'
import { DROPDOWN_ITEM_SX, DROPDOWN_PAPER_SX } from './dropdownSurface'

import type { ClassName } from '@shared/domain'

/** 不篩職業。牌組戰績要得到它，分析器沒有 - 那裡沒有職業就畫不出圖。 */
export type ClassChoiceId = ClassName | 'all'

const ALL_CLASSES_ID = 'all'
const ALL_CLASSES_LABEL = '全部職業'
/** 和模式那顆的「全部模式」同一個灰，兩個下拉的 all 才讀成同一件事。 */
const NEUTRAL_TONE = '#9AA0A6'

function toneOf(id: string): string {
  return id === ALL_CLASSES_ID ? NEUTRAL_TONE : (classesMap[id]?.color ?? NEUTRAL_TONE)
}

function ClassRow({ id }: { id: string }): React.JSX.Element {
  const tone = toneOf(id)
  return (
    <Box display="flex" alignItems="center" gap={1.25} minWidth={0}>
      {/* 方形色塊，和下面圖表的職業標記同一顆 - 同一個東西在兩個地方要長一樣。
          模式那顆是圓的圓點，因為模式在圖表裡沒有對應的標記。 */}
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: '2px',
          flexShrink: 0,
          bgcolor: tone
        }}
      />
      {/* 名字用一般文字色：顏色的意思由左邊那塊色標負責，字再上一次色只是把
          可讀性換掉。 */}
      <Typography variant="body2" noWrap>
        {id === ALL_CLASSES_ID ? ALL_CLASSES_LABEL : (classesMap[id]?.label ?? id)}
      </Typography>
    </Box>
  )
}

/**
 * `T` 跟著呼叫端的狀態型別走：分析器存的是 `ClassName`，牌組戰績存的是
 * `ClassName | 'all'`，兩邊都不必在 onChange 裡補一次轉型。
 */
export function ClassSelect<T extends ClassChoiceId = ClassName>({
  value,
  onChange,
  height,
  allowAll = false
}: {
  value: T
  onChange: (klass: T) => void
  height: number
  /** 多一列「全部職業」。預設沒有 - 查詢需要職業的頁面不該點得出這一列。 */
  allowAll?: boolean
}): React.JSX.Element {
  const options = allowAll
    ? [{ id: ALL_CLASSES_ID, label: ALL_CLASSES_LABEL, color: NEUTRAL_TONE }, ...classes]
    : classes

  return (
    <Select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      IconComponent={KeyboardArrowDownRoundedIcon}
      renderValue={(selected) => <ClassRow id={String(selected)} />}
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
      {options.map((option) => (
        <MenuItem
          key={option.id}
          value={option.id}
          sx={{
            ...DROPDOWN_ITEM_SX,
            // 選中的那列用該職業自己的顏色，不是通用的灰
            '&.Mui-selected': { bgcolor: `${option.color}22` },
            '&.Mui-selected:hover': { bgcolor: `${option.color}33` }
          }}
        >
          <ClassRow id={option.id} />
          <Box flex={1} />
          {option.id === value && (
            <CheckRoundedIcon fontSize="small" sx={{ color: option.color, ml: 1 }} />
          )}
        </MenuItem>
      ))}
    </Select>
  )
}

export default ClassSelect
