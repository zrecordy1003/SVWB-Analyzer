import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import type { GameMode } from '@shared/domain'
import type { RangeKey } from '@shared/types'
import { classes, classesMap, modes } from '@renderer/map/classMap'
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

const rangeOptions: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: 'all', label: '全部' }
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
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  const [classFilter, setClassFilter] = useState('all')
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

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.electron.ipcRenderer
      .invoke('decks:stats', { rangeKey, mode: modeFilter })
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
  }, [modeFilter, rangeKey])

  useEffect(() => {
    if (!loading && !decksLoading) setHasLoadedOnce(true)
  }, [decksLoading, loading])

  useEffect(() => {
    const unsubscribe = window.electron?.ipcRenderer.on('matches:needRefetch', () => {
      void window.electron.ipcRenderer
        .invoke('decks:stats', { rangeKey, mode: modeFilter })
        .then((response) => {
          if (response?.ok) setStats(response.data ?? [])
        })
    })
    return () => unsubscribe?.()
  }, [modeFilter, rangeKey])

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

  const playedRows = rows.filter((row) => row.total > 0)
  const totalGames = playedRows.reduce((sum, row) => sum + row.total, 0)
  const totalWins = playedRows.reduce((sum, row) => sum + row.wins, 0)
  const overallRate = totalGames ? (totalWins / totalGames) * 100 : 0
  const bestDeck = playedRows[0]
  const showInitialSkeleton = !hasLoadedOnce

  return (
    <Box sx={{ maxWidth: 1120, mx: 'auto', pb: 4 }}>
      <Paper elevation={0} sx={{ position: 'relative', borderRadius: 0, overflow: 'hidden' }}>
        <Box
          sx={{
            px: { xs: 2, sm: 2.5 },
            py: 1.25
          }}
        >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.25}
            alignItems={{ md: 'center' }}
            justifyContent="space-between"
          >
            <ToggleButtonGroup
              exclusive
              size="small"
              value={rangeKey}
              onChange={(_, value: RangeKey | null) => value && setRangeKey(value)}
            >
              {rangeOptions.map((option) => (
                <ToggleButton key={option.key} value={option.key}>
                  {option.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Stack direction="row" spacing={1.25}>
              <FormControl size="small" sx={{ minWidth: 144 }}>
                <InputLabel id="deck-performance-mode">模式</InputLabel>
                <Select
                  labelId="deck-performance-mode"
                  value={modeFilter}
                  label="模式"
                  onChange={(event) => setModeFilter(event.target.value as ModeFilter)}
                >
                  <MenuItem value="all">所有模式</MenuItem>
                  {modes.map((option) => (
                    <MenuItem key={option.id} value={option.id}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 136 }}>
                <InputLabel id="deck-performance-class">職業</InputLabel>
                <Select
                  labelId="deck-performance-class"
                  value={classFilter}
                  label="職業"
                  onChange={(event) => setClassFilter(event.target.value)}
                >
                  <MenuItem value="all">所有職業</MenuItem>
                  {classes.map((item) => (
                    <MenuItem key={item.id} value={item.id}>
                      {item.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 136 }}>
                <InputLabel id="deck-performance-sort">排序</InputLabel>
                <Select
                  labelId="deck-performance-sort"
                  value={sortBy}
                  label="排序"
                  onChange={(event) => setSortBy(event.target.value as SortKey)}
                >
                  <MenuItem value="winRate">勝率</MenuItem>
                  <MenuItem value="total">場次</MenuItem>
                  <MenuItem value="name">名稱</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          </Stack>
        </Box>

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
              <Box sx={{ px: 2.5, py: 7, textAlign: 'center' }}>
                <Typography fontWeight={700}>還沒有可顯示的牌組</Typography>
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
