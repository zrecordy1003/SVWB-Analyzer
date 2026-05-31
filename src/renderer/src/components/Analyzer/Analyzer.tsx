// src/renderer/components/Analyzer.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Autocomplete,
  Box,
  Chip,
  FormControlLabel,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  Slider,
  Checkbox
} from '@mui/material'
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { zhTW as pickersZhTW } from '@mui/x-date-pickers/locales'
import { zhTW as dfZhTW } from 'date-fns/locale'

import { classes, classesMap, modes } from '@renderer/map/classMap'
import LineChart from './component/LineChart'
import { useDecksTags } from '../../hooks/useDecksTags'

import type { ClassName, GameMode } from '@prisma/client'
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

type RankedEx = RankedWinrateByOpponent & {
  myDeckIds?: number[]
  crMin?: number | null
  crMax?: number | null
}

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

const CR_MIN_BOUND = 0
const CR_MAX_BOUND = 3000
const CR_STEP = 1
const CR_PRESETS: Array<{ key: string; label: string; min: number | null; max: number | null }> = [
  { key: 'lt1650', label: '< 1650', min: null, max: 1649 },
  { key: 'epic', label: '1650–1749', min: 1650, max: 1749 },
  { key: 'ultimate', label: '1750–1849', min: 1750, max: 1849 },
  { key: 'legend', label: '1850+', min: 1850, max: null },
  { key: 'gte2000', label: '2000+', min: 2000, max: null }
]
const CR_MARKS = [
  { value: 1500, label: '1500' },
  { value: 1650, label: '1650' },
  { value: 1750, label: '1750' },
  { value: 1850, label: '1850' },
  { value: 2000, label: '2000' }
]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))

