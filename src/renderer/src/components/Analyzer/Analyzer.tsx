// src/renderer/components/Analyzer.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Chip,
  Collapse,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  Checkbox
} from '@mui/material'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'

import { classes, classesMap, modes } from '@renderer/map/classMap'
import LineChart from './component/LineChart'
import { useDecksTags } from '../../hooks/useDecksTags'
import {
  CR_MAX_BOUND,
  CR_MIN_BOUND,
  buildQueryParams,
  clampCr,
  defaultFilters,
  diffPersistPatch,
  hydrateFilters,
  type AnalyzerFilters,
  type FilterVocabulary,
  type ModeFilter
} from './filterState'

import type { ClassName } from '@shared/domain'
import type { RangeKey, RankedWinrateByOpponent } from '@shared/types'

type DeckLite = {
  id: number
  name: string
  classId: string | number | null
  deckCategoryId?: string | null
  categoryName?: string | null
  categorySort?: number | null
}

type TagLite = { id: number; name: string }

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

const CLASS_ORDER = classes.map((c) => String(c.id))
const classOrderIndex = new Map<string, number>(CLASS_ORDER.map((id, idx) => [id, idx]))

/** Injected into the pure hydrator so it never has to import the class map. */
const FILTER_VOCABULARY: FilterVocabulary = {
  classIds: CLASS_ORDER,
  modeIds: modes.map((m) => String(m.id))
}

const CR_STEP = 1
const CR_BANDS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: 'lt1650', label: '1650 以下', min: CR_MIN_BOUND, max: 1649 },
  { key: 'b1650', label: '1650 – 1749', min: 1650, max: 1749 },
  { key: 'b1750', label: '1750 – 1849', min: 1750, max: 1849 },
  { key: 'b1850', label: '1850 – 1999', min: 1850, max: 1999 },
  { key: 'gte2000', label: '2000 以上', min: 2000, max: CR_MAX_BOUND }
]

/** Long enough to swallow a burst of clicks, short enough to feel immediate. */
const QUERY_DEBOUNCE_MS = 180
const PERSIST_DEBOUNCE_MS = 400

