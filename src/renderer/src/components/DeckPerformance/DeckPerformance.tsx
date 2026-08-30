import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography
} from '@mui/material'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
import DateRangeOutlinedIcon from '@mui/icons-material/DateRangeOutlined'
import type { SvgIconComponent } from '@mui/icons-material'
import type { GameMode } from '@shared/domain'
import type { RangeKey } from '@shared/types'
import { classesMap, modes } from '@renderer/map/classMap'
import { ModeSelect } from '@renderer/components/Common/filters/ModeSelect'
import { ClassSelect, type ClassChoiceId } from '@renderer/components/Common/filters/ClassSelect'
import { RangeEditor, type RangePatch } from '@renderer/components/Common/filters/FilterEditors'
import { AdvancedFilterBar } from '@renderer/components/Common/filters/AdvancedFilterBar'
import { rangeChipLabel } from '@renderer/components/Common/filters/rangeLabels'
import { SegmentedControl } from '@renderer/components/Common/SegmentedControl'
import EmptyState from '@renderer/components/Common/EmptyState'
import { useDecksTags } from '../../hooks/useDecksTags'

type DeckStat = { deckId: number; total: number; wins: number; winRate: number }
type SortKey = 'winRate' | 'total' | 'name'
type ModeFilter = GameMode | 'all'

type DeckArchetype = { label: string; color: string; background: string }

function getDeckArchetype(categoryName: string | null): DeckArchetype | null {
  if (!categoryName) return null
  const name = categoryName.toLocaleLowerCase()
  if (name.includes('快攻') || name.includes('aggro') || name.includes('fast')) {
    return { label: '快攻', color: '#ff9b9b', background: 'rgba(210, 69, 69, 0.18)' }
  }
  if (name.includes('中速') || name.includes('midrange') || name.includes('mid')) {
    return { label: '中速', color: '#f2c879', background: 'rgba(204, 147, 38, 0.18)' }
  }
  if (name.includes('控制') || name.includes('control')) {
    return { label: '控制', color: '#8dc7ff', background: 'rgba(66, 134, 214, 0.18)' }
  }
  return null
}

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
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" sx={{ minWidth: 680 }} aria-label="牌組戰績載入中">
        <TableHead>
          <TableRow
            sx={{
              '& .MuiTableCell-root': {
                py: 1.25,
                color: 'text.secondary',
                fontSize: 12,
                fontWeight: 700
              }
            }}
          >
            <TableCell>牌組</TableCell>
            <TableCell>戰績</TableCell>
            <TableCell sx={{ minWidth: 210 }}>勝率</TableCell>
            <TableCell align="right">場次</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {Array.from({ length: 6 }, (_, index) => (
            <TableRow key={index} sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
              <TableCell>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Skeleton variant="circular" width={9} height={9} />
                  <Box>
                    <Skeleton variant="text" width={130} />
                    <Skeleton variant="text" width={92} height={16} />
                  </Box>
                </Stack>
              </TableCell>
              <TableCell>
                <Skeleton variant="text" width={72} />
              </TableCell>
              <TableCell>
                <Skeleton variant="rounded" height={6} width="90%" />
              </TableCell>
              <TableCell align="right">
                <Skeleton variant="text" width={28} sx={{ ml: 'auto' }} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  </>
)

const DeckPerformance = (): React.JSX.Element => {
  const { allDecks, loading: decksLoading, error: decksError } = useDecksTags()
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
        if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-Hant')
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

            {rows.length === 0 && !loading ? (
              // 三個頁面同一塊空狀態，只有「該怎麼放寬」那句話不一樣。
              <Box sx={{ p: 2 }}>
                <EmptyState
                  icon={<StyleOutlinedIcon sx={{ fontSize: 40, opacity: 0.6 }} />}
                  title="還沒有可顯示的牌組"
                  description={
                    classFilter === 'all'
                      ? '先在牌組管理建立牌組，或把時間區間放寬一點。'
                      : '這個職業底下還沒有牌組，換一個職業或選「全部職業」。'
                  }
                />
              </Box>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 680 }}>
                  <TableHead>
                    <TableRow
                      sx={{
                        '& .MuiTableCell-root': {
                          py: 1.25,
                          color: 'text.secondary',
                          fontSize: 12,
                          fontWeight: 700
                        }
                      }}
                    >
                      <TableCell>牌組</TableCell>
                      <TableCell>戰績</TableCell>
                      <TableCell sx={{ minWidth: 210 }}>勝率</TableCell>
                      <TableCell align="right">場次</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => {
                      const classInfo = classesMap[String(row.classId)]
                      const archetype = getDeckArchetype(row.categoryName)
                      const performanceColor =
                        row.total === 0
                          ? 'text.secondary'
                          : row.winRate >= 50
                            ? 'success.main'
                            : 'error.main'
                      return (
                        <TableRow key={row.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                          <TableCell>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Box>
                                <Stack direction="row" spacing={0.75} alignItems="center">
                                  {archetype ? (
                                    <Chip
                                      label={archetype.label}
                                      size="small"
                                      sx={{
                                        height: 20,
                                        minWidth: 42,
                                        fontSize: 11,
                                        fontWeight: 800,
                                        color: archetype.color,
                                        bgcolor: archetype.background
                                      }}
                                    />
                                  ) : row.categoryName ? (
                                    <Chip
                                      label={row.categoryName}
                                      size="small"
                                      variant="outlined"
                                      sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
                                    />
                                  ) : null}
                                  <Typography fontWeight={700}>{row.name}</Typography>
                                </Stack>
                                <Stack
                                  direction="row"
                                  spacing={0.75}
                                  alignItems="center"
                                  sx={{ mt: 0.25 }}
                                >
                                  <Typography
                                    variant="caption"
                                    sx={{
                                      color: classInfo?.color ?? 'text.secondary',
                                      fontWeight: 700
                                    }}
                                  >
                                    {classInfo?.label ?? '未分類'}
                                  </Typography>
                                </Stack>
                              </Box>
                            </Stack>
                          </TableCell>
                          <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>
                            {row.total ? (
                              <Stack direction="row" spacing={0.75}>
                                <Box
                                  component="span"
                                  sx={{ color: 'success.main', fontWeight: 700 }}
                                >
                                  {row.wins} 勝
                                </Box>
                                <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>
                                  {row.losses} 敗
                                </Box>
                              </Stack>
                            ) : (
                              <Typography variant="body2" color="text.secondary">
                                尚無對局
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" alignItems="center" spacing={1.25}>
                              <LinearProgress
                                variant="determinate"
                                value={row.winRate}
                                sx={{
                                  flex: 1,
                                  height: 6,
                                  borderRadius: 10,
                                  bgcolor: 'action.selected',
                                  '& .MuiLinearProgress-bar': {
                                    borderRadius: 10,
                                    bgcolor: row.winRate >= 50 ? 'success.main' : 'error.main'
                                  }
                                }}
                              />
                              <Typography
                                sx={{
                                  width: 52,
                                  fontWeight: 700,
                                  fontVariantNumeric: 'tabular-nums',
                                  color: performanceColor
                                }}
                              >
                                {row.winRate.toFixed(1)}%
                              </Typography>
                            </Stack>
                          </TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                            {row.total}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </Box>
            )}
          </>
        )}
      </Paper>
    </Box>
  )
}

export default DeckPerformance
