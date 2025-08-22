import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Autocomplete,
  Box,
  Checkbox,
  Chip,
  TextField,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  useTheme
} from '@mui/material'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'
import type { GameMode } from '@prisma/client'
import { classes, modes, modesMap } from '@renderer/map/classMap'

type ClassType = (typeof classes)[number]
export type RangeKey = 'today' | '7d' | '30d' | 'all' | 'custom'

export type Filters = {
  my: ClassType[]
  oppo: ClassType[]
  mode: GameMode | null
  startDate: Date | null
  endDate: Date | null
}

export type OnFiltersChange = (patch: Partial<Filters>) => void

const translations = {
  startDateLabel: '開始日期',
  endDateLabel: '結束日期'
}

/* ---------- date helpers ---------- */
function startOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function endOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}
function computeQuickRange(key: Exclude<RangeKey, 'custom'>): {
  start: Date | null
  end: Date | null
} {
  const now = new Date()
  switch (key) {
    case 'today':
      return { start: startOf(now), end: endOf(now) }
    case '7d':
      return {
        start: startOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)),
        end: endOf(now)
      }
    case '30d':
      return {
        start: startOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)),
        end: endOf(now)
      }
    case 'all':
    default:
      return { start: null, end: null }
  }
}

/* ---------- persistence (settings only) ---------- */
const SETTINGS_KEY = 'matchList.filters.v1'
type PersistShape = {
  rangeKey: RangeKey
  myIds: string[]
  oppoIds: string[]
  mode: GameMode | null
  startMs: number | null
  endMs: number | null
}

async function settingsGet<T>(key: string): Promise<T | undefined> {
  // @ts-ignore preload 提供
  return window.settings?.get<T>(key)
}
async function settingsSet<T>(key: string, val: T): Promise<void> {
  await window.settings?.set(key, val)
}
function inflateClasses(ids: string[]): ClassType[] {
  const idSet = new Set(ids)
  return classes.filter((c) => idSet.has(c.id as unknown as string))
}
function deflateClasses(objs: ClassType[]): string[] {
  return objs.map((c) => c.id as unknown as string)
}

