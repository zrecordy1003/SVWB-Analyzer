// src/renderer/components/Analyzer.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Divider,
  FormControlLabel,
  Paper,
  Switch,
  ToggleButton,
  Tooltip,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined'
import AlignHorizontalLeftIcon from '@mui/icons-material/AlignHorizontalLeft'
import type { SvgIconComponent } from '@mui/icons-material'
import DateRangeOutlinedIcon from '@mui/icons-material/DateRangeOutlined'
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined'
import SportsEsportsOutlinedIcon from '@mui/icons-material/SportsEsportsOutlined'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'

import { classes, modes } from '@renderer/map/classMap'
import MatchupHeatmap from './component/MatchupHeatmap'
import MatchupBars from './component/MatchupBars'
import SegmentedControl from '@renderer/components/Common/SegmentedControl'
import { ModeSelect } from '@renderer/components/Common/filters/ModeSelect'
import { ClassSelect } from '@renderer/components/Common/filters/ClassSelect'
import { AdvancedFilterBar } from '@renderer/components/Common/filters/AdvancedFilterBar'
import {
  CrRangeEditor,
  DeckEditor,
  RangeEditor,
  TagEditor,
  type TagLite
} from '@renderer/components/Common/filters/FilterEditors'
import {
  buildDeckFamilyOptions,
  deckSelectionSize,
  emptyDeckSelection,
  isEmptyDeckSelection,
  pruneDeckSelection,
  sameDeckSelection,
  visibleDeckOptions
} from '@renderer/components/Common/filters/deckSelection'
import { useDecksTags } from '../../hooks/useDecksTags'
import { groupDeckFamilies } from '@renderer/components/DeckCards/deckVersions'
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
  readSetting,
  type AdvancedFilterKey,
  type AnalyzerFilters,
  type FilterVocabulary
} from './filterState'

import type { ClassName } from '@shared/domain'
import type { BattleStatus, RankedWinrateByOpponent } from '@shared/types'

/**
 * 同一組篩選的兩種畫法：對手職業 × 先後攻的表格與長條。卡片維度不在這裡 -
 * 它有自己的一頁（側欄「卡片」），問的是另一個問題（docs/card-stats-research.md）。
 */
type ChartKind = 'heatmap' | 'bars'
const CHART_KIND_SETTING = 'analyzer.chartKind'
/** 圖示先於文字被認出來，段與段之間的差別因此不必讀完才知道。 */
const CHART_OPTIONS: Array<{ id: ChartKind; label: string; icon: React.ReactNode }> = [
  { id: 'heatmap', label: '對戰表', icon: <TableChartOutlinedIcon sx={{ fontSize: 16 }} /> },
  { id: 'bars', label: '長條圖', icon: <AlignHorizontalLeftIcon sx={{ fontSize: 16 }} /> }
]
/**
 * 舊版存過的 `'cards'` 對不到任何一段，落回預設的對戰表 - 存檔裡的值不該讓
 * 分段切換空著。
 */
const isChartKind = (value: unknown): value is ChartKind =>
  CHART_OPTIONS.some((option) => option.id === value)

