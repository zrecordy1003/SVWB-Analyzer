import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  alpha,
  Alert,
  Box,
  FormControlLabel,
  Paper,
  Skeleton,
  Switch,
  Typography
} from '@mui/material'
import DateRangeOutlinedIcon from '@mui/icons-material/DateRangeOutlined'
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined'
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import type { SvgIconComponent } from '@mui/icons-material'
import type { GameMode } from '@shared/domain'
import type { RangeKey } from '@shared/types'
import { modes } from '@renderer/map/classMap'
import { ModeSelect } from '@renderer/components/Common/filters/ModeSelect'
import { ClassSelect, type ClassChoiceId } from '@renderer/components/Common/filters/ClassSelect'
import { RangeEditor, type RangePatch } from '@renderer/components/Common/filters/FilterEditors'
import { AdvancedFilterBar } from '@renderer/components/Common/filters/AdvancedFilterBar'
import { rangeChipLabel } from '@renderer/components/Common/filters/rangeLabels'
import { SegmentedControl } from '@renderer/components/Common/SegmentedControl'
import DeckTile from './DeckTile'
import DeckRow, { type DeckRowData } from './DeckRow'
import AddDeckTile from './AddDeckTile'
import DeckContentsDrawer from '@renderer/components/DeckCards/DeckContentsDrawer'
import DeckVersionsPanel, {
  type CorrectVersionRequest,
  type VersionStat
} from '@renderer/components/DeckCards/DeckVersionsPanel'
import { groupDeckFamilies, type DeckFamily } from '@renderer/components/DeckCards/deckVersions'
import AddDeckFlow from '@renderer/components/DeckBuilder/AddDeckFlow'
import DeckBuilder from '@renderer/components/DeckBuilder/DeckBuilder'
import { readSetting } from '@renderer/components/Analyzer/filterState'
import { useDecksTags, type DeckLite } from '../../hooks/useDecksTags'
import { deckStatsResource } from '@renderer/resources'

type SplitRecord = { total: number; wins: number }
type DeckStat = {
  /** Null on the "no deck assigned" catch-all row, which this page does not list. */
  deckId: number | null
  total: number
  wins: number
  winRate: number
  /** 先攻／後攻各自的成績，列表模式的那兩條長條就是畫這個。 */
  first?: SplitRecord
  second?: SplitRecord
  /** 這一列最早／最晚一場的 playedAt（ms），版本時間線畫「打過的期間」用。 */
  firstPlayedAt?: number | null
  lastPlayedAt?: number | null
}
const EMPTY_SPLIT: SplitRecord = { total: 0, wins: 0 }
type SortKey = 'winRate' | 'total' | 'name'
type ModeFilter = GameMode | 'all'

/**
 * 同一份牌組的兩種看法。
 *
 * 列表是預設：視窗一放大，磚塊只會愈長愈胖，而其他頁面在同樣的寬度下都是一列
 * 一筆——整個應用在大視窗下該長得一樣。磚塊留著是因為它做得到列表做不到的事：
 * 卡圖讓人一眼認出是哪一副牌。
 */
type ViewMode = 'list' | 'grid'
const VIEW_MODE_SETTING = 'deckPerformance.viewMode'
const VIEW_SEGMENTS: Array<{ id: ViewMode; label: string; icon: React.ReactNode }> = [
  { id: 'list', label: '列表', icon: <ViewListOutlinedIcon sx={{ fontSize: 16 }} /> },
  { id: 'grid', label: '卡牌', icon: <GridViewOutlinedIcon sx={{ fontSize: 16 }} /> }
]

/** 工作列上的控制項一律同高；32 配 40 看起來像沒對齊的 bug。 */
const TOOLBAR_CONTROL_HEIGHT = 36

/**
 * 這一頁的進階條件只有一條：時間區間。
 *
 * 它和另外兩頁一樣收進 chip 那一列而不是常駐在工作列上 - 工作列留給「看誰的
 * 牌組、哪一個模式」，時間是限定詞。條件只有一條也照用共用的那條列：chip 的
 * 長相、＋ 的虛線邊框、就地編輯的 popover 三頁必須一致。
 */
type DeckFilterKey = 'range'

const DECK_FILTER_LABELS: Record<DeckFilterKey, string> = { range: '時間區間' }
const DECK_FILTER_ICONS: Record<DeckFilterKey, SvgIconComponent> = { range: DateRangeOutlinedIcon }

