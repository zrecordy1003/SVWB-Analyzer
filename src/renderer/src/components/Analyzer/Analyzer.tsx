// src/renderer/components/Analyzer.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  Drawer,
  IconButton,
  Paper,
  Switch,
  ToggleButton,
  Tooltip,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import type { SvgIconComponent } from '@mui/icons-material'
import DateRangeOutlinedIcon from '@mui/icons-material/DateRangeOutlined'
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined'
import SportsEsportsOutlinedIcon from '@mui/icons-material/SportsEsportsOutlined'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
import TuneIcon from '@mui/icons-material/Tune'

import { classes, classesMap, modes } from '@renderer/map/classMap'
import LineChart from './component/LineChart'
import { ModeSelect } from '@renderer/components/Common/filters/ModeSelect'
import { AdvancedFilterBar } from '@renderer/components/Common/filters/AdvancedFilterBar'
import {
  CrRangeEditor,
  DeckEditor,
  RangeEditor,
  TagEditor,
  type DeckLite,
  type TagLite
} from '@renderer/components/Common/filters/FilterEditors'
import { useDecksTags } from '../../hooks/useDecksTags'
import {
  ADVANCED_FILTER_LABELS,
  MATCH_LIMIT_PRESETS,
  advancedFilterChips,
  buildQueryParams,
  clearAdvancedFilter,
  clearAllAdvancedFilters,
  defaultFilters,
  diffPersistPatch,
  enableAdvancedFilter,
  followBattlePatch,
  hydrateFilters,
  type AdvancedFilterKey,
  type AnalyzerFilters,
  type FilterVocabulary
} from './filterState'

import type { ClassName } from '@shared/domain'
import type { BattleStatus, RankedWinrateByOpponent } from '@shared/types'

const CLASS_ORDER = classes.map((c) => String(c.id))
const classOrderIndex = new Map<string, number>(CLASS_ORDER.map((id, idx) => [id, idx]))

/** Injected into the pure hydrator so it never has to import the class map. */
const FILTER_VOCABULARY: FilterVocabulary = {
  classIds: CLASS_ORDER,
  modeIds: modes.map((m) => String(m.id))
}

/**
 * One glyph per condition, used on the chip, in the ＋ menu and on both
 * headings - the same condition must look the same wherever it turns up.
 * 牌組 borrows the icon the nav already uses for 牌組戰績.
 */
const ADVANCED_FILTER_ICONS: Record<AdvancedFilterKey, SvgIconComponent> = {
  range: DateRangeOutlinedIcon,
  decks: StyleOutlinedIcon,
  tags: LocalOfferOutlinedIcon,
  cr: MilitaryTechOutlinedIcon
}

/** Every toolbar control is pinned to one height; mixed 32/40px reads as a bug. */
const TOOLBAR_CONTROL_HEIGHT = 36

/** Long enough to swallow a burst of clicks, short enough to feel immediate. */
const QUERY_DEBOUNCE_MS = 180
const PERSIST_DEBOUNCE_MS = 400