const CLASS_ORDER = classes.map((c) => String(c.id))

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

  /**
   * 同一份資料的兩種看法：表格適合把數字讀出來，長條適合把差距看出來。
   * 存起來是因為這是個人偏好 - 習慣看長條的人不該每次進來都先切一次。
   */
  const [chartKind, setChartKind] = useState<ChartKind>('heatmap')
  const chartKindLoadedRef = useRef(false)
  const {
    allDeckVersions,
    allTags,
    loading: decksLoading,
    refreshDecks,
    refreshTags
  } = useDecksTags()

  /**
   * 刪掉的牌組預設不列（plan 3.3）。開關只管這一頁、不存檔：它是「我現在想找
   * 一副退役的牌」，不是偏好。
   */
  const [showArchivedDecks, setShowArchivedDecks] = useState(false)
  /**
   * 上次存下的牌組篩選全部都已不存在時，數字會安靜地變成「所有牌組」。這個
   * 提示就是為了不讓它安靜——值是被剔掉的 id 數，0 表示沒有事要說。
   */
  const [prunedDeckCount, setPrunedDeckCount] = useState(0)

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
      const storedChart = raw ? readSetting(raw, CHART_KIND_SETTING) : undefined
      if (isChartKind(storedChart)) setChartKind(storedChart)
      chartKindLoadedRef.current = true

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
   *
   * Pruned against EVERY version row, deleted ones included: a deleted deck or
   * an old version still exists and still has matches, so a filter on it is
   * still a real filter. Only ids that are genuinely gone (hard-deleted) come
   * out. The same pass maps ids an older build stored onto their family
   * (`pruneDeckSelection`).
   *
   * When every picked id is gone the filter would fall back to "all decks"
   * while the chart still looks perfectly plausible - so that case is
   * surfaced as a notice rather than left silent.
   */
  useEffect(() => {
    if (prunedRef.current) return
    if (!settingsLoadedRef.current) return
    if (!allDeckVersions?.length && !allTags?.length) return
    prunedRef.current = true

    const families = groupDeckFamilies(allDeckVersions ?? [])
    const tagIdSet = new Set((allTags ?? []).map((t) => t.id))
    setFilters((prev) => {
      const decks = allDeckVersions?.length ? pruneDeckSelection(prev.decks, families) : prev.decks
      const tagIds = allTags?.length ? prev.tagIds.filter((id) => tagIdSet.has(id)) : prev.tagIds
      if (sameDeckSelection(decks, prev.decks) && tagIds.length === prev.tagIds.length) return prev
      if (!isEmptyDeckSelection(prev.decks) && isEmptyDeckSelection(decks)) {
        setPrunedDeckCount(deckSelectionSize(prev.decks))
      }
      return { ...prev, decks, tagIds }
    })
  }, [allDeckVersions, allTags])

  /* ---------- 切換職業時清空已選牌組 ---------- */
  useEffect(() => {
    if (!settingsLoadedRef.current) return
    if (prevClassRef.current && prevClassRef.current !== filters.myClass) {
      setFilters((prev) =>
        isEmptyDeckSelection(prev.decks) ? prev : { ...prev, decks: emptyDeckSelection() }
      )
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

  useEffect(() => {
    if (!chartKindLoadedRef.current) return
    window.settings.set(CHART_KIND_SETTING, chartKind).catch(() => {})
  }, [chartKind])

  /* ---------- 牌組 / 標籤選項 ---------- */
  const deckFamilies = useMemo(() => groupDeckFamilies(allDeckVersions ?? []), [allDeckVersions])
  /** Read by the long-lived `needRefetch` subscription, next to `filtersRef`. */
  const familiesRef = useRef(deckFamilies)
  useEffect(() => {
    familiesRef.current = deckFamilies
  }, [deckFamilies])

  /* ---------- 載入資料 ---------- */
  const runQuery = useCallback(async (f: AnalyzerFilters): Promise<void> => {
    const requestId = ++requestIdRef.current
    try {
      const params = buildQueryParams(f, familiesRef.current)
      const stats = await window.matches.getRankedWinrate(params)
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
    // A deck pick resolves against the deck list; before that list has arrived
    // it would resolve to nothing, and nothing means "every deck".
    if (decksLoading && !isEmptyDeckSelection(filters.decks)) return
    const handle = setTimeout(() => void runQuery(filters), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [decksLoading, deckFamilies, filters, runQuery])

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

  /**
   * 每副牌一個選項，版本掛在底下。全部的一份給已選的 chip 找名字（不受職業、
   * 「顯示已刪除」影響，否則切一次職業就會把選好的牌組默默清掉），篩過的一份
   * 才是清單裡列出來的。
   */
  const allDeckOptions = useMemo(
    () => buildDeckFamilyOptions(deckFamilies, CLASS_ORDER),
    [deckFamilies]
  )
  const deckOptions = useMemo(
    () =>
      visibleDeckOptions(allDeckOptions, {
        classId: filters.myClass ? String(filters.myClass) : null,
        showArchived: showArchivedDecks
      }),
    [allDeckOptions, filters.myClass, showArchivedDecks]
  )

  const selectedTags = useMemo<TagLite[]>(() => {
    const idSet = new Set(filters.tagIds)
    return ((allTags ?? []) as TagLite[]).filter((t) => idSet.has(t.id))
  }, [allTags, filters.tagIds])

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
            options={deckOptions}
            allOptions={allDeckOptions}
            value={filters.decks}
            onOpen={refreshDecks}
            onChange={(decks) => patchFilters({ decks })}
            autoFocus={autoFocus}
            header={
              <Box display="flex" alignItems="center" justifyContent="flex-end" gap={1}>
                <Box data-testid="analyzer-show-archived">
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={showArchivedDecks}
                        onChange={(event) => setShowArchivedDecks(event.target.checked)}
                        inputProps={{ 'aria-label': '顯示已刪除的牌組' }}
                      />
                    }
                    label={
                      <Typography variant="caption" color="text.secondary">
                        顯示已刪除的牌組
                      </Typography>
                    }
                    sx={{ mr: 0 }}
                  />
                </Box>
              </Box>
            }
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
    // 和對局列表同一種版面：工作列固定在上，下面那塊吃掉剩下的高度並自己捲動。
    // 高度來自 Main 這欄 flex，不自己算 vh - 視窗縮到最小也還是剛好放得下。
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        flex: 1,
        minHeight: 0
      }}
    >
      {/* 工作列：一眼看得完的三件事 - 打什麼職業、什麼模式、算幾場。
          其餘條件都收進抽屜，但生效中的會以 chip 回到這裡，
          否則抽屜關上以後就沒有任何東西說明資料被縮小過。 */}
      <Paper
        variant="outlined"
        sx={{ borderRadius: 2, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}
      >
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          {/* 職業：整張圖的主體，查詢沒有職業就畫不出東西，模式只是限定詞。
              擺成和模式一樣的下拉 - 七顆並排的按鈕會把整條工作列吃掉，而它和
              旁邊那顆做的是同一件事（挑一個），長得不一樣只會讀成兩種功能。 */}
          <ClassSelect
            value={filters.myClass}
            // Picking by hand is a decision the next battle must not overwrite.
            onChange={(myClass) => patchFilters({ myClass, followBattle: false })}
            height={TOOLBAR_CONTROL_HEIGHT}
          />

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
          editorWidth={(key) => (key === 'decks' ? 420 : 340)}
          // 圖表切換貼在這一列右端：那段空白本來就是空的，而它和條件同屬
          // 「現在正在看什麼」，不值得為它多開一列。
          trailing={
            <SegmentedControl
              aria-label="切換圖表"
              options={CHART_OPTIONS}
              value={chartKind}
              onChange={setChartKind}
              height={28}
              minSegmentWidth={92}
            />
          }
        />
      </Paper>

      {/* The saved deck filter pointed at decks that no longer exist, so the
          chart below is "all decks" - which looks like any other chart. Say so. */}
      {prunedDeckCount > 0 && (
        <Alert
          severity="info"
          data-testid="analyzer-deck-filter-pruned"
          onClose={() => setPrunedDeckCount(0)}
        >
          上次選的 {prunedDeckCount} 個牌組已經不存在，目前顯示的是所有牌組的數字。
        </Alert>
      )}

      {/* A failed query keeps the previous chart, so say so explicitly. */}
      {error && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      {/* 內容比這塊高的時候仍然捲得動，但不畫原生捲軸 - 它會蓋在最右邊那欄
          數字上。對局列表的清單也是這樣處理的。 */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' }
        }}
      >
        {chartKind === 'heatmap' ? (
          <MatchupHeatmap data={analyzeData} />
        ) : (
          <MatchupBars data={analyzeData} />
        )}
      </Box>
    </Box>
  )
}

export default Analyzer
