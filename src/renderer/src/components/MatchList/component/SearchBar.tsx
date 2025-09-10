// src/renderer/components/SearchBar/SearchBar.tsx
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
  Slider,
  Switch,
  FormControlLabel,
  useTheme
} from '@mui/material'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'
import type { GameMode } from '@prisma/client'
import { classes, classesMap, modes, modesMap } from '@renderer/map/classMap'
import type { RangeKey } from 'src/main/ipc/helper'

// ==== 外部提供資料型別（與 hook 對齊）====
export type DeckLite = {
  id: number
  name: string
  classId: string | number | null
  deckCategoryId: number | null
  categoryName?: string | null
  categorySort?: number | null
}
export type TagLite = { id: number; name: string }

type ClassType = (typeof classes)[number]

// 備註三態
export type NoteFilter = 'any' | 'with' | 'without'

// Filters
export type Filters = {
  my: ClassType[]
  oppo: ClassType[]
  mode: GameMode | null
  rangeKey: RangeKey
  startDate: Date | null
  endDate: Date | null
  decks: DeckLite[]
  tags: TagLite[]
  note: NoteFilter
  crEnabled: boolean // ★ 新增：是否啟用 CR 篩選
  crMin: number | null
  crMax: number | null
}
export type OnFiltersChange = (patch: Partial<Filters>) => void

const translations = { startDateLabel: '開始日期', endDateLabel: '結束日期' }

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

/* ---------- persistence (settings only) ---------- */
const SETTINGS_KEY = 'matchList.filters'
type PersistShape = {
  myIds: string[]
  oppoIds: string[]
  mode: GameMode | null
  rangeKey: RangeKey
  startDate: string | null
  endDate: string | null
  deckIds: number[]
  tagIds: number[]
  note: NoteFilter
  crEnabled: boolean // ★ 新增：持久化 CR 開關
  crMin: number | null
  crMax: number | null
}

async function settingsGet<T>(key: string): Promise<T | undefined> {
  return window.settings?.get<T>(key)
}
async function settingsSet<T>(key: string, val: T): Promise<void> {
  await window.settings?.set(key, val)
}

function inflateClasses(ids: string[]): ClassType[] {
  const idSet = new Set(ids)
  return classes.filter((c) => idSet.has(String(c.id)))
}
function deflateClasses(objs: ClassType[]): string[] {
  return objs.map((c) => String(c.id))
}
function toSafeCR(val: number, min: number, max: number): number {
  if (Number.isNaN(val)) return min
  return Math.min(max, Math.max(min, Math.round(val)))
}

type Props = {
  filters: Filters
  onFiltersChange: OnFiltersChange
  deckOptions: DeckLite[] // ★ 由 hook 提供（已補好 categoryName/sort）
  tagOptions: TagLite[]
  crBounds?: { min: number; max: number; step?: number }
  refreshDecks: () => void
  refreshTags: () => void
}