const Analyzer: React.FC = () => {
  const [filters, setFilters] = useState<AnalyzerFilters>(defaultFilters)
  const [analyzeData, setAnalyzeData] = useState<RankedWinrateByOpponent | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The date range, decks, tags and CR live in the right-hand drawer; the
  // toolbar keeps class, mode and match count, plus a chip per active condition
  // that edits the same condition in place.
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
  /** Read by the long-lived battle subscriptions, which never re-bind. */
  const followRef = useRef(filters.followBattle)
  /** Only a genuinely new match is followed; an edit to an old one is not. */
  const followedMatchIdRef = useRef<number | null>(null)

  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  useEffect(() => {
    followRef.current = filters.followBattle
  }, [filters.followBattle])

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

  /* ---------- 跟隨對戰 ---------- */

  /**
   * `battle:status` is broadcast on every recognition poll, and it repeats the
   * same class for the whole battle. Spreading it unconditionally would mint a
   * new filters object each poll, and the query effect keys off that object -
   * one game would fire a query per poll. Bail out when nothing moved.
   */
  const applyFollowPatch = useCallback((patch: Partial<AnalyzerFilters>): void => {
    setFilters((prev) => {
      const next = { ...prev, ...patch }
      return next.myClass === prev.myClass && next.gameMode === prev.gameMode ? prev : next
    })
  }, [])

  /**
   * A live battle names the class immediately; ranked names the mode only at
   * its result screen, so this half of the follow moves the class now and the
   * mode arrives with the recorded match below.
   */
  useEffect(() => {
    const unsub = window.electron?.ipcRenderer.on(
      'battle:status',
      (_event: unknown, status: BattleStatus) => {
        if (!followRef.current) return
        const patch = followBattlePatch(status, FILTER_VOCABULARY)
        if (patch) applyFollowPatch(patch)
      }
    )
    return () => {
      unsub && unsub()
    }
  }, [applyFollowPatch])

  /* ---------- 外部要求重抓（只訂閱一次） ---------- */
  useEffect(() => {
    const handler = (): void => {
      void runQuery(filtersRef.current)
      if (!followRef.current) return
      // `needRefetch` also fires when a user edits or deletes a match, so the
      // id gate is what keeps an edit to last week's game from dragging the
      // filters onto whatever class that game was.
      void window.matches
        .fetchRecent(1)
        .then((rows) => {
          const latest = rows?.[0]
          if (!latest || latest.id === followedMatchIdRef.current) return
          followedMatchIdRef.current = latest.id
          if (!followRef.current) return
          const patch = followBattlePatch(
            { ownClass: latest.my_class, mode: latest.mode },
            FILTER_VOCABULARY
          )
          if (patch) applyFollowPatch(patch)
        })
        .catch(() => {})
    }
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', handler)
    return () => {
      unsub && unsub()
    }
  }, [applyFollowPatch, runQuery])

  /* ---------- 動態高度 ---------- */
  // 510 covers the toolbar's two rows - controls plus the always-present
  // condition row - and the chart's own chrome.
  const [chartHeight, setChartHeight] = useState<number>(Math.max(350, window.innerHeight - 510))
  useEffect(() => {
    const onResize = (): void => setChartHeight(Math.max(350, window.innerHeight - 510))
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

  /* ---------- CR ---------- */
  const crActive = filters.crEnabled

  /* ---------- 場數 ---------- */

  /**
   * A stored count that is not one of the presets - written by the custom field
   * this toolbar used to carry, or by an older build. It gets its own button
   * rather than leaving the group blank, which would cap the query with nothing
   * on screen saying so.
   */
  const strayLimit =
    filters.matchLimit !== null && !MATCH_LIMIT_PRESETS.includes(filters.matchLimit)
      ? filters.matchLimit
      : null

  const limitToggleValue = filters.matchLimit === null ? 'all' : String(filters.matchLimit)

  const advancedChips = useMemo(() => advancedFilterChips(filters), [filters])

  /**
   * One editor per condition, rendered in two places: stacked in the drawer,
   * and alone in the popover a chip opens. Same component either way, so the
   * two surfaces cannot drift.
   */
  const renderEditor = (key: AdvancedFilterKey, autoFocus = false): React.ReactNode => {
    switch (key) {
      case 'range':
        return (
          <RangeEditor
            rangeKey={filters.rangeKey}
            startDate={filters.startDate}
            endDate={filters.endDate}
            onChange={patchFilters}
          />
        )
      case 'decks':
        return (
          <DeckEditor
            options={deckOptionsSortedFiltered}
            value={selectedDecks}
            onOpen={refreshDecks}
            onChange={(deckIds) => patchFilters({ deckIds })}
            autoFocus={autoFocus}
          />
        )
      case 'tags':
        return (
          <TagEditor
            options={(allTags ?? []) as TagLite[]}
            value={selectedTags}
            onOpen={refreshTags}
            onChange={(tagIds) => patchFilters({ tagIds })}
            autoFocus={autoFocus}
          />
        )
      case 'cr':
        // Editing the range is itself the request to apply it.
        return (
          <CrRangeEditor
            min={filters.crMin}
            max={filters.crMax}
            onCommit={(crMin, crMax) => patchFilters({ crEnabled: true, crMin, crMax })}
          />
        )
    }
  }

  /** Conditions with no chip yet - what the ＋ button can still offer. */
  const addableKeys = useMemo<AdvancedFilterKey[]>(() => {
    const active = new Set(advancedChips.map((chip) => chip.key))
    return (Object.keys(ADVANCED_FILTER_LABELS) as AdvancedFilterKey[]).filter(
      (key) => !active.has(key)
    )
  }, [advancedChips])

  return (
    <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {/* 工作列：一眼看得完的三件事 - 打什麼職業、什麼模式、算幾場。
          其餘條件都收進抽屜，但生效中的會以 chip 回到這裡，
          否則抽屜關上以後就沒有任何東西說明資料被縮小過。 */}
      <Paper
        variant="outlined"
        sx={{ borderRadius: 2, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}
      >
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          {/* 職業：整張圖的主體，所以留在最外層、一次點擊就到 -
              查詢沒有職業畫不出東西，模式只是限定詞。 */}
          <ToggleButtonGroup
            size="small"
            value={filters.myClass}
            exclusive
            // Picking by hand is a decision the next battle must not overwrite.
            onChange={(_, val) =>
              val && patchFilters({ myClass: val as ClassName, followBattle: false })
            }
            sx={{
              flexWrap: 'wrap',
              '& .MuiToggleButton-root': { height: TOOLBAR_CONTROL_HEIGHT, py: 0 },
              '& .Mui-selected': { bgcolor: classesMap[filters.myClass ?? 'elf'].bgColor },
              '& .Mui-selected:hover': { bgcolor: classesMap[filters.myClass ?? 'elf'].bgColor }
            }}
          >
            {classes.map((c) => (
              <ToggleButton sx={{ width: '76px', minWidth: '76px' }} key={c.id} value={c.id}>
                <Typography variant="body2" sx={{ color: c.color }}>
                  {c.label}
                </Typography>
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />

          {/* 模式：一個月不見得動一次，所以收成一個下拉。
              The backend has always understood `'all'`; it simply had no control. */}
          <ModeSelect
            value={filters.gameMode}
            onChange={(gameMode) => patchFilters({ gameMode, followBattle: false })}
            height={TOOLBAR_CONTROL_HEIGHT}
          />

          {/* 跟隨開關。手動改職業或模式會把它關掉，所以它同時是「為什麼剛剛
              自己跳了」和「為什麼現在不跳了」的答案 - 兩種狀態都看得見。 */}
          <Tooltip
            title={
              filters.followBattle
                ? '跟隨對戰中：職業與模式會跟著你正在打的那場走'
                : '已停止跟隨：點一下讓職業與模式重新跟著對戰走'
            }
          >
            <ToggleButton
              size="small"
              value="follow"
              selected={filters.followBattle}
              onChange={() => patchFilters({ followBattle: !filters.followBattle })}
              aria-label="跟隨對戰"
              sx={{
                height: TOOLBAR_CONTROL_HEIGHT,
                px: 1.25,
                borderRadius: 2,
                borderColor: 'divider',
                gap: 0.75,
                textTransform: 'none'
              }}
            >
              <SportsEsportsOutlinedIcon fontSize="small" />
              <Typography variant="body2">跟隨</Typography>
            </ToggleButton>
          </Tooltip>

          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />
          {/* 場數：分析器的主要範圍。看的是「最近 N 場」而不是「最近幾天」，
            因為一週打三場和一週打三百場的曲線本來就不該放在同一把尺上。 */}
          <ToggleButtonGroup
            size="small"
            value={limitToggleValue}
            exclusive
            onChange={(_, v: string | null) =>
              v && patchFilters({ matchLimit: v === 'all' ? null : Number(v) })
            }
            sx={{ '& .MuiToggleButton-root': { height: TOOLBAR_CONTROL_HEIGHT, py: 0 } }}
          >
            {MATCH_LIMIT_PRESETS.map((n) => (
              <ToggleButton sx={{ width: '60px' }} key={n} value={String(n)}>
                <Typography variant="body2">{n} 場</Typography>
              </ToggleButton>
            ))}
            {strayLimit !== null && (
              <ToggleButton sx={{ width: '60px' }} value={String(strayLimit)}>
                <Typography variant="body2">{strayLimit} 場</Typography>
              </ToggleButton>
            )}
            <ToggleButton sx={{ width: '60px' }} value="all">
              <Typography variant="body2">全部</Typography>
            </ToggleButton>
          </ToggleButtonGroup>

          <Box sx={{ flex: 1, minWidth: 8 }} />

          <Badge badgeContent={advancedChips.length} color="primary">
            <Button
              size="small"
              variant={advancedChips.length ? 'contained' : 'outlined'}
              startIcon={<TuneIcon />}
              onClick={() => setAdvancedOpen(true)}
              sx={{ height: TOOLBAR_CONTROL_HEIGHT, whiteSpace: 'nowrap' }}
            >
              進階篩選
            </Button>
          </Badge>
        </Box>

        {/* 進階條件列與分析器共用同一個元件，chip、＋ 選單與就地編輯的
            popover 都在裡面。 */}
        <AdvancedFilterBar
          chips={advancedChips}
          addableKeys={addableKeys}
          labels={ADVANCED_FILTER_LABELS}
          icons={ADVANCED_FILTER_ICONS}
          renderEditor={(key, autoFocus) => renderEditor(key, autoFocus)}
          onEnable={(key) => patchFilters(enableAdvancedFilter(key))}
          onRemove={(key) => patchFilters(clearAdvancedFilter(key))}
          onClearAll={() => patchFilters(clearAllAdvancedFilters())}
          editorWidth={(key) => (key === 'decks' ? 380 : 340)}
        />
      </Paper>

      {/* A failed query keeps the previous chart, so say so explicitly. */}
      {error && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      <LineChart data={analyzeData} height={chartHeight} />

      {/* 進階篩選抽屜。條件即時生效，沒有「套用」按鈕 - 查詢本來就有 debounce，
          多一顆按鈕只會多一種「以為改了其實沒按到」的狀態。 */}
      <Drawer
        anchor="right"
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
        slotProps={{
          paper: {
            sx: {
              width: 440,
              maxWidth: 'calc(100vw - 32px)',
              borderTopLeftRadius: 16,
              borderBottomLeftRadius: 16
            }
          }
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Box
            sx={{
              px: 3,
              pt: 3,
              pb: 2,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 2
            }}
          >
            <Box>
              <Typography variant="h6" component="h2" fontWeight={700}>
                進階篩選
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                時間區間、牌組、標籤與 CR
              </Typography>
            </Box>
            <IconButton
              size="small"
              onClick={() => setAdvancedOpen(false)}
              aria-label="關閉進階篩選"
            >
              <CloseIcon />
            </IconButton>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              px: 3,
              py: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 2.5
            }}
          >
            {(['range', 'decks', 'tags'] as const).map((key) => {
              const Icon = ADVANCED_FILTER_ICONS[key]
              return (
                <Box key={key}>
                  <Box display="flex" alignItems="center" gap={0.75} sx={{ mb: 1 }}>
                    <Icon fontSize="small" />
                    <Typography variant="subtitle2" fontWeight={700}>
                      {ADVANCED_FILTER_LABELS[key]}
                    </Typography>
                  </Box>
                  {renderEditor(key)}
                </Box>
              )
            })}

            {/* CR keeps its own on/off header: unlike the others it has a range
                even while switched off, so the switch is what says whether the
                query carries it. */}
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
                onClick={() => patchFilters({ crEnabled: !crActive })}
              >
                <MilitaryTechOutlinedIcon fontSize="small" />
                <Typography sx={{ fontWeight: 600 }}>CR 篩選</Typography>
                {crActive && (
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    label={`${filters.crMin} – ${filters.crMax}`}
                  />
                )}
                <Box flex={1} />
                <Switch
                  size="small"
                  checked={crActive}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(_, checked) => patchFilters({ crEnabled: checked })}
                />
              </Box>

              <Collapse in={crActive}>
                <Box sx={{ px: 2, pb: 2 }}>{renderEditor('cr')}</Box>
              </Collapse>
            </Box>
          </Box>

          <Box sx={{ borderTop: 1, borderColor: 'divider', px: 3, py: 2 }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" gap={1}>
              <Button
                size="small"
                disabled={advancedChips.length === 0}
                onClick={() => patchFilters(clearAllAdvancedFilters())}
              >
                清除全部條件
              </Button>
              <Button variant="contained" size="small" onClick={() => setAdvancedOpen(false)}>
                完成
              </Button>
            </Box>
          </Box>
        </Box>
      </Drawer>
    </Box>
  )
}

export default Analyzer