/** 就地編輯時間區間的 popover 寬度：放得下五顆按鈕與兩個日期欄。 */
const RANGE_EDITOR_WIDTH = 372

/**
 * 排序用分段切換，不用下拉：三種看法永遠剛好選中一種，而且點一下就換 -
 * 下拉要點兩下，還會把「現在照什麼排」藏在收起來的面板裡。
 */
const SORT_SEGMENTS: Array<{ id: SortKey; label: string }> = [
  { id: 'winRate', label: '勝率' },
  { id: 'total', label: '場次' },
  { id: 'name', label: '名稱' }
]

const NO_STATS: DeckStat[] = []

const DeckPerformanceSkeleton = ({ view }: { view: ViewMode }): React.JSX.Element => (
  <>
    <Box
      sx={{
        px: { xs: 2, sm: 2.5 },
        py: 1.5,
        display: 'flex',
        gap: 3,
        alignItems: 'center',
        bgcolor: 'action.hover'
      }}
    >
      <Skeleton variant="text" width={112} />
      <Skeleton variant="text" width={76} />
      <Skeleton variant="text" width={190} />
    </Box>
    <Box
      sx={{
        p: 2,
        display: 'grid',
        gap: view === 'grid' ? 1.25 : 0.75,
        gridTemplateColumns:
          view === 'grid'
            ? { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }
            : '1fr'
      }}
      aria-label="牌組戰績載入中"
    >
      {/* 骨架照著等一下要出現的東西畫，換過來才不會先閃一次錯的版面。 */}
      {Array.from({ length: view === 'grid' ? 6 : 8 }, (_, index) => (
        <Skeleton key={index} variant="rounded" height={view === 'grid' ? 150 : 44} />
      ))}
    </Box>
  </>
)

/**
 * 一列 = 一個家族。數字是家族歷代版本的合計，身分（名稱、職業、卡圖、組成）
 * 取自當前版本。`family` 帶著走，展開版本區時直接交給面板。
 */
type FamilyRow = DeckRowData & {
  family: DeckFamily<DeckLite>
  losses: number
  createdAt: number
}