const SearchBar = ({
  filters,
  onFiltersChange,
  deckOptions,
  tagOptions,
  crBounds,
  refreshDecks,
  refreshTags
}: Props) => {
  // 職業排序：用 classes.map 動態產生
  const CLASS_ORDER = useMemo(() => classes.map((c) => String(c.id)), [])
  const classOrderIndex = useMemo(() => {
    const map = new Map<string, number>()
    CLASS_ORDER.forEach((id, idx) => map.set(id, idx))
    return map
  }, [CLASS_ORDER])

  const {
    my,
    oppo,
    mode,
    rangeKey,
    startDate,
    endDate,
    decks,
    tags,
    note,
    crEnabled,
    crMin,
    crMax
  } = filters

  const [openStart, setOpenStart] = useState(false)
  const [openEnd, setOpenEnd] = useState(false)
  const loadedRef = useRef(false)

  // ---- CR 總範圍（可由 props 覆蓋）----
  const CR_MIN_BOUND = crBounds?.min ?? 0
  const CR_MAX_BOUND = crBounds?.max ?? 3000
  const CR_STEP = crBounds?.step ?? 1

  // ---- 快速預設（官方 + 你新增）----
  const CR_PRESETS: Array<{ key: string; label: string; min: number | null; max: number | null }> =
    [
      { key: 'lt1650', label: '< 1650', min: null, max: 1649 },
      { key: 'epic', label: '1650–1749', min: 1650, max: 1749 },
      { key: 'ultimate', label: '1750–1849', min: 1750, max: 1849 },
      { key: 'legend', label: '1850+', min: 1850, max: null },
      { key: 'gte2000', label: '2000+', min: 2000, max: null }
    ]

  // ---- Slider 刻度 ----
  const marks = [
    { value: 1500, label: '1500' },
    { value: 1650, label: '1650' },
    { value: 1750, label: '1750' },
    { value: 1850, label: '1850' },
    { value: 2000, label: '2000' }
  ]

  // safety values
  const decksSafe = useMemo<DeckLite[]>(() => (Array.isArray(decks) ? decks : []), [decks])
  const tagsSafe = useMemo<TagLite[]>(() => (Array.isArray(tags) ? tags : []), [tags])
  const noteSafe: NoteFilter =
    note === 'with' || note === 'without' || note === 'any' ? note : 'any'
  const crEnabledSafe = !!crEnabled
  const crMinSafe = typeof crMin === 'number' ? crMin : 1650
  const crMaxSafe = typeof crMax === 'number' ? crMax : 1850

  const [crDraft, setCrDraft] = useState<[number, number]>([crMinSafe, crMaxSafe])

  useEffect(() => {
    setCrDraft([crMinSafe, crMaxSafe])
  }, [crMinSafe, crMaxSafe])

  /* ---------- 初始還原 ---------- */
  useEffect(() => {
    ;(async () => {
      const saved = await settingsGet<PersistShape>(SETTINGS_KEY)
      if (saved) {
        const s = saved.startDate ? new Date(saved.startDate) : null
        const e = saved.endDate ? new Date(saved.endDate) : null

        const deckIdSet = new Set(saved.deckIds ?? [])
        const tagIdSet = new Set(saved.tagIds ?? [])
        const restoredDecks = deckOptions.filter((d) => deckIdSet.has(d.id))
        const restoredTags = tagOptions.filter((t) => tagIdSet.has(t.id))

        onFiltersChange({
          my: inflateClasses(saved.myIds || []),
          oppo: inflateClasses(saved.oppoIds || []),
          mode: saved.mode ?? null,
          rangeKey: saved.rangeKey,
          startDate: s,
          endDate: e,
          decks: restoredDecks,
          tags: restoredTags,
          note: saved.note ?? 'any',
          crEnabled: saved.crEnabled ?? false,
          crMin: typeof saved.crMin === 'number' ? saved.crMin : Math.max(1650, CR_MIN_BOUND),
          crMax: typeof saved.crMax === 'number' ? saved.crMax : Math.min(1850, CR_MAX_BOUND)
        })
      } else {
        onFiltersChange({
          rangeKey: 'today',
          startDate: null,
          endDate: null,
          decks: [],
          tags: [],
          note: 'any',
          crEnabled: false,
          crMin: Math.max(1650, CR_MIN_BOUND),
          crMax: Math.min(1850, CR_MAX_BOUND)
        })
      }
      loadedRef.current = true
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckOptions, tagOptions, CR_MIN_BOUND, CR_MAX_BOUND])

  /* ---------- 任一設定變更就保存 ---------- */
  useEffect(() => {
    if (!loadedRef.current) return
    const payload: PersistShape = {
      rangeKey,
      myIds: deflateClasses(my),
      oppoIds: deflateClasses(oppo),
      mode,
      startDate: startDate ? startDate.toISOString() : null,
      endDate: endDate ? endDate.toISOString() : null,
      deckIds: decksSafe.map((d) => d.id),
      tagIds: tagsSafe.map((t) => t.id),
      note: noteSafe,
      crEnabled: crEnabledSafe,
      crMin: crMinSafe,
      crMax: crMaxSafe
    }
    settingsSet(SETTINGS_KEY, payload).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rangeKey,
    my,
    oppo,
    mode,
    startDate,
    endDate,
    decksSafe,
    tagsSafe,
    noteSafe,
    crEnabledSafe,
    crMinSafe,
    crMaxSafe
  ])

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
  }

  const handleChangeStart = (date: Date | null) => {
    if (date && endDate && endDate < date)
      onFiltersChange({ rangeKey: 'custom', startDate: date, endDate: endOf(date) })
    else onFiltersChange({ rangeKey: 'custom', startDate: date })
  }
  const handleChangeEnd = (date: Date | null) => {
    if (date && startDate && startDate > date)
      onFiltersChange({ rangeKey: 'custom', startDate: startOf(date), endDate: date })
    else onFiltersChange({ rangeKey: 'custom', endDate: date })
  }

  // 我方已選職業集合
  const selectedMy = useMemo(() => new Set(my.map((c) => String(c.id))), [my])

  // 依分類排序 + 依職業過濾 + 職業順序
  const deckOptionsSortedFiltered = useMemo(() => {
    const filtered =
      selectedMy.size === 0
        ? deckOptions
        : deckOptions.filter((d) => d.classId != null && selectedMy.has(String(d.classId)))

    const arr = [...filtered]
    arr.sort((a, b) => {
      const as = a.categorySort ?? 9999
      const bs = b.categorySort ?? 9999
      if (as !== bs) return as - bs

      const an = (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
      if (an !== 0) return an

      const ai = classOrderIndex.get(String(a.classId)) ?? 9999
      const bi = classOrderIndex.get(String(b.classId)) ?? 9999
      if (ai !== bi) return ai - bi

      return a.name.localeCompare(b.name)
    })
    return arr
  }, [deckOptions, selectedMy, classOrderIndex])

  const groupKeyOf = (d: DeckLite) => {
    const k = String(d.categorySort ?? 9999).padStart(4, '0')
    const name = d.categoryName ?? '未分類'
    return `${k} ${name}`
  }
  const displayGroupLabel = (key: string) => key.replace(/^\d+\s/, '')

  // ---- CR 快速操作與拉桿事件 ----
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))

  const toggleCrEnabled = (checked: boolean) => {
    if (!checked) {
      // 只關閉，不清掉數值
      onFiltersChange({ crEnabled: false })
    } else {
      const min = typeof crMin === 'number' ? crMin : (crDraft[0] ?? Math.max(1650, CR_MIN_BOUND))
      const max = typeof crMax === 'number' ? crMax : (crDraft[1] ?? Math.min(1850, CR_MAX_BOUND))
      setCrDraft([min, max])
      onFiltersChange({ crEnabled: true, crMin: min, crMax: max })
    }
  }

  const applyPreset = (preset: { min: number | null; max: number | null }) => {
    const min = preset.min ?? CR_MIN_BOUND
    const max = preset.max ?? CR_MAX_BOUND
    if (!crEnabledSafe) onFiltersChange({ crEnabled: true })
    setCrDraft([min, max]) // ★ 先改草稿
    onFiltersChange({ crMin: min, crMax: max }) // ★ 點預設視同一次提交
  }

  const handleCRSlider = (_: Event, value: number | number[]) => {
    const [minV, maxV] = value as number[]
    onFiltersChange({ crMin: minV, crMax: maxV })
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
              sx={{ '& .MuiInputBase-input': { color: mode ? inputColor : undefined } }}
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

      {/* 第二排：快速區間 + 自訂日期 */}
      <Box display="flex" gap={2} mb={2} alignItems="center" flexWrap="wrap">
        <ToggleButtonGroup
          size="small"
          value={rangeKey}
          exclusive
          onChange={(_, v: RangeKey) => v && onFiltersChange({ rangeKey: v })}
        >
          <ToggleButton value="today" sx={{ width: 80 }}>
            <Typography>今天</Typography>
          </ToggleButton>
          <ToggleButton value="7d" sx={{ width: 80 }}>
            <Typography>7 天內</Typography>
          </ToggleButton>
          <ToggleButton value="30d" sx={{ width: 80 }}>
            <Typography>30 天內</Typography>
          </ToggleButton>
          <ToggleButton value="all" sx={{ width: 80 }}>
            <Typography>生涯</Typography>
          </ToggleButton>
          <ToggleButton value="custom" sx={{ width: 80 }}>
            <Typography>自訂</Typography>
          </ToggleButton>
        </ToggleButtonGroup>

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
                  textField: { size: 'small', onClick: () => setOpenStart(true) },
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
                  textField: { size: 'small', onClick: () => setOpenEnd(true) },
                  popper: { keepMounted: true }
                }}
              />
            </LocalizationProvider>
          </Box>
        )}
      </Box>

      {/* 第三排：依牌組 / 依標籤 */}
      <Box display="flex" gap={2} mb={2} flexWrap="wrap" alignItems="center">
        {/* 依牌組（多選）：分組 + 收斂 chips；若選了職業只顯示該職業的牌組 */}
        <Autocomplete
          onOpen={() => refreshDecks()}
          openText=""
          multiple
          disableCloseOnSelect
          options={deckOptionsSortedFiltered}
          getOptionLabel={(d) => d.name}
          value={decksSafe}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_, val) => onFiltersChange({ decks: val ?? [] })}
          groupBy={(opt) => groupKeyOf(opt)}
          renderGroup={(params) => (
            <li key={params.key}>
              <Typography sx={{ px: 1, py: 0.5, fontWeight: 700, opacity: 0.8 }}>
                {displayGroupLabel(params.group)}
              </Typography>
              <ul style={{ margin: 0, paddingLeft: 8 }}>{params.children}</ul>
            </li>
          )}
          renderInput={(params) => <TextField {...params} label="依牌組" variant="outlined" />}
          renderOption={(props, opt, { selected }) => (
            <li {...props}>
              <Checkbox checked={selected} size="small" />
              <Chip
                size="small"
                label={classesMap[opt.classId!]?.label ?? '—'}
                sx={{
                  bgcolor: classesMap[opt.classId!]?.color
                    ? `${classesMap[opt.classId!].color}50`
                    : undefined,
                  mr: 1
                }}
              />
              <Typography>{opt.name}</Typography>
            </li>
          )}
          renderTags={(value, getTagProps) => {
            const limit = 2
            const visible = value.slice(0, limit)
            const extra = value.length - limit
            return [
              ...visible.map((opt, idx) => (
                <Box key={opt.id}>
                  <Chip
                    label={opt.name}
                    {...getTagProps({ index: idx })}
                    sx={{ mr: 0.5, mb: 0.5 }}
                  />
                </Box>
              )),
              extra > 0 && <Chip key="extra" label={`+${extra}`} />
            ].filter(Boolean)
          }}
          slotProps={{ listbox: { sx: { maxHeight: 420 } } }}
          sx={{ minWidth: 320 }}
        />

        {/* 依標籤（多選） */}
        <Autocomplete
          onOpen={() => refreshTags()}
          openText=""
          multiple
          disableCloseOnSelect
          options={tagOptions}
          getOptionLabel={(t) => t.name}
          value={tagsSafe}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_, val) => onFiltersChange({ tags: val ?? [] })}
          renderInput={(params) => <TextField {...params} label="依標籤" variant="outlined" />}
          renderOption={(props, opt, { selected }) => (
            <li {...props}>
              <Checkbox checked={selected} size="small" />
              <Typography>{opt.name}</Typography>
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
                  label={opt.name}
                  {...getTagProps({ index: idx })}
                  sx={{ mr: 0.5, mb: 0.5 }}
                />
              )),
              extra > 0 && <Chip key="extra" label={`+${extra}`} />
            ].filter(Boolean)
          }}
          slotProps={{ listbox: { sx: { maxHeight: 420 } } }}
          sx={{ minWidth: 320 }}
        />
      </Box>

      {/* 第四排：備註 / CR 區間（開關 + 預設 + 雙頭拉桿 + 輸入框） */}
      <Box display="flex" gap={2} mb={1.5} alignItems="center" flexWrap="wrap">
        <ToggleButtonGroup
          size="small"
          value={noteSafe}
          exclusive
          onChange={(_, v: NoteFilter) => v && onFiltersChange({ note: v })}
        >
          <ToggleButton value="any" sx={{ width: 80 }}>
            <Typography>不限</Typography>
          </ToggleButton>
          <ToggleButton value="with" sx={{ width: 80 }}>
            <Typography>有備註</Typography>
          </ToggleButton>
          <ToggleButton value="without" sx={{ width: 80 }}>
            <Typography>無備註</Typography>
          </ToggleButton>
        </ToggleButtonGroup>

        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 1 }}>
          <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
            <FormControlLabel
              control={
                <Switch
                  checked={crEnabledSafe}
                  onChange={(_, checked) => toggleCrEnabled(checked)}
                />
              }
              label="CR 篩選"
              sx={{ mr: 1 }}
            />
            {/* 快速預設 */}
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {CR_PRESETS.map((p) => {
                const active =
                  crEnabledSafe &&
                  (p.min == null ? crMinSafe === CR_MIN_BOUND : crMinSafe === p.min) &&
                  (p.max == null ? crMaxSafe === CR_MAX_BOUND : crMaxSafe === p.max)
                return (
                  <Chip
                    key={p.key}
                    label={p.label}
                    variant={active ? 'filled' : 'outlined'}
                    color={active ? 'primary' : 'default'}
                    size="small"
                    onClick={() => applyPreset(p)}
                    disabled={!crEnabledSafe}
                    sx={{ borderRadius: '999px' }}
                  />
                )
              })}
            </Box>
          </Box>

          <Box display="flex" alignItems="center" gap={1.25} width={1200}>
            <Typography sx={{ whiteSpace: 'nowrap', opacity: crEnabledSafe ? 1 : 0.6 }}>
              CR 區間
            </Typography>
            <Box sx={{ flex: 1, opacity: crEnabledSafe ? 1 : 0.5 }}>
              <Slider
                disabled={!crEnabledSafe}
                value={crDraft} // ★ 用草稿
                min={CR_MIN_BOUND}
                max={CR_MAX_BOUND}
                step={CR_STEP}
                onChange={(_, v) => setCrDraft(v as number[])} // ★ 只改草稿，不查詢
                onChangeCommitted={(_, v) => {
                  // ★ 放開後才提交 -> 觸發查詢
                  const [minV, maxV] = v as number[]
                  onFiltersChange({ crMin: minV, crMax: maxV })
                }}
                valueLabelDisplay="auto"
                marks={marks}
                sx={{
                  mx: 1,
                  '& .MuiSlider-thumb': { boxShadow: 3 },
                  '& .MuiSlider-rail': { opacity: 0.3 }
                }}
              />
            </Box>
            <TextField
              label="最低"
              size="small"
              type="number"
              value={crDraft[0]}
              onChange={(e) => {
                const v = clamp(Number(e.target.value), CR_MIN_BOUND, crMaxSafe)
                setCrDraft([v, crDraft[1]])
                onFiltersChange({ crMin: v })
              }}
              InputProps={{ inputProps: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
              sx={{ width: 110 }}
              // disabled={!crEnabledSafe}
              disabled
            />
            <TextField
              label="最高"
              size="small"
              type="number"
              value={crDraft[1]}
              onChange={(e) => {
                const v = clamp(Number(e.target.value), crMinSafe, CR_MAX_BOUND)
                setCrDraft([crDraft[0], v])
                onFiltersChange({ crMax: v })
              }}
              InputProps={{ inputProps: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
              sx={{ width: 110 }}
              // disabled={!crEnabledSafe}
              disabled
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default SearchBar
