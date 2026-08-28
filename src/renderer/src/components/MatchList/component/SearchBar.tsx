// src/renderer/components/SearchBar/SearchBar.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Autocomplete,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Drawer,
  IconButton,
  TextField,
  Tooltip,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  Switch,
  useTheme
} from '@mui/material'
import TuneIcon from '@mui/icons-material/Tune'
import CloseIcon from '@mui/icons-material/Close'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'
import type { GameMode } from '@shared/domain'
import { classes, classesMap, modes, modesMap } from '@renderer/map/classMap'
import type { RangeKey } from '@shared/types'

// ==== 外部提供資料型別（與 hook 對齊）====
export type DeckLite = {
  id: number
  name: string
  classId: string | number | null
  deckCategoryId: string | null
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
type Props = {
  filters: Filters
  onFiltersChange: OnFiltersChange
  deckOptions: DeckLite[] // ★ 由 hook 提供（已補好 categoryName/sort）
  tagOptions: TagLite[]
  crBounds?: { min: number; max: number; step?: number }
  refreshDecks: () => void
  refreshTags: () => void
  /** Delay restoration until reference data is available, then release the first list query. */
  initializationReady: boolean
  onInitialized: () => void
}

const SearchBar = ({
  filters,
  onFiltersChange,
  deckOptions,
  tagOptions,
  crBounds,
  refreshDecks,
  refreshTags,
  initializationReady,
  onInitialized
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const loadedRef = useRef(false)
  const initializationStartedRef = useRef(false)

  // ---- CR 總範圍（可由 props 覆蓋）----
  const CR_MIN_BOUND = crBounds?.min ?? 0
  const CR_MAX_BOUND = crBounds?.max ?? 3000
  const CR_STEP = crBounds?.step ?? 1

  // ---- CR 分段（官方段位切點）：整條範圍切成連續區段，點選區段來組出範圍 ----
  const CR_BANDS: Array<{ key: string; label: string; min: number; max: number }> = [
    { key: 'lt1650', label: '1650 以下', min: CR_MIN_BOUND, max: 1649 },
    { key: 'b1650', label: '1650 – 1749', min: 1650, max: 1749 },
    { key: 'b1750', label: '1750 – 1849', min: 1750, max: 1849 },
    { key: 'b1850', label: '1850 – 1999', min: 1850, max: 1999 },
    { key: 'gte2000', label: '2000 以上', min: 2000, max: CR_MAX_BOUND }
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
    if (!initializationReady || initializationStartedRef.current) return
    initializationStartedRef.current = true
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
      onInitialized()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializationReady])

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

  // 分段是否落在目前套用範圍內（完全被涵蓋才算選取）
  const isBandActive = (band: { min: number; max: number }) =>
    crEnabledSafe && band.min >= crMinSafe && band.max <= crMaxSafe

  // 點選分段：以「最低選取段的下限 ~ 最高選取段的上限」組成連續範圍；全部取消則關閉 CR 篩選
  const handleBandsChange = (keys: string[]) => {
    const selected = CR_BANDS.filter((b) => keys.includes(b.key))
    if (selected.length === 0) {
      onFiltersChange({ crEnabled: false })
      return
    }
    const lo = Math.min(...selected.map((b) => b.min))
    const hi = Math.max(...selected.map((b) => b.max))
    setCrDraft([lo, hi])
    onFiltersChange({ crEnabled: true, crMin: lo, crMax: hi })
  }

  // 手動輸入的統一提交點：夾住範圍並保證 min <= max
  const commitCr = (nextMin: number, nextMax: number) => {
    let lo = clamp(Number.isFinite(nextMin) ? nextMin : CR_MIN_BOUND, CR_MIN_BOUND, CR_MAX_BOUND)
    let hi = clamp(Number.isFinite(nextMax) ? nextMax : CR_MAX_BOUND, CR_MIN_BOUND, CR_MAX_BOUND)
    if (lo > hi) [lo, hi] = [hi, lo]
    setCrDraft([lo, hi])
    onFiltersChange({ crMin: lo, crMax: hi })
  }

  // 進階篩選（職業 / 牌組 / 標籤 / 備註 / CR）目前套用中的條件數，顯示在「進階篩選」按鈕上
  const advancedActiveCount =
    my.length +
    oppo.length +
    decksSafe.length +
    tagsSafe.length +
    (noteSafe !== 'any' ? 1 : 0) +
    (crEnabledSafe ? 1 : 0)

  // hover「進階篩選」按鈕時顯示的已套用條件摘要
  const advancedSummary = useMemo(() => {
    const capList = (names: string[], cap = 3) =>
      names.length <= cap
        ? names.join('、')
        : `${names.slice(0, cap).join('、')} +${names.length - cap}`
    const rows: Array<{ label: string; value: string }> = []
    if (my.length) rows.push({ label: '我方職業', value: capList(my.map((c) => c.label)) })
    if (oppo.length) rows.push({ label: '對方職業', value: capList(oppo.map((c) => c.label)) })
    if (decksSafe.length) rows.push({ label: '牌組', value: capList(decksSafe.map((d) => d.name)) })
    if (tagsSafe.length) rows.push({ label: '標籤', value: capList(tagsSafe.map((t) => t.name)) })
    if (noteSafe !== 'any')
      rows.push({ label: '備註', value: noteSafe === 'with' ? '有備註' : '無備註' })
    if (crEnabledSafe) rows.push({ label: 'CR', value: `${crMinSafe} – ${crMaxSafe}` })
    return rows
  }, [my, oppo, decksSafe, tagsSafe, noteSafe, crEnabledSafe, crMinSafe, crMaxSafe])

  return (
    <Box>
      {/* 常駐精簡列：日期範圍 + 模式 + 進階篩選入口 */}
      <Box display="flex" gap={2} mb={1.5} alignItems="center" flexWrap="wrap">
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

        {/* 模式（可清空） */}
        <Autocomplete
          openText=""
          options={modes}
          getOptionLabel={(opt) => opt.label}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={mode ? (modes.find((opt) => opt.id === mode) ?? null) : null}
          onChange={(_, newVal) =>
            onFiltersChange({ mode: (newVal?.id as GameMode | undefined) ?? null })
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="模式"
              variant="outlined"
              size="small"
              sx={{ '& .MuiInputBase-input': { color: mode ? inputColor : undefined } }}
            />
          )}
          renderOption={(props, option) => (
            <li {...props}>
              <Typography color={option.color}>{option.label}</Typography>
            </li>
          )}
          disableClearable={false}
          sx={{ width: 180 }}
        />

        <Box flex={1} />

        <Tooltip
          arrow
          placement="bottom-end"
          title={
            advancedSummary.length === 0 ? (
              '尚未套用進階篩選'
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.5 }}>
                {advancedSummary.map((row) => (
                  <Box key={row.label} sx={{ display: 'flex', gap: 1 }}>
                    <Typography variant="caption" sx={{ opacity: 0.7, flexShrink: 0 }}>
                      {row.label}
                    </Typography>
                    <Typography variant="caption">{row.value}</Typography>
                  </Box>
                ))}
              </Box>
            )
          }
        >
          <Badge badgeContent={advancedActiveCount} color="primary">
            <Button
              variant={advancedActiveCount > 0 ? 'contained' : 'outlined'}
              size="small"
              startIcon={<TuneIcon />}
              onClick={() => setAdvancedOpen(true)}
            >
              進階篩選
            </Button>
          </Badge>
        </Tooltip>
      </Box>

      {/* 進階篩選：職業 / 牌組 / 標籤 / 備註 / CR，收在抽屜內避免長期佔用垂直空間 */}
      <Drawer
        anchor="right"
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        slotProps={{
          paper: {
            sx: {
              width: 400,
              bgcolor: 'background.default',
              backgroundImage: 'none'
            }
          }
        }}
      >
        {/* sticky header：捲動時關閉按鈕保持可見 */}
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2.5,
            py: 1.5,
            bgcolor: 'background.default',
            borderBottom: '1px solid',
            borderColor: 'divider'
          }}
        >
          <Typography variant="h6">進階篩選</Typography>
          <IconButton onClick={() => setAdvancedOpen(false)} size="small" aria-label="關閉進階篩選">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>

        <Box sx={{ p: 2.5 }} role="presentation">
          <Box display="flex" flexDirection="column" gap={2}>
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
              renderInput={(params) => (
                <TextField {...params} label="我方職業" variant="outlined" />
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
              renderTags={(value, getTagProps) => {
                const limit = 2
                const visible = value.slice(0, limit)
                const extra = value.length - limit
                return [
                  ...visible.map((opt, idx) => {
                    const { key: _key, ...tagProps } = getTagProps({ index: idx })
                    return (
                      <Chip
                        key={opt.id}
                        label={opt.label}
                        {...tagProps}
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
                    )
                  }),
                  extra > 0 && <Chip key="extra" label={`+${extra}`} />
                ].filter(Boolean)
              }}
              slotProps={{ listbox: { sx: { maxHeight: 'none' } } }}
              sx={{ width: '100%' }}
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
              renderInput={(params) => (
                <TextField {...params} label="對方職業" variant="outlined" />
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
              renderTags={(value, getTagProps) => {
                const limit = 2
                const visible = value.slice(0, limit)
                const extra = value.length - limit
                return [
                  ...visible.map((opt, idx) => {
                    const { key: _key, ...tagProps } = getTagProps({ index: idx })
                    return (
                      <Chip
                        key={opt.id}
                        label={opt.label}
                        {...tagProps}
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
                    )
                  }),
                  extra > 0 && <Chip key="extra" label={`+${extra}`} />
                ].filter(Boolean)
              }}
              slotProps={{ listbox: { sx: { maxHeight: 'none' } } }}
              sx={{ width: '100%' }}
            />

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
              sx={{ width: '100%' }}
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
                  ...visible.map((opt, idx) => {
                    const { key: _key, ...tagProps } = getTagProps({ index: idx })
                    return (
                      <Chip key={opt.id} label={opt.name} {...tagProps} sx={{ mr: 0.5, mb: 0.5 }} />
                    )
                  }),
                  extra > 0 && <Chip key="extra" label={`+${extra}`} />
                ].filter(Boolean)
              }}
              slotProps={{ listbox: { sx: { maxHeight: 420 } } }}
              sx={{ width: '100%' }}
            />

            {/* 備註 */}
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

            {/* CR 區間：卡片式區塊（標題 + 開關 + 目前範圍，展開後有預設 / 拉桿 / 手動輸入） */}
            <Box
              sx={{
                border: '1px solid',
                borderColor: crEnabledSafe ? 'primary.main' : 'divider',
                borderRadius: 2,
                bgcolor: 'background.paper',
                overflow: 'hidden',
                transition: 'border-color .2s'
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 2,
                  py: 1,
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
                onClick={() => toggleCrEnabled(!crEnabledSafe)}
              >
                <Typography sx={{ fontWeight: 600 }}>CR 篩選</Typography>
                {crEnabledSafe && (
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    label={`${crDraft[0]} – ${crDraft[1]}`}
                  />
                )}
                <Box flex={1} />
                <Switch
                  size="small"
                  checked={crEnabledSafe}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(_, checked) => toggleCrEnabled(checked)}
                />
              </Box>

              <Collapse in={crEnabledSafe}>
                <Box sx={{ px: 2, pb: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  {/* 分段選取：點選一段或多段，套用範圍 = 最低段下限 ~ 最高段上限（連續） */}
                  <Box>
                    <Typography variant="caption" sx={{ opacity: 0.7 }}>
                      選擇分數段（可多選，範圍為連續區間）
                    </Typography>
                    <ToggleButtonGroup
                      orientation="vertical"
                      fullWidth
                      size="small"
                      value={CR_BANDS.filter(isBandActive).map((b) => b.key)}
                      onChange={(_, keys: string[]) => handleBandsChange(keys)}
                      sx={{ mt: 0.75 }}
                    >
                      {CR_BANDS.map((b) => (
                        <ToggleButton
                          key={b.key}
                          value={b.key}
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
                            {b.label}
                          </Typography>
                          <Typography variant="caption" sx={{ opacity: 0.7 }}>
                            {b.min} – {b.max}
                          </Typography>
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                  </Box>

                  {/* 自訂範圍：失焦或 Enter 才提交 */}
                  <Typography variant="caption" sx={{ opacity: 0.7, mb: -1 }}>
                    自訂範圍
                  </Typography>
                  <Box display="flex" alignItems="center" gap={1.25}>
                    <TextField
                      label="最低"
                      size="small"
                      type="number"
                      value={crDraft[0]}
                      onChange={(e) => setCrDraft([Number(e.target.value), crDraft[1]])}
                      onBlur={() => commitCr(crDraft[0], crDraft[1])}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitCr(crDraft[0], crDraft[1])
                      }}
                      slotProps={{
                        htmlInput: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP }
                      }}
                      sx={{ flex: 1 }}
                    />
                    <Typography sx={{ opacity: 0.5 }}>–</Typography>
                    <TextField
                      label="最高"
                      size="small"
                      type="number"
                      value={crDraft[1]}
                      onChange={(e) => setCrDraft([crDraft[0], Number(e.target.value)])}
                      onBlur={() => commitCr(crDraft[0], crDraft[1])}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitCr(crDraft[0], crDraft[1])
                      }}
                      slotProps={{
                        htmlInput: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP }
                      }}
                      sx={{ flex: 1 }}
                    />
                  </Box>
                </Box>
              </Collapse>
            </Box>
          </Box>
        </Box>
      </Drawer>
    </Box>
  )
}

export default SearchBar
