/**
 * The advanced filters' editing surfaces, one per condition.
 *
 * They live here because each one is rendered in two places: stacked inside the
 * 進階篩選 drawer, and on its own in the popover a toolbar chip opens. Two
 * copies of the deck picker would have drifted the first time either was
 * touched, so the drawer and the popover render the same component.
 *
 * Each editor is controlled - it holds a draft only where a half-typed value
 * must not reach the query (the CR numbers), and reports committed values up.
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Autocomplete,
  Box,
  Checkbox,
  Chip,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  type AutocompleteRenderGetTagProps
} from '@mui/material'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'

import { classes, classesMap } from '@renderer/map/classMap'
import { CR_BANDS, CR_MAX_BOUND, CR_MIN_BOUND, CR_STEP, clampCr } from './crBounds'

import type { RangeKey } from '@shared/types'

/**
 * 時間區間送回去的補丁。刻意只描述這三個欄位，不綁哪一頁的 filters 型別 -
 * 分析器和對局列表的狀態形狀不同，共通的只有這一段。
 */
export type RangePatch = {
  rangeKey?: RangeKey
  startDate?: Date | null
  endDate?: Date | null
}

export type DeckLite = {
  id: number
  name: string
  classId: string | number | null
  deckCategoryId?: string | null
  categoryName?: string | null
  categorySort?: number | null
}

export type TagLite = { id: number; name: string }

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

function endOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}
function startOf(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/* ------------------------------------------------------------------ 時間區間 */

export function RangeEditor({
  rangeKey,
  startDate,
  endDate,
  onChange
}: {
  rangeKey: RangeKey
  startDate: Date | null
  endDate: Date | null
  onChange: (patch: RangePatch) => void
}): React.JSX.Element {
  const localeText = pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText
  const [openStart, setOpenStart] = useState(false)
  const [openEnd, setOpenEnd] = useState(false)

  // Picking a date is itself the request for a custom range, so both handlers
  // switch the key over. Crossed ends are folded back rather than sent as an
  // inverted window the query would silently return nothing for.
  const handleChangeStart = (d: Date | null): void => {
    if (d && endDate && endDate < d) {
      onChange({ rangeKey: 'custom', startDate: d, endDate: endOf(d) })
    } else {
      onChange({ rangeKey: 'custom', startDate: d })
    }
  }
  const handleChangeEnd = (d: Date | null): void => {
    if (d && startDate && startDate > d) {
      onChange({ rangeKey: 'custom', startDate: startOf(d), endDate: d })
    } else {
      onChange({ rangeKey: 'custom', endDate: d })
    }
  }

  return (
    <Box display="flex" flexDirection="column" gap={1.5}>
      {/* fullWidth rather than fixed widths: five 80px buttons overflow both
          the drawer's paper and the chip popover. */}
      <ToggleButtonGroup
        size="small"
        fullWidth
        value={rangeKey}
        exclusive
        onChange={(_, v: RangeKey) => v && onChange({ rangeKey: v })}
      >
        <ToggleButton value="today">
          <Typography variant="body2">今天</Typography>
        </ToggleButton>
        <ToggleButton value="7d">
          <Typography variant="body2">7 天</Typography>
        </ToggleButton>
        <ToggleButton value="30d">
          <Typography variant="body2">30 天</Typography>
        </ToggleButton>
        <ToggleButton value="all">
          <Typography variant="body2">生涯</Typography>
        </ToggleButton>
        <ToggleButton value="custom">
          <Typography variant="body2">自訂</Typography>
        </ToggleButton>
      </ToggleButtonGroup>

      {rangeKey === 'custom' && (
        <LocalizationProvider
          dateAdapter={AdapterDateFns}
          adapterLocale={dfZhTW}
          localeText={localeText}
        >
          <Box display="flex" gap={1.5}>
            <DatePicker
              reduceAnimations
              label="開始日期"
              open={openStart}
              onOpen={() => setOpenStart(true)}
              onClose={() => setOpenStart(false)}
              value={startDate}
              onChange={handleChangeStart}
              format="yyyy/MM/dd"
              disableFuture
              slotProps={{
                day: datePickerStyle.day,
                textField: { size: 'small', fullWidth: true, onClick: () => setOpenStart(true) },
                popper: { keepMounted: true }
              }}
            />
            <DatePicker
              reduceAnimations
              label="結束日期"
              open={openEnd}
              onOpen={() => setOpenEnd(true)}
              onClose={() => setOpenEnd(false)}
              value={endDate}
              onChange={handleChangeEnd}
              format="yyyy/MM/dd"
              disableFuture
              slotProps={{
                day: datePickerStyle.day,
                textField: { size: 'small', fullWidth: true, onClick: () => setOpenEnd(true) },
                popper: { keepMounted: true }
              }}
            />
          </Box>
        </LocalizationProvider>
      )}
    </Box>
  )
}

/* ------------------------------------------------------------------ 牌組 / 標籤 */

function renderLimitedTags<T extends { id: number; name: string }>(
  value: readonly T[],
  getTagProps: AutocompleteRenderGetTagProps
): React.ReactNode[] {
  const limit = 2
  const visible = value.slice(0, limit)
  const extra = value.length - limit
  return [
    ...visible.map((opt, idx) => {
      const { key: _key, ...tagProps } = getTagProps({ index: idx })
      return <Chip key={opt.id} label={opt.name} {...tagProps} sx={{ mr: 0.5, mb: 0.5 }} />
    }),
    extra > 0 && <Chip key="extra" label={`+${extra}`} />
  ].filter(Boolean) as React.ReactNode[]
}

const groupKeyOf = (d: DeckLite): string => {
  const k = String(d.categorySort ?? 9999).padStart(4, '0')
  const name = d.categoryName ?? '未分類'
  return `${k} ${name}`
}
const displayGroupLabel = (key: string): string => key.replace(/^\d+\s/, '')

export function DeckEditor({
  options,
  value,
  onOpen,
  onChange,
  autoFocus
}: {
  options: DeckLite[]
  value: DeckLite[]
  onOpen: () => void
  onChange: (deckIds: number[]) => void
  autoFocus?: boolean
}): React.JSX.Element {
  return (
    <Autocomplete
      onOpen={onOpen}
      multiple
      disableCloseOnSelect
      options={options}
      getOptionLabel={(d) => d.name}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      value={value}
      onChange={(_, val) => onChange((val ?? []).map((d) => d.id))}
      groupBy={(opt) => groupKeyOf(opt)}
      renderGroup={(params) => (
        <li key={params.key}>
          <Typography sx={{ px: 1, py: 0.5, fontWeight: 700, opacity: 0.8 }}>
            {displayGroupLabel(params.group)}
          </Typography>
          <ul style={{ margin: 0, paddingLeft: 8 }}>{params.children}</ul>
        </li>
      )}
      renderInput={(params) => (
        <TextField {...params} label="依牌組" variant="outlined" autoFocus={autoFocus} />
      )}
      renderOption={(props, opt, { selected }) => (
        <li {...props}>
          <Checkbox checked={selected} size="small" />
          <Chip
            size="small"
            label={opt.classId ? (classesMap[String(opt.classId)]?.label ?? '—') : '—'}
            sx={{
              bgcolor:
                opt.classId && classesMap[String(opt.classId)]?.color
                  ? `${classesMap[String(opt.classId)].color}50`
                  : undefined,
              mr: 1
            }}
          />
          <Typography>{opt.name}</Typography>
        </li>
      )}
      renderTags={renderLimitedTags}
      slotProps={{ listbox: { sx: { maxHeight: 420 } } }}
      sx={{ width: '100%' }}
    />
  )
}

export function TagEditor({
  options,
  value,
  onOpen,
  onChange,
  autoFocus
}: {
  options: TagLite[]
  value: TagLite[]
  onOpen: () => void
  onChange: (tagIds: number[]) => void
  autoFocus?: boolean
}): React.JSX.Element {
  return (
    <Autocomplete
      onOpen={onOpen}
      multiple
      disableCloseOnSelect
      options={options}
      getOptionLabel={(t) => t.name}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      value={value}
      onChange={(_, val) => onChange((val ?? []).map((t) => t.id))}
      renderInput={(params) => (
        <TextField {...params} label="依標籤" variant="outlined" autoFocus={autoFocus} />
      )}
      renderOption={(props, opt, { selected }) => (
        <li {...props}>
          <Checkbox checked={selected} size="small" />
          <Typography>{opt.name}</Typography>
        </li>
      )}
      renderTags={renderLimitedTags}
      slotProps={{ listbox: { sx: { maxHeight: 420 } } }}
      sx={{ width: '100%' }}
    />
  )
}

/* ------------------------------------------------------------------ CR */

/**
 * CR 篩選與對局列表採相同規則：分段可多選，合併為一段連續範圍。
 *
 * The draft lives here rather than in the parent: only a committed edit - mouse
 * up, blur, Enter - may reach the query, and a half-typed "16" is not one.
 */
export function CrRangeEditor({
  min,
  max,
  onCommit
}: {
  min: number
  max: number
  onCommit: (min: number, max: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<[number, number]>([min, max])

  // Keep the draft in step when the committed values move from elsewhere
  // (a band button, a restored session, the other copy of this editor).
  useEffect(() => {
    setDraft([min, max])
  }, [min, max])

  const commit = useCallback(
    (next: [number, number]): void => {
      onCommit(clampCr(Math.min(next[0], next[1])), clampCr(Math.max(next[0], next[1])))
    },
    [onCommit]
  )

  const isBandActive = (band: (typeof CR_BANDS)[number]): boolean =>
    band.min >= min && band.max <= max

  const handleBandsChange = (keys: string[]): void => {
    const selected = CR_BANDS.filter((band) => keys.includes(band.key))
    // Deselecting the last band leaves the range where it was; turning the
    // condition off belongs to the chip's delete button, not to a stray click.
    if (selected.length === 0) return
    onCommit(
      Math.min(...selected.map((band) => band.min)),
      Math.max(...selected.map((band) => band.max))
    )
  }

  return (
    <Box display="flex" flexDirection="column" gap={1.5}>
      <Box>
        <Typography variant="caption" sx={{ opacity: 0.7 }}>
          選擇分數段（可多選，範圍為連續區間）
        </Typography>
        <ToggleButtonGroup
          orientation="vertical"
          fullWidth
          size="small"
          value={CR_BANDS.filter(isBandActive).map((band) => band.key)}
          onChange={(_, keys: string[]) => handleBandsChange(keys)}
          sx={{ mt: 0.75 }}
        >
          {CR_BANDS.map((band) => (
            <ToggleButton
              key={band.key}
              value={band.key}
              sx={{
                justifyContent: 'space-between',
                px: 1.5,
                textTransform: 'none',
                '&.Mui-selected': {
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  '&:hover': { bgcolor: 'primary.dark' }
                }
              }}
            >
              <Typography variant="body2" fontWeight={600}>
                {band.label}
              </Typography>
              <Typography variant="caption" sx={{ opacity: 0.7 }}>
                {band.min} – {band.max}
              </Typography>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Typography variant="caption" sx={{ opacity: 0.7, mb: -1 }}>
        自訂範圍
      </Typography>
      <Box display="flex" alignItems="center" gap={1.25}>
        <TextField
          label="最低"
          size="small"
          type="number"
          value={draft[0]}
          onChange={(event) => setDraft([Number(event.target.value), draft[1]])}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft)
          }}
          slotProps={{ htmlInput: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
          sx={{ flex: 1 }}
        />
        <Typography sx={{ opacity: 0.5 }}>–</Typography>
        <TextField
          label="最高"
          size="small"
          type="number"
          value={draft[1]}
          onChange={(event) => setDraft([draft[0], Number(event.target.value)])}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft)
          }}
          slotProps={{ htmlInput: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
          sx={{ flex: 1 }}
        />
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------ 職業 / 備註 */

export type ClassOption = (typeof classes)[number]

/**
 * 職業多選。目前只有對局列表用得到（分析器一次只看一個職業，那是它的主軸，
 * 留在工作列上），但它和牌組、標籤是同一種「多選一組東西」的條件，所以放在
 * 一起：三個編輯器長得一樣，使用者就只需要學一次。
 */
export function ClassEditor({
  label,
  value,
  onChange,
  autoFocus
}: {
  label: string
  value: ClassOption[]
  onChange: (next: ClassOption[]) => void
  autoFocus?: boolean
}): React.JSX.Element {
  return (
    <Autocomplete
      multiple
      disableCloseOnSelect
      options={classes}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      value={value}
      onChange={(_, next) => onChange(next)}
      renderInput={(params) => (
        <TextField {...params} label={label} variant="outlined" autoFocus={autoFocus} />
      )}
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
      renderTags={(tagValue, getTagProps) => {
        const limit = 2
        const extra = tagValue.length - limit
        return [
          ...tagValue.slice(0, limit).map((option, index) => {
            const { key: _key, ...tagProps } = getTagProps({ index })
            return (
              <Chip
                key={option.id}
                label={option.label}
                {...tagProps}
                sx={{
                  // 職業自己的顏色比通用的 chip 灰更好認 - 這是唯一帶顏色的條件
                  background: `${option.color}22`,
                  color: option.color,
                  fontWeight: 600,
                  border: 'none',
                  mr: 0.5,
                  mb: 0.5
                }}
              />
            )
          }),
          extra > 0 && <Chip key="extra" label={`+${extra}`} />
        ].filter(Boolean) as React.ReactNode[]
      }}
      slotProps={{ listbox: { sx: { maxHeight: 320 } } }}
      sx={{ width: '100%' }}
    />
  )
}

export type NoteFilter = 'any' | 'with' | 'without'

/** 備註三態。條件本身只有三個值，攤開來按比藏在下拉裡快。 */
export function NoteEditor({
  value,
  onChange
}: {
  value: NoteFilter
  onChange: (next: NoteFilter) => void
}): React.JSX.Element {
  return (
    <ToggleButtonGroup
      size="small"
      fullWidth
      exclusive
      value={value}
      onChange={(_, next: NoteFilter | null) => next && onChange(next)}
    >
      <ToggleButton value="any">
        <Typography variant="body2">不限</Typography>
      </ToggleButton>
      <ToggleButton value="with">
        <Typography variant="body2">有備註</Typography>
      </ToggleButton>
      <ToggleButton value="without">
        <Typography variant="body2">無備註</Typography>
      </ToggleButton>
    </ToggleButtonGroup>
  )
}