const SearchBar = ({
  filters,
  onFiltersChange
}: {
  filters: Filters
  onFiltersChange: OnFiltersChange
}): React.JSX.Element => {
  const { my, oppo, mode, startDate, endDate } = filters

  const [openStart, setOpenStart] = useState(false)
  const [openEnd, setOpenEnd] = useState(false)
  const [rangeKey, setRangeKey] = useState<RangeKey>('today')
  const loadedRef = useRef(false) // 避免初始載入時就把未載入的值覆寫回設定

  /* ---------- 初始還原 ---------- */
  useEffect(() => {
    ;(async () => {
      const saved = await settingsGet<PersistShape>(SETTINGS_KEY)
      if (saved) {
        setRangeKey(saved.rangeKey)
        let s: Date | null = saved.startMs ? new Date(saved.startMs) : null
        let e: Date | null = saved.endMs ? new Date(saved.endMs) : null
        if (saved.rangeKey !== 'custom') {
          const r = computeQuickRange(saved.rangeKey as Exclude<RangeKey, 'custom'>)
          s = r.start
          e = r.end
        }
        onFiltersChange({
          my: inflateClasses(saved.myIds || []),
          oppo: inflateClasses(saved.oppoIds || []),
          mode: saved.mode ?? null,
          startDate: s,
          endDate: e
        })
      } else {
        // 第一次使用：預設今天
        const r = computeQuickRange('today')
        onFiltersChange({ startDate: r.start, endDate: r.end })
        setRangeKey('today')
      }
      loadedRef.current = true
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- 任一設定變更就保存 ---------- */
  useEffect(() => {
    if (!loadedRef.current) return
    const payload: PersistShape = {
      rangeKey,
      myIds: deflateClasses(my),
      oppoIds: deflateClasses(oppo),
      mode,
      startMs: startDate ? startDate.getTime() : null,
      endMs: endDate ? endDate.getTime() : null
    }
    settingsSet(SETTINGS_KEY, payload).catch(() => {})
  }, [rangeKey, my, oppo, mode, startDate, endDate])

  /* ---------- UI ---------- */
  const theme = useTheme()
  const inputColor = useMemo(() => {
    if (!mode) return theme.palette.text.primary
    const paletteKey = modesMap[mode]?.color || 'primary'
    return theme.palette[paletteKey].main
  }, [mode, theme.palette])

  const datePickerStyle = {
    day: {
      sx: {
        '&.MuiPickersDay-dayOutsideMonth': { opacity: 0.35 },
        '&.Mui-disabled': {
          opacity: 1,
          color: 'text.disabled',
          backgroundColor: 'rgba(255,255,255,0.06)',
          border: '1px dashed',
          borderColor: 'divider',
          position: 'relative'
        },
        '&.Mui-selected.Mui-disabled': {
          backgroundColor: 'action.disabledBackground',
          color: 'text.disabled'
        }
      }
    }
  } as const

  // 快速區間：非自訂直接套用日期；自訂只顯示日期元件
  const onQuickRangeChange = (_: unknown, v: RangeKey | null): void => {
    if (!v) return
    setRangeKey(v)
    if (v !== 'custom') {
      const { start, end } = computeQuickRange(v)
      onFiltersChange({ startDate: start, endDate: end })
      setOpenStart(false)
      setOpenEnd(false)
    } else if (!startDate && !endDate) {
      const today = new Date()
      onFiltersChange({ startDate: startOf(today), endDate: endOf(today) })
    }
  }

  // 改任一日期 → 轉為自訂並校正區間
  const handleChangeStart = (date: Date | null): void => {
    setRangeKey('custom')
    if (date && endDate && endDate < date) {
      onFiltersChange({ startDate: date, endDate: endOf(date) })
    } else {
      onFiltersChange({ startDate: date })
    }
  }
  const handleChangeEnd = (date: Date | null): void => {
    setRangeKey('custom')
    if (date && startDate && startDate > date) {
      onFiltersChange({ startDate: startOf(date), endDate: date })
    } else {
      onFiltersChange({ endDate: date })
    }
  }

  return (
    <Box>
      {/* 第一排：職業 / 模式 */}
      <Box mb={2} display="flex" gap={2} flexWrap="wrap">
        {/* 我方職業 */}
        <Autocomplete
          openText=""
          multiple
          disableCloseOnSelect
          options={classes}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={my}
          onChange={(_, newVal) => onFiltersChange({ my: newVal })}
          renderInput={(params) => <TextField {...params} label="我方職業" variant="outlined" />}
          renderOption={(props, option, { selected }) => (
            <li {...props}>
              <Checkbox
                checked={selected}
                size="small"
                sx={{ color: option.color, '&.Mui-checked': { color: option.color } }}
              />
              <Typography color={option.color}>{option.label}</Typography>
            </li>
          )}
          renderTags={(value, getTagProps) => {
            const limit = 2
            const visible = value.slice(0, limit)
            const extra = value.length - limit
            return [
              ...visible.map((opt, idx) => (
                <Chip
                  key={opt.id}
                  label={opt.label}
                  {...getTagProps({ index: idx })}
                  sx={{
                    background: `${opt.color}22`,
                    color: opt.color,
                    fontWeight: 600,
                    borderRadius: '1.3em',
                    mr: 0.5,
                    mb: 0.5,
                    fontSize: '0.95em',
                    border: 'none'
                  }}
                />
              )),
              extra > 0 && <Chip key="extra" label={`+${extra}`} />
            ].filter(Boolean)
          }}
          slotProps={{ listbox: { sx: { maxHeight: 'none' } } }}
          sx={{ minWidth: 320 }}
        />

        {/* 對方職業 */}
        <Autocomplete
          openText=""
          multiple
          disableCloseOnSelect
          options={classes}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={oppo}
          onChange={(_, newVal) => onFiltersChange({ oppo: newVal })}
          renderInput={(params) => <TextField {...params} label="對方職業" variant="outlined" />}
          renderOption={(props, option, { selected }) => (
            <li {...props}>
              <Checkbox
                checked={selected}
                size="small"
                sx={{ color: option.color, '&.Mui-checked': { color: option.color } }}
              />
              <Typography color={option.color}>{option.label}</Typography>
            </li>
          )}
          renderTags={(value, getTagProps) => {
            const limit = 2
            const visible = value.slice(0, limit)
            const extra = value.length - limit
            return [
              ...visible.map((opt, idx) => (
                <Chip
                  key={opt.id}
                  label={opt.label}
                  {...getTagProps({ index: idx })}
                  sx={{
                    background: `${opt.color}22`,
                    color: opt.color,
                    fontWeight: 600,
                    borderRadius: '1.3em',
                    mr: 0.5,
                    mb: 0.5,
                    fontSize: '0.95em',
                    border: 'none'
                  }}
                />
              )),
              extra > 0 && <Chip key="extra" label={`+${extra}`} />
            ].filter(Boolean)
          }}
          slotProps={{ listbox: { sx: { maxHeight: 'none' } } }}
          sx={{ minWidth: 320 }}
        />

        {/* 模式（可清空） */}
        <Autocomplete
          openText=""
          options={modes}
          getOptionLabel={(opt) => opt.label}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={mode ? (modes.find((opt) => opt.id === mode) ?? null) : null}
          onChange={(_, newVal) => onFiltersChange({ mode: newVal?.id ?? null })}
          renderInput={(params) => (
            <TextField
              {...params}
              label="模式"
              variant="outlined"
              sx={{ '& .MuiInputBase-input': { color: inputColor } }}
            />
          )}
          renderOption={(props, option) => (
            <li {...props}>
              <Typography color={option.color}>{option.label}</Typography>
            </li>
          )}
          disableClearable={false}
          sx={{ width: 200 }}
        />
      </Box>

      {/* 第二排：快速區間 */}
      <Box mb={2}>
        <ToggleButtonGroup size="small" value={rangeKey} exclusive onChange={onQuickRangeChange}>
          <ToggleButton value="today" sx={{ width: 80 }}>
            今天
          </ToggleButton>
          <ToggleButton value="7d" sx={{ width: 80 }}>
            7 天內
          </ToggleButton>
          <ToggleButton value="30d" sx={{ width: 80 }}>
            30 天內
          </ToggleButton>
          <ToggleButton value="all" sx={{ width: 80 }}>
            生涯
          </ToggleButton>
          <ToggleButton value="custom" sx={{ width: 80 }}>
            自訂
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* 自訂日期才顯示 */}
      {rangeKey === 'custom' && (
        <Box display="flex" gap={2}>
          <LocalizationProvider
            dateAdapter={AdapterDateFns}
            adapterLocale={dfZhTW}
            localeText={pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText}
          >
            <DatePicker
              reduceAnimations
              label={translations.startDateLabel}
              value={startDate}
              open={openStart}
              onOpen={() => setOpenStart(true)}
              onClose={() => setOpenStart(false)}
              onChange={handleChangeStart}
              format="yyyy/MM/dd"
              disableFuture
              slotProps={{
                day: datePickerStyle.day,
                textField: { fullWidth: true, onClick: () => setOpenStart(true) },
                popper: { keepMounted: true }
              }}
            />
          </LocalizationProvider>

          <LocalizationProvider
            dateAdapter={AdapterDateFns}
            adapterLocale={dfZhTW}
            localeText={pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText}
          >
            <DatePicker
              reduceAnimations
              label={translations.endDateLabel}
              value={endDate}
              open={openEnd}
              onOpen={() => setOpenEnd(true)}
              onClose={() => setOpenEnd(false)}
              onChange={handleChangeEnd}
              format="yyyy/MM/dd"
              disableFuture
              slotProps={{
                day: datePickerStyle.day,
                textField: { fullWidth: true, onClick: () => setOpenEnd(true) },
                popper: { keepMounted: true }
              }}
            />
          </LocalizationProvider>
        </Box>
      )}
    </Box>
  )
}

export default SearchBar