const Analyzer: React.FC = () => {
  const localeText = pickersZhTW.components.MuiLocalizationProvider.defaultProps.localeText
  const [openStart, setOpenStart] = useState(false)
  const [openEnd, setOpenEnd] = useState(false)

  const [analyzeData, setAnalyzeData] = useState<RankedEx | null>(null)

  const [rangeKey, setRangeKey] = useState<RangeKey>('today')
  const [startDate, setStartDate] = useState<Date | null>(new Date())
  const [endDate, setEndDate] = useState<Date | null>(new Date())

  const [selectedClass, setSelectedClass] = useState<ClassName>('elf')
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode>('ranked')

  // 牌組/標籤
  const { allDecks, allTags, refreshDecks, refreshTags } = useDecksTags()
  const [selectedDecks, setSelectedDecks] = useState<DeckLite[]>([])
  const [selectedTags, setSelectedTags] = useState<TagLite[]>([])

  // ⭐ CR 篩選
  const [crEnabled, setCrEnabled] = useState<boolean>(false)
  const [crMin, setCrMin] = useState<number>(1650)
  const [crMax, setCrMax] = useState<number>(1850)
  const [crDraft, setCrDraft] = useState<[number, number]>([crMin, crMax])

  // hydrated gate
  const hydratedRef = useRef(false)
  const savedDeckIdsRef = useRef<number[] | null>(null)
  const savedTagIdsRef = useRef<number[] | null>(null)

  const prevClassRef = useRef<ClassName | null>(null)
  useEffect(() => {
    // 尚未完成設定還原（避免首次載入時把還原好的牌組清掉）
    if (!hydratedRef.current) {
      prevClassRef.current = selectedClass
      return
    }

    // 真的從 A 職業切換到 B 職業 → 清空已選牌組
    if (prevClassRef.current && prevClassRef.current !== selectedClass) {
      setSelectedDecks([]) // 清空
    }
    prevClassRef.current = selectedClass
  }, [selectedClass])

  // 初始載入（只讀）
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const [
        lastClass,
        lastMode,
        lastRangeKey,
        lastStartDate,
        lastEndDate,
        lastDeckIds,
        lastTagIds,
        lastCrEnabled,
        lastCrMin,
        lastCrMax
      ] = await Promise.all([
        window.settings.get<ClassName>('analyzer.myClass'),
        window.settings.get<GameMode>('analyzer.gameMode'),
        window.settings.get<RangeKey>('analyzer.rangeKey'),
        window.settings.get<string | null>('analyzer.startDate'),
        window.settings.get<string | null>('analyzer.endDate'),
        window.settings.get<number[]>('analyzer.deckIds'),
        window.settings.get<number[]>('analyzer.tagIds'),
        window.settings.get<boolean>('analyzer.crEnabled'),
        window.settings.get<number>('analyzer.crMin'),
        window.settings.get<number>('analyzer.crMax')
      ])
      if (!mounted) return

      if (lastClass) setSelectedClass(lastClass)
      if (lastMode) setSelectedGameMode(lastMode)
      if (lastRangeKey) setRangeKey(lastRangeKey)
      if (lastStartDate) setStartDate(new Date(lastStartDate))
      if (lastEndDate) setEndDate(new Date(lastEndDate))

      savedDeckIdsRef.current = Array.isArray(lastDeckIds) ? lastDeckIds : null
      savedTagIdsRef.current = Array.isArray(lastTagIds) ? lastTagIds : null

      if (typeof lastCrEnabled === 'boolean') setCrEnabled(lastCrEnabled)
      if (typeof lastCrMin === 'number') setCrMin(lastCrMin)
      if (typeof lastCrMax === 'number') setCrMax(lastCrMax)
      if (typeof lastCrMin === 'number' && typeof lastCrMax === 'number')
        setCrDraft([lastCrMin, lastCrMax])
    })()
    return () => {
      mounted = false
    }
  }, [])

  // options ready -> map ids -> open write gate
  useEffect(() => {
    if (!hydratedRef.current) {
      if (allDecks?.length && savedDeckIdsRef.current) {
        const idSet = new Set(savedDeckIdsRef.current)
        setSelectedDecks(allDecks.filter((d) => idSet.has(d.id)))
      }
      if (allTags?.length && savedTagIdsRef.current) {
        const idSet = new Set(savedTagIdsRef.current)
        setSelectedTags(allTags.filter((t) => idSet.has(t.id)))
      }
      if (allDecks?.length || allTags?.length) {
        hydratedRef.current = true
      }
    }
  }, [allDecks, allTags])

  // 持久化（有 gate）
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings.set('analyzer.myClass', selectedClass).catch(() => {})
  }, [selectedClass])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings.set('analyzer.gameMode', selectedGameMode).catch(() => {})
  }, [selectedGameMode])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings.set('analyzer.rangeKey', rangeKey).catch(() => {})
  }, [rangeKey])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings
      .set('analyzer.startDate', startDate ? startDate.toISOString() : null)
      .catch(() => {})
  }, [startDate])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings.set('analyzer.endDate', endDate ? endDate.toISOString() : null).catch(() => {})
  }, [endDate])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings
      .set(
        'analyzer.deckIds',
        selectedDecks.map((d) => d.id)
      )
      .catch(() => {})
  }, [selectedDecks])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings
      .set(
        'analyzer.tagIds',
        selectedTags.map((t) => t.id)
      )
      .catch(() => {})
  }, [selectedTags])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings.set('analyzer.crEnabled', crEnabled).catch(() => {})
  }, [crEnabled])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings.set('analyzer.crMin', crMin).catch(() => {})
  }, [crMin])
  useEffect(() => {
    if (!hydratedRef.current) return
    window.settings.set('analyzer.crMax', crMax).catch(() => {})
  }, [crMax])

  // 動態高度
  const [chartHeight, setChartHeight] = useState<number>(Math.max(350, window.innerHeight - 580))
  useEffect(() => {
    const onResize = (): void => setChartHeight(Math.max(350, window.innerHeight - 580))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 依職業過濾牌組（只顯示該職業）
  const deckOptionsSortedFiltered = useMemo<DeckLite[]>(() => {
    const src = (allDecks ?? []) as DeckLite[]

    // 先依職業濾出（只顯示目前選擇的職業）
    const filtered = selectedClass
      ? src.filter((d) => d.classId != null && String(d.classId) === String(selectedClass))
      : src

    // 排序：categorySort -> categoryName -> classOrder -> deck.name
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
  }, [allDecks, selectedClass])

  const groupKeyOf = (d: DeckLite) => {
    const k = String(d.categorySort ?? 9999).padStart(4, '0')
    const name = d.categoryName ?? '未分類'
    return `${k} ${name}`
  }
  const displayGroupLabel = (key: string) => key.replace(/^\d+\s/, '')

  // 請求參數
  const myDeckIds = useMemo(() => selectedDecks.map((d) => d.id), [selectedDecks])
  const tagIds = useMemo(() => selectedTags.map((t) => t.id), [selectedTags])

  // 載入資料
  const loadDataFor = useCallback(
    async (
      myClass: ClassName,
      gameMode: GameMode,
      key: RangeKey,
      s: Date | null,
      e: Date | null,
      deckIds: number[],
      tIds: number[],
      cEnabled: boolean,
      cMin: number,
      cMax: number
    ) => {
      const base: any = {
        myClass,
        gameMode,
        myDeckIds: deckIds,
        tagIds: tIds
      }
      if (cEnabled) {
        base.crMin = cMin
        base.crMax = cMax
      }
      const stats =
        key === 'custom'
          ? await window.matches.getRankedWinrate({
              ...base,
              start: s ?? undefined,
              end: e ?? undefined
            })
          : await window.matches.getRankedWinrate({ ...base, rangeKey: key })

      // 回來時附加 meta（若後端也回傳，這段可省）
      setAnalyzeData({
        ...(stats as RankedWinrateByOpponent),
        myDeckIds: deckIds,
        crMin: cEnabled ? cMin : null,
        crMax: cEnabled ? cMax : null
      })
    },
    []
  )

  // 視圖或篩選改變
  useEffect(() => {
    loadDataFor(
      selectedClass,
      selectedGameMode,
      rangeKey,
      startDate,
      endDate,
      myDeckIds,
      tagIds,
      crEnabled,
      crMin,
      crMax
    )
  }, [
    selectedClass,
    selectedGameMode,
    rangeKey,
    startDate,
    endDate,
    myDeckIds,
    tagIds,
    crEnabled,
    crMin,
    crMax,
    loadDataFor
  ])

  // 外部要求重抓
  useEffect(() => {
    const handler = (): Promise<void> =>
      loadDataFor(
        selectedClass,
        selectedGameMode,
        rangeKey,
        startDate,
        endDate,
        myDeckIds,
        tagIds,
        crEnabled,
        crMin,
        crMax
      )
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsub && unsub()
    }
  }, [
    loadDataFor,
    selectedClass,
    selectedGameMode,
    rangeKey,
    startDate,
    endDate,
    myDeckIds,
    tagIds,
    crEnabled,
    crMin,
    crMax
  ])

  const handleChangeStart = (d: Date | null): void => {
    setRangeKey('custom')
    if (d && endDate && endDate < d) {
      setStartDate(d)
      setEndDate(endOf(d))
    } else {
      setStartDate(d)
    }
  }
  const handleChangeEnd = (d: Date | null): void => {
    setRangeKey('custom')
    if (d && startDate && startDate > d) {
      setStartDate(startOf(d))
      setEndDate(d)
    } else {
      setEndDate(d)
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {/* 職業選擇 */}
        <ToggleButtonGroup
          size="small"
          value={selectedClass}
          exclusive
          onChange={(_, val) => val && setSelectedClass(val)}
          sx={{
            '& .Mui-selected': { bgcolor: classesMap[selectedClass ?? 'elf'].bgColor },
            '& .Mui-selected:hover': { bgcolor: classesMap[selectedClass ?? 'elf'].bgColor }
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
            value={selectedGameMode}
            exclusive
            onChange={(_, val) => val && setSelectedGameMode(val)}
          >
            {modes.map((m) => (
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
            value={rangeKey}
            exclusive
            onChange={(_, v: RangeKey) => v && setRangeKey(v)}
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

          {rangeKey === 'custom' && (
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
                  value={startDate}
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
                  value={endDate}
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
            onChange={(_, val) => setSelectedDecks(val ?? [])}
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
                {/* {selected ? <Chip size="small" sx={{ ml: 'auto' }} label="✓" /> : null} */}
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
            onChange={(_, val) => setSelectedTags(val ?? [])}
            renderInput={(params) => <TextField {...params} label="依標籤" variant="outlined" />}
            renderOption={(props, opt, { selected }) => (
              <li {...props}>
                <Checkbox checked={selected} size="small" />
                <Typography>{opt.name}</Typography>
                {/* {selected ? <Chip size="small" sx={{ ml: 'auto' }} label="✓" /> : null} */}
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

        {/* ⭐ CR 區間（與 MatchList 同風格：開關＋預設＋滑桿延遲送出＋數字框） */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
            <FormControlLabel
              control={<Switch checked={crEnabled} onChange={(_, ck) => setCrEnabled(ck)} />}
              label="CR 篩選"
              sx={{ mr: 1 }}
            />
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {CR_PRESETS.map((p) => {
                const active =
                  crEnabled &&
                  (p.min == null ? crMin === CR_MIN_BOUND : crMin === p.min) &&
                  (p.max == null ? crMax === CR_MAX_BOUND : crMax === p.max)
                return (
                  <Chip
                    key={p.key}
                    label={p.label}
                    variant={active ? 'filled' : 'outlined'}
                    color={active ? 'primary' : 'default'}
                    size="small"
                    onClick={() => {
                      const min = p.min ?? CR_MIN_BOUND
                      const max = p.max ?? CR_MAX_BOUND
                      setCrDraft([min, max])
                      setCrMin(min)
                      setCrMax(max)
                      if (!crEnabled) setCrEnabled(true)
                    }}
                    disabled={!crEnabled}
                    sx={{ borderRadius: '999px' }}
                  />
                )
              })}
            </Box>
          </Box>

          <Box display="flex" alignItems="center" gap={1.25} sx={{ opacity: crEnabled ? 1 : 0.6 }}>
            <Typography sx={{ whiteSpace: 'nowrap' }}>CR 區間</Typography>
            <Box sx={{ flex: 1 }}>
              <Slider
                disabled={!crEnabled}
                value={crDraft}
                min={CR_MIN_BOUND}
                max={CR_MAX_BOUND}
                step={CR_STEP}
                onChange={(_, v) => setCrDraft(v as [number, number])} // 拖曳不送出
                onChangeCommitted={(_, v) => {
                  const [minV, maxV] = v as number[]
                  setCrMin(minV)
                  setCrMax(maxV) // 放開才送出
                }}
                valueLabelDisplay="auto"
                marks={CR_MARKS}
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
                const v = clamp(Number(e.target.value), CR_MIN_BOUND, crMax)
                setCrDraft([v, crDraft[1]])
                setCrMin(v)
              }}
              InputProps={{ inputProps: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
              sx={{ width: 110 }}
              // disabled={!crEnabled}
              disabled
            />
            <TextField
              label="最高"
              size="small"
              type="number"
              value={crDraft[1]}
              onChange={(e) => {
                const v = clamp(Number(e.target.value), crMin, CR_MAX_BOUND)
                setCrDraft([crDraft[0], v])
                setCrMax(v)
              }}
              InputProps={{ inputProps: { min: CR_MIN_BOUND, max: CR_MAX_BOUND, step: CR_STEP } }}
              sx={{ width: 110 }}
              // disabled={!crEnabled}
              disabled
            />
          </Box>
        </Box>
      </Box>

      <LineChart data={analyzeData} height={chartHeight} />
    </Box>
  )
}

export default Analyzer