const DeckPerformance = (): React.JSX.Element => {
  const {
    allDeckVersions,
    allCategories,
    loading: decksLoading,
    error: decksError,
    refreshDecks
  } = useDecksTags()
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d')
  // 只有 rangeKey === 'custom' 時才會送出，其餘區間由主行程自己算。
  const [startDate, setStartDate] = useState<Date | null>(null)
  const [endDate, setEndDate] = useState<Date | null>(null)
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  const [classFilter, setClassFilter] = useState<ClassChoiceId>('all')
  const [sortBy, setSortBy] = useState<SortKey>('winRate')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  /**
   * 刪掉但打過的牌組預設不顯示（plan 3.3 / V-2）：全都顯示清單會被退役的牌
   * 淹掉，全都不顯示使用者會以為資料不見了。所以是一個開關，關著的時候藏起來。
   */
  const [showArchived, setShowArchived] = useState(false)
  /** 展開版本區的家族。 */
  const [expandedFamilies, setExpandedFamilies] = useState<ReadonlySet<number>>(() => new Set())
  // 還沒讀回存檔前不要寫回去，否則預設值會蓋掉使用者上次選的那個。
  const viewModeLoadedRef = useRef(false)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)

  // Start from the mode the player most recently used. The select stays fully
  // editable, so this is a helpful default rather than a hidden constraint.
  useEffect(() => {
    let active = true
    void window.matches.fetchRecent(1, 'all').then((recent) => {
      const mode = recent?.[0]?.mode as GameMode | null | undefined
      if (active && mode && modes.some((option) => option.id === mode)) setModeFilter(mode)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.settings
      .getAll()
      .catch(() => null)
      .then((raw) => {
        if (!active) return
        const stored = raw ? readSetting(raw, VIEW_MODE_SETTING) : undefined
        if (stored === 'list' || stored === 'grid') setViewMode(stored)
        viewModeLoadedRef.current = true
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!viewModeLoadedRef.current) return
    window.settings.set(VIEW_MODE_SETTING, viewMode).catch(() => {})
  }, [viewMode])

  /**
   * 自訂區間的兩個日期只在 rangeKey 是 custom 時送出 - 其餘區間由主行程自己
   * 算，帶著上一次挑的日期過去會把「今天」默默變成那兩天。
   *
   * `groupBy: 'deck'`：一次拿到每個版本的成績。家族的合計在這裡加起來，兩層
   * 數字才保證對得上——分兩次問（family 一次、deck 一次）在兩次 IPC 之間可能
   * 多一場對局，合計就不等於各版本之和。
   */
  const statsParams = useMemo(
    () => ({
      rangeKey,
      mode: modeFilter,
      start: rangeKey === 'custom' ? (startDate?.toISOString() ?? null) : null,
      end: rangeKey === 'custom' ? (endDate?.toISOString() ?? null) : null,
      groupBy: 'deck' as const
    }),
    [endDate, modeFilter, rangeKey, startDate]
  )

  /**
   * One line for what used to be three `useState`s and two effects.
   *
   * There were two: one fetching on a parameter change, one fetching again on
   * `matches:needRefetch`, with the error handling written out twice and no
   * de-duplication between them - so a broadcast arriving mid-fetch issued a
   * second identical query. `deckStatsResource` collapses both, and the hook
   * holds the last answer across a filter change so the numbers on screen do
   * not blank out while the next set loads.
   */
  const { data: statsData, loading, error } = deckStatsResource.use([statsParams])
  // A module constant, not `?? []`: a fresh array each render makes every
  // downstream `useMemo` recompute while there is no data, which is exactly
  // what `react-hooks/exhaustive-deps` complains about here.
  const stats: DeckStat[] = statsData ?? NO_STATS

  useEffect(() => {
    if (!loading && !decksLoading) setHasLoadedOnce(true)
  }, [decksLoading, loading])

  // The card list is fetched by the dialog itself, so a deck nobody opens costs
  // nothing here.
  const [inspecting, setInspecting] = useState<{ id: number; name: string } | null>(null)
  /** 從某一版的「修正卡表…」開進建構器的那一版；存檔直接改寫它，不 fork。 */
  const [correcting, setCorrecting] = useState<CorrectVersionRequest | null>(null)
  // 先問「匯入還是自己建」，之後的路交給 `AddDeckFlow`。
  const [adding, setAdding] = useState(false)

  /** 每個版本的成績，給展開的版本面板用。 */
  const versionStats = useMemo(() => {
    const map = new Map<number, VersionStat>()
    for (const stat of stats) {
      if (stat.deckId !== null) {
        map.set(stat.deckId, {
          total: stat.total,
          wins: stat.wins,
          winRate: stat.winRate,
          firstPlayedAt: stat.firstPlayedAt ?? null,
          lastPlayedAt: stat.lastPlayedAt ?? null
        })
      }
    }
    return map
  }, [stats])

  const families = useMemo(() => groupDeckFamilies(allDeckVersions), [allDeckVersions])

  const rows = useMemo<FamilyRow[]>(() => {
    const statByDeck = new Map(stats.map((stat) => [stat.deckId, stat]))
    return families
      .filter((family) => showArchived || !family.archived)
      .filter((family) => classFilter === 'all' || String(family.current.classId) === classFilter)
      .map((family) => {
        // 家族合計 = 各版本相加。fork 前後的對局在這裡合回同一副牌。
        let total = 0
        let wins = 0
        const first = { total: 0, wins: 0 }
        const second = { total: 0, wins: 0 }
        for (const version of family.versions) {
          const stat = statByDeck.get(version.deck.id)
          if (!stat) continue
          total += stat.total
          wins += stat.wins
          first.total += stat.first?.total ?? 0
          first.wins += stat.first?.wins ?? 0
          second.total += stat.second?.total ?? 0
          second.wins += stat.second?.wins ?? 0
        }
        const deck = family.current
        const currentVersion =
          family.versions.find((v) => v.deck.id === deck.id)?.number ?? family.versions.length
        return {
          family,
          id: deck.id,
          familyId: family.familyId,
          name: deck.name,
          classId: deck.classId == null ? null : String(deck.classId),
          categoryName: deck.categoryName,
          heroBannerHash: deck.heroBannerHash,
          composition: deck.composition,
          createdAt: deck.createdAt,
          archived: family.archived,
          versionCount: family.versions.length,
          currentVersion,
          total,
          wins,
          losses: total - wins,
          winRate: total > 0 ? +((wins / total) * 100).toFixed(2) : 0,
          first: first.total ? first : EMPTY_SPLIT,
          second: second.total ? second : EMPTY_SPLIT
        }
      })
      .sort((a, b) => {
        // Sorting by name means by name. Floating a group to the top there
        // would break the one ordering whose whole promise is that it has no
        // opinion about anything except the name.
        if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-Hant')

        // A deck with no matches has neither a win rate nor a match count, so
        // both remaining sorts rank it last - which is precisely where a deck
        // the user just built must not land. Unplayed decks lead instead,
        // newest first, and the ranked ones follow.
        const aUnplayed = a.total === 0
        const bUnplayed = b.total === 0
        if (aUnplayed !== bUnplayed) return aUnplayed ? -1 : 1
        if (aUnplayed) return b.createdAt - a.createdAt

        if (sortBy === 'total') return b.total - a.total || b.winRate - a.winRate
        return b.winRate - a.winRate || b.total - a.total
      })
  }, [families, classFilter, showArchived, sortBy, stats])

  const toggleExpanded = useCallback((familyId: number): void => {
    setExpandedFamilies((prev) => {
      const next = new Set(prev)
      if (next.has(familyId)) next.delete(familyId)
      else next.add(familyId)
      return next
    })
  }, [])

  /** 三個欄位一起收，因為「挑了一個日期」本身就是把區間切成自訂。 */
  const applyRangePatch = useCallback((patch: RangePatch): void => {
    if (patch.rangeKey !== undefined) setRangeKey(patch.rangeKey)
    if (patch.startDate !== undefined) setStartDate(patch.startDate)
    if (patch.endDate !== undefined) setEndDate(patch.endDate)
  }, [])

  const rangeChips = useMemo(() => {
    const label = rangeChipLabel(rangeKey, startDate, endDate)
    return label ? [{ key: 'range' as DeckFilterKey, label }] : []
  }, [endDate, rangeKey, startDate])

  const archivedCount = useMemo(
    () =>
      families.filter(
        (f) => f.archived && (classFilter === 'all' || String(f.current.classId) === classFilter)
      ).length,
    [families, classFilter]
  )

  const playedRows = rows.filter((row) => row.total > 0)
  const totalGames = playedRows.reduce((sum, row) => sum + row.total, 0)
  const totalWins = playedRows.reduce((sum, row) => sum + row.wins, 0)
  const overallRate = totalGames ? (totalWins / totalGames) * 100 : 0
  const bestDeck = playedRows[0]
  const showInitialSkeleton = !hasLoadedOnce

  return (
    // 和分析器、對局列表同一種版面：工作列自己一塊，內容在下面另外一塊。
    <Box
      sx={{
        // 不再自己夾一個 1120 的上限：分析器和對局列表都用滿 Main 給的寬度，
        // 這一頁夾住的話，視窗一放大就只有它縮在中間。
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        pb: 4
      }}
    >
      {/* 工作列：一眼看得完的三件事 - 看誰的牌組、哪一個模式，以及這份清單
          照什麼排。時間區間收進下面那條進階條件列，和另外兩頁一樣。 */}
      <Paper
        variant="outlined"
        sx={{ borderRadius: 2, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}
      >
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          {/* 職業擺最左：這一頁的清單是牌組，而牌組先屬於一個職業 - 選職業是
              在挑「看哪一疊牌」，模式只是那疊牌打在哪裡的限定詞。 */}
          <ClassSelect
            allowAll
            value={classFilter}
            onChange={setClassFilter}
            height={TOOLBAR_CONTROL_HEIGHT}
          />

          <ModeSelect value={modeFilter} onChange={setModeFilter} height={TOOLBAR_CONTROL_HEIGHT} />

          {/* 顯示已刪除的牌組：一個開關，不是篩選條件——它不縮小資料，而是把
              預設藏起來的那幾副放回清單。 */}
          <Box data-testid="deck-performance-show-archived">
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                  inputProps={{ 'aria-label': '顯示已刪除的牌組' }}
                />
              }
              label={
                <Typography variant="body2" color="text.secondary">
                  顯示已刪除的牌組{archivedCount > 0 ? `（${archivedCount}）` : ''}
                </Typography>
              }
              sx={{ ml: 0.5, mr: 0 }}
            />
          </Box>

          <Box sx={{ flex: 1, minWidth: 8 }} />

          {/* 排序不是篩選，所以隔著空白擺到另一邊 - 它不會讓資料變少，只換順序。
              檢視也一樣，而且和排序是同一種東西（換看法，不換資料），所以緊接
              在它右邊、用同一種分段切換。 */}
          <Box display="flex" alignItems="center" gap={1}>
            <Typography variant="caption" color="text.secondary">
              排序
            </Typography>
            <SegmentedControl
              options={SORT_SEGMENTS}
              value={sortBy}
              onChange={setSortBy}
              height={TOOLBAR_CONTROL_HEIGHT}
              minSegmentWidth={64}
              aria-label="排序方式"
            />
          </Box>

          <SegmentedControl
            options={VIEW_SEGMENTS}
            value={viewMode}
            onChange={setViewMode}
            height={TOOLBAR_CONTROL_HEIGHT}
            minSegmentWidth={72}
            aria-label="檢視方式"
          />
        </Box>

        {/* 時間區間：生效中就是一顆 chip，點開就地改；清掉它等於看生涯。
            和分析器、對局列表共用同一條列與同一個編輯器。 */}
        <AdvancedFilterBar
          chips={rangeChips}
          addableKeys={rangeChips.length ? [] : (['range'] as DeckFilterKey[])}
          labels={DECK_FILTER_LABELS}
          icons={DECK_FILTER_ICONS}
          renderEditor={() => (
            <RangeEditor
              rangeKey={rangeKey}
              startDate={startDate}
              endDate={endDate}
              onChange={applyRangePatch}
            />
          )}
          onEnable={() => applyRangePatch({ rangeKey: '30d' })}
          onRemove={() => applyRangePatch({ rangeKey: 'all' })}
          onClearAll={() => applyRangePatch({ rangeKey: 'all' })}
          editorWidth={() => RANGE_EDITOR_WIDTH}
        />
      </Paper>

      <Paper elevation={0} sx={{ position: 'relative', borderRadius: 2, overflow: 'hidden' }}>
        {(error || Boolean(decksError)) && (
          <Alert severity="warning" square>
            {error ?? (decksError instanceof Error ? decksError.message : '無法載入牌組資料')}
          </Alert>
        )}

        {showInitialSkeleton ? (
          <DeckPerformanceSkeleton view={viewMode} />
        ) : (
          <>
            <Box
              sx={{
                px: { xs: 2, sm: 2.5 },
                py: 1.5,
                display: 'flex',
                gap: { xs: 1.5, sm: 3 },
                alignItems: 'center',
                flexWrap: 'wrap',
                bgcolor: 'action.hover'
              }}
            >
              <Typography variant="body2">
                <Box
                  component="span"
                  sx={{
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    color: totalGames
                      ? overallRate >= 50
                        ? 'success.main'
                        : 'error.main'
                      : 'text.secondary'
                  }}
                >
                  {overallRate.toFixed(1)}%
                </Box>
                <Box component="span" color="text.secondary">
                  {' '}
                  整體勝率
                </Box>
              </Typography>
              <Typography variant="body2">
                <Box component="span" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {totalGames}
                </Box>
                <Box component="span" color="text.secondary">
                  {' '}
                  場對局
                </Box>
              </Typography>
              {bestDeck && (
                <Typography variant="body2" color="text.secondary">
                  最佳表現：
                  <Box component="span" color="text.primary" fontWeight={700}>
                    {bestDeck.name}
                  </Box>
                  ，{bestDeck.winRate.toFixed(1)}%
                </Typography>
              )}
            </Box>

            {/* The grid always renders, even with nothing in it: the dashed
                tile IS the empty state, and hiding it behind a separate
                "nothing here" panel would put the only way to add a deck
                somewhere the user cannot reach. */}
            {rows.length === 0 && !loading && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ px: { xs: 1.5, sm: 2 }, pt: 2 }}
              >
                {classFilter === 'all'
                  ? '還沒有牌組。貼上遊戲裡的牌組代碼，或自己組一副。'
                  : '這個職業底下還沒有牌組，換一個職業或選「全部職業」。'}
              </Typography>
            )}
            {viewMode === 'grid' ? (
              <Box
                sx={{
                  p: { xs: 1.5, sm: 2 },
                  display: 'grid',
                  gap: 1.25,
                  // Two up on a narrow window, four on a wide one. A tile has to
                  // stay wide enough for a deck name plus its record on one line.
                  // Fewer, larger tiles than before: at four across, the art
                  // was a sliver and the whole point of putting it there was
                  // lost.
                  gridTemplateColumns: {
                    xs: '1fr',
                    sm: 'repeat(2, minmax(0, 1fr))',
                    xl: 'repeat(3, minmax(0, 1fr))'
                  }
                }}
              >
                {/* First, not last: an empty slot at the head of the grid reads
                    as "add one", while the same tile at the end reads as the
                    tail of the list. */}
                <AddDeckTile onClick={() => setAdding(true)} />

                {rows.map((row) => (
                  <DeckTile
                    key={row.familyId}
                    deck={row}
                    onClick={() => setInspecting({ id: row.id, name: row.name })}
                  />
                ))}
              </Box>
            ) : (
              <Box>
                {/* 列表版的「新增牌組」：磚塊那個虛線框在一列一筆的版面裡會變成
                    一條空白帶，所以改成同高的一列，位置照舊擺在最前面。 */}
                <Box
                  onClick={() => setAdding(true)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setAdding(true)
                    }
                  }}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 2,
                    py: 1.25,
                    cursor: 'pointer',
                    color: 'text.secondary',
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    transition: 'background-color .14s, color .14s',
                    '&:hover': { color: 'primary.light', bgcolor: 'action.hover' }
                  }}
                >
                  <AddRoundedIcon fontSize="small" />
                  <Typography variant="body2" fontWeight={700}>
                    新增牌組
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.7 }}>
                    貼上代碼，或自己組
                  </Typography>
                </Box>

                {rows.map((row) => {
                  const expanded = expandedFamilies.has(row.familyId)
                  return (
                    <Box key={row.familyId}>
                      <DeckRow
                        deck={row}
                        expanded={expanded}
                        onToggleExpand={() => toggleExpanded(row.familyId)}
                        onClick={() => setInspecting({ id: row.id, name: row.name })}
                      />
                      {/* 版本區：預設收起，要看版本再展開（plan 3.5 - 預設看家族）。
                          數字和上面那一列同一組 stats、同一個時間區間。只有版本
                          時間線，沒有別的分頁：家族內的卡片統計沒有訊號
                          （docs/card-stats-research.md），版本 diff 就內嵌在每一列裡。 */}
                      {expanded && (
                        <Box
                          sx={(theme) => ({
                            px: { xs: 1.5, sm: 2 },
                            pb: 1.5,
                            pt: 0.75,
                            bgcolor: alpha(theme.palette.common.black, 0.18),
                            borderBottom: '1px solid',
                            borderColor: 'divider'
                          })}
                        >
                          <DeckVersionsPanel
                            family={row.family}
                            stats={loading ? null : versionStats}
                            onChanged={() => refreshDecks()}
                            onCorrect={(correction) => setCorrecting(correction)}
                          />
                        </Box>
                      )}
                    </Box>
                  )
                })}
              </Box>
            )}
          </>
        )}
      </Paper>

      {/* 新增牌組：整條路和牌組管理是同一個元件。正在看某一個職業就從那個職業
          開始；看「全部職業」時沒有答案，讓建構器自己的下拉去問。 */}
      <AddDeckFlow
        open={adding}
        categories={allCategories}
        klass={classFilter === 'all' ? undefined : classFilter}
        onClose={() => setAdding(false)}
        onSaved={() => refreshDecks()}
      />

      {/* 修正某一版的卡表：這是另一個入口，不是新增的一部分——存檔直接改寫那一
          版，不 fork。 */}
      {correcting && (
        <DeckBuilder
          open
          deckId={correcting.deckId}
          correction={{ versionLabel: correcting.versionLabel }}
          categories={allCategories}
          onClose={() => setCorrecting(null)}
          onSaved={() => refreshDecks()}
        />
      )}

      <DeckContentsDrawer
        open={inspecting !== null}
        deckId={inspecting?.id ?? null}
        deckName={inspecting?.name ?? ''}
        categories={allCategories}
        onClose={() => setInspecting(null)}
        onSaved={() => refreshDecks()}
      />
    </Box>
  )
}

export default DeckPerformance
