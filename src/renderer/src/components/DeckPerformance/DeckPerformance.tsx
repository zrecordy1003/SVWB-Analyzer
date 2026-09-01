import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Paper, Skeleton, Typography } from '@mui/material'
import DateRangeOutlinedIcon from '@mui/icons-material/DateRangeOutlined'
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
import AddDeckTile from './AddDeckTile'
import DeckContentsDialog from '@renderer/components/DeckCards/DeckContentsDialog'
import DeckBuilder from '@renderer/components/DeckBuilder/DeckBuilder'
import NewDeckDialog from '@renderer/components/DeckBuilder/NewDeckDialog'
import { useDecksTags } from '../../hooks/useDecksTags'

type DeckStat = { deckId: number; total: number; wins: number; winRate: number }
type SortKey = 'winRate' | 'total' | 'name'
type ModeFilter = GameMode | 'all'

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

const DeckPerformanceSkeleton = (): React.JSX.Element => (
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
        gap: 1.25,
        gridTemplateColumns: {
          xs: '1fr',
          sm: 'repeat(2, minmax(0, 1fr))',
          xl: 'repeat(3, minmax(0, 1fr))'
        }
      }}
      aria-label="牌組戰績載入中"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} variant="rounded" height={150} />
      ))}
    </Box>
  </>
)

const DeckPerformance = (): React.JSX.Element => {
  const {
    allDecks,
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
  const [stats, setStats] = useState<DeckStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

  /**
   * 自訂區間的兩個日期只在 rangeKey 是 custom 時送出 - 其餘區間由主行程自己
   * 算，帶著上一次挑的日期過去會把「今天」默默變成那兩天。
   */
  const statsParams = useMemo(
    () => ({
      rangeKey,
      mode: modeFilter,
      start: rangeKey === 'custom' ? (startDate?.toISOString() ?? null) : null,
      end: rangeKey === 'custom' ? (endDate?.toISOString() ?? null) : null
    }),
    [endDate, modeFilter, rangeKey, startDate]
  )

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.electron.ipcRenderer
      .invoke('decks:stats', statsParams)
      .then((response) => {
        if (!active) return
        if (!response?.ok) throw new Error(response?.error ?? '無法載入牌組戰績')
        setStats(response.data ?? [])
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '無法載入牌組戰績')
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [statsParams])

  useEffect(() => {
    if (!loading && !decksLoading) setHasLoadedOnce(true)
  }, [decksLoading, loading])

  // The card list is fetched by the dialog itself, so a deck nobody opens costs
  // nothing here.
  const [inspecting, setInspecting] = useState<{ id: number; name: string } | null>(null)
  /**
   * The builder, and which deck it is showing.
   *
   * `{ deckId: null }` is an empty builder and `null` is a closed one, so the
   * two cases that both look like "nothing" stay distinguishable. Importing
   * lands here too: the dialog creates the deck and hands the id over, because
   * the thing a user wants right after bringing a deck in is to look at it.
   */
  const [building, setBuilding] = useState<{ deckId: number | null } | null>(null)
  // 先問「匯入還是自己建」，再決定要不要開整頁的建構器。
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const unsubscribe = window.electron?.ipcRenderer.on('matches:needRefetch', () => {
      void window.electron.ipcRenderer.invoke('decks:stats', statsParams).then((response) => {
        if (response?.ok) setStats(response.data ?? [])
      })
    })
    return () => unsubscribe?.()
  }, [statsParams])

  const rows = useMemo(() => {
    const statByDeck = new Map(stats.map((stat) => [stat.deckId, stat]))
    return allDecks
      .filter((deck) => classFilter === 'all' || deck.classId === classFilter)
      .map((deck) => {
        const stat = statByDeck.get(deck.id)
        const total = stat?.total ?? 0
        const wins = stat?.wins ?? 0
        return { ...deck, total, wins, losses: total - wins, winRate: stat?.winRate ?? 0 }
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
  }, [allDecks, classFilter, sortBy, stats])

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
        maxWidth: 1120,
        mx: 'auto',
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

          <Box sx={{ flex: 1, minWidth: 8 }} />

          {/* 排序不是篩選，所以隔著空白擺到另一邊 - 它不會讓資料變少，只換順序。 */}
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
          <DeckPerformanceSkeleton />
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
            {
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
                    key={row.id}
                    deck={{
                      id: row.id,
                      name: row.name,
                      classId: row.classId == null ? null : String(row.classId),
                      categoryName: row.categoryName,
                      heroBannerHash: row.heroBannerHash,
                      composition: row.composition,
                      total: row.total,
                      wins: row.wins,
                      winRate: row.winRate
                    }}
                    onClick={() => setInspecting({ id: row.id, name: row.name })}
                  />
                ))}
              </Box>
            }
          </>
        )}
      </Paper>

      <NewDeckDialog
        open={adding}
        onClose={() => setAdding(false)}
        onOpenDeck={(deckId) => {
          refreshDecks()
          setBuilding({ deckId })
        }}
        onBuildManually={() => setBuilding({ deckId: null })}
      />

      <DeckBuilder
        open={building !== null}
        deckId={building?.deckId ?? null}
        categories={allCategories}
        onClose={() => setBuilding(null)}
        onSaved={() => refreshDecks()}
      />

      <DeckContentsDialog
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