const Analyzer: React.FC = () => {
  const localeText = pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText
  const [openStart, setOpenStart] = useState(false)
  const [openEnd, setOpenEnd] = useState(false)

  const [filters, setFilters] = useState<AnalyzerFilters>(defaultFilters)
  const [analyzeData, setAnalyzeData] = useState<RankedWinrateByOpponent | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Draft CR values: the slider and the number fields edit these, and only a
  // committed edit (mouse up, blur, Enter) reaches `filters` and fires a query.
  const [crDraft, setCrDraft] = useState<[number, number]>([filters.crMin, filters.crMax])

  const { allDecks, allTags, refreshDecks, refreshTags } = useDecksTags()

  /**
   * The write gate. It opens as soon as the stored settings have been read -
   * deliberately *not* gated on decks or tags existing. The previous version
   * waited for one of those lists to be non-empty, so a user who had never
   * created a deck or a tag never opened the gate and never had a single filter
   * persisted.
   */
  const settingsLoadedRef = useRef(false)
  /** Last state actually written, so the debounced pass can diff against it. */
  const persistedRef = useRef<AnalyzerFilters | null>(null)
  /** Guards against out-of-order responses when filters change quickly. */
  const requestIdRef = useRef(0)
  /** Read by the long-lived `needRefetch` subscription. */
  const filtersRef = useRef(filters)
  const prevClassRef = useRef<ClassName | null>(null)
  const prunedRef = useRef(false)

  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  const patchFilters = useCallback((patch: Partial<AnalyzerFilters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }))
  }, [])

  /* ---------- 還原設定 ---------- */
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const raw = await window.settings.getAll().catch(() => null)
      if (!mounted) return
      const hydrated = hydrateFilters(raw, FILTER_VOCABULARY)
      persistedRef.current = hydrated
      prevClassRef.current = hydrated.myClass
      setCrDraft([hydrated.crMin, hydrated.crMax])
      // Open the gate before the state lands so the query effect, which runs
      // after this render, sees a restored state and fires exactly once.
      settingsLoadedRef.current = true
      setFilters(hydrated)
    })()
    return () => {
      mounted = false
    }
  }, [])

  /**
   * A deck or tag deleted since the last session would otherwise sit in the
   * saved ids forever, narrowing every query to nothing with no visible cause.
   * Prune once, on the first load that actually returned options.
   */
  useEffect(() => {
    if (prunedRef.current) return
    if (!settingsLoadedRef.current) return
    if (!allDecks?.length && !allTags?.length) return
    prunedRef.current = true

    const deckIdSet = new Set((allDecks ?? []).map((d) => d.id))
    const tagIdSet = new Set((allTags ?? []).map((t) => t.id))
    setFilters((prev) => {
      const deckIds = allDecks?.length
        ? prev.deckIds.filter((id) => deckIdSet.has(id))
        : prev.deckIds
      const tagIds = allTags?.length ? prev.tagIds.filter((id) => tagIdSet.has(id)) : prev.tagIds
      if (deckIds.length === prev.deckIds.length && tagIds.length === prev.tagIds.length)
        return prev
      return { ...prev, deckIds, tagIds }
    })
  }, [allDecks, allTags])

  /* ---------- 切換職業時清空已選牌組 ---------- */
  useEffect(() => {
    if (!settingsLoadedRef.current) return
    if (prevClassRef.current && prevClassRef.current !== filters.myClass) {
      setFilters((prev) => (prev.deckIds.length ? { ...prev, deckIds: [] } : prev))
    }
    prevClassRef.current = filters.myClass
  }, [filters.myClass])

  /* ---------- 持久化（單一批次寫入） ---------- */
  useEffect(() => {
    if (!settingsLoadedRef.current) return
    const handle = setTimeout(() => {
      const patch = diffPersistPatch(persistedRef.current, filters)
      if (!patch) return
      persistedRef.current = filters
      window.settings.setMany(patch).catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [filters])

  /* ---------- 載入資料 ---------- */
  const runQuery = useCallback(async (f: AnalyzerFilters): Promise<void> => {
    const requestId = ++requestIdRef.current
    try {
      const stats = await window.matches.getRankedWinrate(buildQueryParams(f))
      // A slower earlier request must not overwrite a newer result.
      if (requestId !== requestIdRef.current) return
      setAnalyzeData(stats)
      setError(null)
    } catch (err) {
      if (requestId !== requestIdRef.current) return
      console.warn('[Analyzer] winrate query failed:', err)
      // Keep the previous chart on screen; an empty chart would read as
      // "you have no matches" rather than "the query failed".
      setError('讀取統計失敗，請稍後再試')
    }
  }, [])

  useEffect(() => {
    if (!settingsLoadedRef.current) return
    const handle = setTimeout(() => void runQuery(filters), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [filters, runQuery])

  /* ---------- 外部要求重抓（只訂閱一次） ---------- */
  useEffect(() => {
    const handler = (): void => void runQuery(filtersRef.current)
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsub && unsub()
    }
  }, [runQuery])

  /* ---------- 動態高度 ---------- */
  const [chartHeight, setChartHeight] = useState<number>(Math.max(350, window.innerHeight - 580))
  useEffect(() => {
    const onResize = (): void => setChartHeight(Math.max(350, window.innerHeight - 580))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* ---------- 牌組 / 標籤選項 ---------- */
  const deckOptionsSortedFiltered = useMemo<DeckLite[]>(() => {
    const src = (allDecks ?? []) as DeckLite[]
    const filtered = filters.myClass
      ? src.filter((d) => d.classId != null && String(d.classId) === String(filters.myClass))
      : src

    const arr = [...filtered]
    arr.sort((a, b) => {
      const as = a.categorySort ?? 9999
      const bs = b.categorySort ?? 9999
      if (as !== bs) return as - bs

      const an = (a.categoryName ?? '未分類').localeCompare(b.categoryName ?? '未分類')
      if (an !== 0) return an

      const ai = classOrderIndex.get(String(a.classId)) ?? 9999
      const bi = classOrderIndex.get(String(b.classId)) ?? 9999
      if (ai !== bi) return ai - bi

      return a.name.localeCompare(b.name)
    })
    return arr
  }, [allDecks, filters.myClass])

  // Selection is derived from the persisted ids rather than held separately, so
  // there is no window in which the two can disagree.
  const selectedDecks = useMemo<DeckLite[]>(() => {
    const idSet = new Set(filters.deckIds)
    return ((allDecks ?? []) as DeckLite[]).filter((d) => idSet.has(d.id))
  }, [allDecks, filters.deckIds])

  const selectedTags = useMemo<TagLite[]>(() => {
    const idSet = new Set(filters.tagIds)
    return ((allTags ?? []) as TagLite[]).filter((t) => idSet.has(t.id))
  }, [allTags, filters.tagIds])

  const groupKeyOf = (d: DeckLite): string => {
    const k = String(d.categorySort ?? 9999).padStart(4, '0')
    const name = d.categoryName ?? '未分類'
    return `${k} ${name}`
  }
  const displayGroupLabel = (key: string): string => key.replace(/^\d+\s/, '')

  /* ---------- CR ---------- */
  const crActive = filters.crEnabled

  // Keep the draft in step when the committed values move from elsewhere
  // (a preset chip, a restored session).
  useEffect(() => {
    setCrDraft([filters.crMin, filters.crMax])
  }, [filters.crMin, filters.crMax])

  const commitCrDraft = useCallback(
    (next: [number, number]): void => {
      const lo = clampCr(Math.min(next[0], next[1]))
      const hi = clampCr(Math.max(next[0], next[1]))
      setCrDraft([lo, hi])
      patchFilters({ crMin: lo, crMax: hi })
    },
    [patchFilters]
  )

  const toggleCrEnabled = useCallback(
    (checked: boolean): void => {
      if (!checked) {
        patchFilters({ crEnabled: false })
        return
      }

      setCrDraft([filters.crMin, filters.crMax])
      patchFilters({ crEnabled: true, crMin: filters.crMin, crMax: filters.crMax })
    },
    [filters.crMax, filters.crMin, patchFilters]
  )

  const isCrBandActive = useCallback(
    (band: (typeof CR_BANDS)[number]): boolean =>
      crActive && band.min >= filters.crMin && band.max <= filters.crMax,
    [crActive, filters.crMax, filters.crMin]
  )

  const handleCrBandsChange = useCallback(
    (keys: string[]): void => {
      const selected = CR_BANDS.filter((band) => keys.includes(band.key))
      if (selected.length === 0) {
        patchFilters({ crEnabled: false })
        return
      }

      const lo = Math.min(...selected.map((band) => band.min))
      const hi = Math.max(...selected.map((band) => band.max))
      setCrDraft([lo, hi])
      patchFilters({ crEnabled: true, crMin: lo, crMax: hi })
    },
    [patchFilters]
  )

  const handleChangeStart = (d: Date | null): void => {
    if (d && filters.endDate && filters.endDate < d) {
      patchFilters({ rangeKey: 'custom', startDate: d, endDate: endOf(d) })
    } else {
      patchFilters({ rangeKey: 'custom', startDate: d })
    }
  }
  const handleChangeEnd = (d: Date | null): void => {
    if (d && filters.startDate && filters.startDate > d) {
      patchFilters({ rangeKey: 'custom', startDate: startOf(d), endDate: d })
    } else {
      patchFilters({ rangeKey: 'custom', endDate: d })
    }
  }

  return (
    <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {/* 職業選擇 */}
        <ToggleButtonGroup
          size="small"
          value={filters.myClass}
          exclusive
          onChange={(_, val) => val && patchFilters({ myClass: val as ClassName })}
          sx={{
            flexWrap: 'wrap',
            '& .Mui-selected': { bgcolor: classesMap[filters.myClass ?? 'elf'].bgColor },
            '& .Mui-selected:hover': { bgcolor: classesMap[filters.myClass ?? 'elf'].bgColor }
          }}
        >
          {classes.map((c) => (
            <ToggleButton sx={{ width: '100px', minWidth: '100px' }} key={c.id} value={c.id}>
              <Typography sx={{ color: c.color }}>{c.label}</Typography>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {/* 模式選擇 */}
        <Box display="flex" justifyContent="space-between">
          <ToggleButtonGroup
            size="small"
            value={filters.gameMode}
            exclusive
            onChange={(_, val) => val && patchFilters({ gameMode: val as ModeFilter })}
            sx={{ flexWrap: 'wrap' }}
          >
            {/* The backend has always understood `'all'`; it simply had no control. */}
            <ToggleButton sx={{ width: '100px' }} value="all">
              <Typography>全部</Typography>
            </ToggleButton>
            {modes
              .filter((m) => m.id !== 'unknown')
              .map((m) => (
                <ToggleButton sx={{ width: '100px' }} key={m.id} value={m.id}>
                  <Typography color={m.color}>{m.label}</Typography>
                </ToggleButton>
              ))}
          </ToggleButtonGroup>
        </Box>

        {/* 快速區間 + 自訂日期 */}
        <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
          <ToggleButtonGroup
            size="small"
            value={filters.rangeKey}
            exclusive
            onChange={(_, v: RangeKey) => v && patchFilters({ rangeKey: v })}
            sx={{ mb: 1 }}
          >
            <ToggleButton sx={{ width: '80px' }} value="today">
              <Typography>今天</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="7d">
              <Typography>7 天內</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="30d">
              <Typography>30 天內</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="all">
              <Typography>生涯</Typography>
            </ToggleButton>
            <ToggleButton sx={{ width: '80px' }} value="custom">
              <Typography>自訂</Typography>
            </ToggleButton>
          </ToggleButtonGroup>

          {filters.rangeKey === 'custom' && (
            <LocalizationProvider
              dateAdapter={AdapterDateFns}
              adapterLocale={dfZhTW}
              localeText={localeText}
            >
              <Box display="flex" gap={2}>
                <DatePicker
                  reduceAnimations
                  label="開始日期"
                  open={openStart}
                  onOpen={() => setOpenStart(true)}
                  onClose={() => setOpenStart(false)}
                  value={filters.startDate}
                  onChange={handleChangeStart}
                  format="yyyy/MM/dd"
                  disableFuture
                  slotProps={{
                    day: datePickerStyle.day,
                    textField: { size: 'small', onClick: () => setOpenStart(true) },
                    popper: { keepMounted: true }
                  }}
                />
                <DatePicker
                  reduceAnimations
                  label="結束日期"
                  open={openEnd}
                  onOpen={() => setOpenEnd(true)}
                  onClose={() => setOpenEnd(false)}
                  value={filters.endDate}
                  onChange={handleChangeEnd}
                  format="yyyy/MM/dd"
                  disableFuture
                  slotProps={{
                    day: datePickerStyle.day,
                    textField: { size: 'small', onClick: () => setOpenEnd(true) },
                    popper: { keepMounted: true }
                  }}
                />
              </Box>
            </LocalizationProvider>
          )}
        </Box>

        {/* 依牌組 / 依標籤（牌組只顯示目前職業） */}
        <Box display="flex" gap={2} flexWrap="wrap" alignItems="center">
          <Autocomplete
            onOpen={() => {
              refreshDecks()
            }}
            multiple
            disableCloseOnSelect
            options={deckOptionsSortedFiltered}
            getOptionLabel={(d) => d.name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            value={selectedDecks}
            onChange={(_, val) => patchFilters({ deckIds: (val ?? []).map((d) => d.id) })}
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
              ].filter(Boolean) as React.ReactNode[]
            }}
            slotProps={{ listbox: { sx: { maxHeight: 420 } } }}
            sx={{ minWidth: 320 }}
          />

          <Autocomplete
            onOpen={() => {
              refreshTags()
            }}
            multiple
            disableCloseOnSelect
            options={allTags as TagLite[]}
            getOptionLabel={(t) => t.name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            value={selectedTags}
            onChange={(_, val) => patchFilters({ tagIds: (val ?? []).map((t) => t.id) })}
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
              ].filter(Boolean) as React.ReactNode[]
            }}
            slotProps={{ listbox: { sx: { maxHeight: 420 } } }}
            sx={{ minWidth: 320 }}
          />
        </Box>

        {/* CR 篩選與對局列表採相同規則：分段可多選，合併為一段連續範圍。 */}
        <Box
          sx={{
            border: '1px solid',
            borderColor: crActive ? 'primary.main' : 'divider',
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
            onClick={() => toggleCrEnabled(!crActive)}
          >
            <Typography sx={{ fontWeight: 600 }}>CR 篩選</Typography>
            {crActive && (
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
              checked={crActive}
              onClick={(event) => event.stopPropagation()}
              onChange={(_, checked) => toggleCrEnabled(checked)}
            />
          </Box>

          <Collapse in={crActive}>
            <Box sx={{ px: 2, pb: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              <Box>
                <Typography variant="caption" sx={{ opacity: 0.7 }}>
                  選擇分數段（可多選，範圍為連續區間）
                </Typography>
                <ToggleButtonGroup
                  orientation="vertical"
                  fullWidth
                  size="small"
                  value={CR_BANDS.filter(isCrBandActive).map((band) => band.key)}
                  onChange={(_, keys: string[]) => handleCrBandsChange(keys)}
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
                  value={crDraft[0]}
                  onChange={(event) => setCrDraft([Number(event.target.value), crDraft[1]])}
                  onBlur={() => commitCrDraft(crDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitCrDraft(crDraft)
                  }}
                  slotProps={{ htmlInput: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
                  sx={{ flex: 1 }}
                />
                <Typography sx={{ opacity: 0.5 }}>–</Typography>
                <TextField
                  label="最高"
                  size="small"
                  type="number"
                  value={crDraft[1]}
                  onChange={(event) => setCrDraft([crDraft[0], Number(event.target.value)])}
                  onBlur={() => commitCrDraft(crDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitCrDraft(crDraft)
                  }}
                  slotProps={{ htmlInput: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
                  sx={{ flex: 1 }}
                />
              </Box>
            </Box>
          </Collapse>
        </Box>
      </Box>

      {/* A failed query keeps the previous chart, so say so explicitly. */}
      {error && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      <LineChart data={analyzeData} height={chartHeight} />
    </Box>
  )
}

export default Analyzer
