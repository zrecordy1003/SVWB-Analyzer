import {
  Box,
  Card,
  CardContent,
  Chip,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { classes, classesMap, modesMap } from '@renderer/map/classMap'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DeckCategory } from '@prisma/client'
import type { RangeKey } from '@shared/types'

type ApiResult<T> = { ok: true; data: T } | { ok: false; error?: string }
type DeckStat = { deckId: number; total: number; wins: number; winRate: number }
type DeckLite = {
  id: number
  name: string
  classId: string
  categoryId: string | null
  isDefault: boolean
}

type MatchRow = {
  id: number
  oppo_class: string
  result: boolean | null
  playedAt: string | Date
  mode: string | null
  play_order?: 'first' | 'second' | null
}

type DeckAnalysisRow = {
  deckId: number
  name: string
  classId: string
  classLabel: string
  classColor: string
  categoryName: string
  isDefault: boolean
  total: number
  wins: number
  losses: number
  winRate: number
  confidence: 'none' | 'low' | 'ok'
}

type SortKey = 'volume' | 'winRate' | 'name'

const rangeOptions: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'all', label: '全部' }
]

const confidenceLabel: Record<DeckAnalysisRow['confidence'], string> = {
  none: '無樣本',
  low: '樣本少',
  ok: '可參考'
}

function isApiResult<T>(value: unknown): value is ApiResult<T> {
  return typeof value === 'object' && value !== null && 'ok' in value
}

function getApiError(value: unknown, fallback: string): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
  ) {
    return value.error
  }
  return fallback
}

function getClassMeta(classId: string): { label: string; color: string } {
  const meta = classesMap[classId as keyof typeof classesMap]
  return { label: meta?.label ?? classId, color: meta?.color ?? 'rgba(230,232,238,0.86)' }
}

function getModeMeta(mode: string | null): {
  label: string
  color?: 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning'
} {
  if (!mode) return { label: '-' }
  const meta = modesMap[mode as keyof typeof modesMap]
  return { label: meta?.label ?? mode, color: meta?.color }
}

function formatWinRate(value: number): string {
  return `${value.toFixed(1)}%`
}

function getConfidence(total: number): DeckAnalysisRow['confidence'] {
  if (total === 0) return 'none'
  if (total < 10) return 'low'
  return 'ok'
}

const DeckList = (): React.JSX.Element => {
  const [categories, setCategories] = useState<Array<Pick<DeckCategory, 'id' | 'name'>>>([])
  const [decks, setDecks] = useState<DeckLite[]>([])
  const [stats, setStats] = useState<DeckStat[]>([])
  const [filterClass, setFilterClass] = useState<string | null>(null)
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d')
  const [sortKey, setSortKey] = useState<SortKey>('volume')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null)
  const [matches, setMatches] = useState<MatchRow[]>([])
  const [matchCount, setMatchCount] = useState(0)
  const [loadingMatches, setLoadingMatches] = useState(false)

  const fetchStats = useCallback(async (nextRangeKey: RangeKey): Promise<void> => {
    const statsRes = await window.electron.ipcRenderer.invoke('decks:stats', {
      rangeKey: nextRangeKey
    })
    if (!isApiResult<DeckStat[]>(statsRes) || !statsRes.ok) {
      throw new Error(getApiError(statsRes, '讀取牌組統計失敗'))
    }
    setStats(statsRes.data ?? [])
  }, [])

  const fetchInitial = useCallback(
    async (initialRangeKey: RangeKey): Promise<void> => {
      setLoading(true)
      setLoadError(null)
      try {
        const [catRes, deckRes] = await Promise.all([
          window.electron.ipcRenderer.invoke('deckCategories:all'),
          window.electron.ipcRenderer.invoke('decks:all')
        ])

        if (!isApiResult<Array<Pick<DeckCategory, 'id' | 'name'>>>(catRes) || !catRes.ok) {
          throw new Error(getApiError(catRes, '讀取分類失敗'))
        }
        if (
          !isApiResult<
            Array<{
              id: number
              name: string
              class: string
              categoryId: string | null
              isDefault: boolean
            }>
          >(deckRes) ||
          !deckRes.ok
        ) {
          throw new Error(getApiError(deckRes, '讀取牌組失敗'))
        }

        setCategories(catRes.data.map((c) => ({ id: c.id, name: c.name })))
        setDecks(
          deckRes.data.map((d) => ({
            id: d.id,
            name: d.name,
            classId: d.class,
            categoryId: d.categoryId,
            isDefault: !!d.isDefault
          }))
        )
        await fetchStats(initialRangeKey)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '讀取牌組分析失敗')
      } finally {
        setLoading(false)
      }
    },
    [fetchStats]
  )

  const fetchMatches = useCallback(
    async (deckId: number, nextRangeKey: RangeKey): Promise<void> => {
      setLoadingMatches(true)
      try {
        const payload = { myDeckIds: [deckId], rangeKey: nextRangeKey, pageIndex: 0, pageSize: 30 }
        const [rows, count] = (await Promise.all([
          window.electron.ipcRenderer.invoke('matches:getPage', payload),
          window.electron.ipcRenderer.invoke('matches:count', payload)
        ])) as [MatchRow[], number]
        setMatches(rows ?? [])
        setMatchCount(count ?? 0)
      } catch (err) {
        console.error(err)
        setMatches([])
        setMatchCount(0)
      } finally {
        setLoadingMatches(false)
      }
    },
    []
  )

  useEffect(() => {
    void fetchInitial('30d')
  }, [fetchInitial])

  useEffect(() => {
    void fetchStats(rangeKey)
    if (selectedDeckId) void fetchMatches(selectedDeckId, rangeKey)
  }, [fetchMatches, fetchStats, rangeKey, selectedDeckId])

  useEffect(() => {
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', () => {
      void fetchStats(rangeKey)
      if (selectedDeckId) void fetchMatches(selectedDeckId, rangeKey)
    })
    return () => {
      unsub?.()
    }
  }, [fetchMatches, fetchStats, rangeKey, selectedDeckId])

  const categoryMap = useMemo(() => {
    const m = new Map<string, string>()
    categories.forEach((c) => m.set(c.id, c.name))
    return m
  }, [categories])

  const statMap = useMemo(() => {
    const m = new Map<number, DeckStat>()
    stats.forEach((s) => m.set(s.deckId, s))
    return m
  }, [stats])

  const rows = useMemo<DeckAnalysisRow[]>(() => {
    const data = decks.map((deck) => {
      const stat = statMap.get(deck.id)
      const total = stat?.total ?? 0
      const wins = stat?.wins ?? 0
      const meta = getClassMeta(deck.classId)
      return {
        deckId: deck.id,
        name: deck.name,
        classId: deck.classId,
        classLabel: meta.label,
        classColor: meta.color,
        categoryName: deck.categoryId ? (categoryMap.get(deck.categoryId) ?? '未分類') : '未分類',
        isDefault: deck.isDefault,
        total,
        wins,
        losses: Math.max(0, total - wins),
        winRate: stat?.winRate ?? 0,
        confidence: getConfidence(total)
      }
    })

    return data.sort((a, b) => {
      if (sortKey === 'winRate') {
        if (b.winRate === a.winRate) return b.total - a.total
        return b.winRate - a.winRate
      }
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-Hant')
      if (b.total === a.total) return b.winRate - a.winRate
      return b.total - a.total
    })
  }, [categoryMap, decks, sortKey, statMap])

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        const classOk = filterClass ? row.classId === filterClass : true
        const categoryOk = filterCategory === 'all' ? true : row.categoryName === filterCategory
        return classOk && categoryOk
      }),
    [filterCategory, filterClass, rows]
  )

  const selectedDeck = useMemo(
    () => rows.find((row) => row.deckId === selectedDeckId) ?? null,
    [rows, selectedDeckId]
  )

  const summary = useMemo(() => {
    const total = filtered.reduce((sum, row) => sum + row.total, 0)
    const wins = filtered.reduce((sum, row) => sum + row.wins, 0)
    const active = filtered.filter((row) => row.total > 0).length
    const reliable = filtered.filter((row) => row.confidence === 'ok').length
    const best = filtered.find((row) => row.total > 0) ?? null
    return {
      total,
      wins,
      winRate: total ? (wins / total) * 100 : 0,
      active,
      reliable,
      best
    }
  }, [filtered])

  const matchupSummary = useMemo(() => {
    const map = new Map<string, { classId: string; total: number; wins: number }>()
    matches.forEach((match) => {
      if (match.result === null) return
      const current = map.get(match.oppo_class) ?? { classId: match.oppo_class, total: 0, wins: 0 }
      current.total += 1
      if (match.result) current.wins += 1
      map.set(match.oppo_class, current)
    })
    return [...map.values()]
      .map((item) => ({ ...item, winRate: item.total ? (item.wins / item.total) * 100 : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
  }, [matches])

  const rangeLabel = rangeOptions.find((option) => option.key === rangeKey)?.label ?? '全部'

  return (
    <Box sx={{ p: 2.5, color: 'rgba(238,240,246,0.94)' }}>
      <Stack spacing={2.25}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', lg: 'row' },
            justifyContent: 'space-between',
            gap: 1.5
          }}
        >
          <Box>
            <Typography variant="h6">牌組分析</Typography>
            <Typography variant="body2" color="text.secondary">
              以我方牌組為主軸，比較樣本量、勝率與近期對戰結構
            </Typography>
          </Box>

          <Stack direction="row" gap={1} flexWrap="wrap">
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>區間</InputLabel>
              <Select
                label="區間"
                value={rangeKey}
                onChange={(event) => setRangeKey(event.target.value as RangeKey)}
              >
                {rangeOptions.map((option) => (
                  <MenuItem key={option.key} value={option.key}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>分類</InputLabel>
              <Select
                label="分類"
                value={filterCategory}
                onChange={(event) => setFilterCategory(event.target.value)}
              >
                <MenuItem value="all">全部分類</MenuItem>
                <MenuItem value="未分類">未分類</MenuItem>
                {categories.map((category) => (
                  <MenuItem key={category.id} value={category.name}>
                    {category.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>排序</InputLabel>
              <Select
                label="排序"
                value={sortKey}
                onChange={(event) => setSortKey(event.target.value as SortKey)}
              >
                <MenuItem value="volume">場數優先</MenuItem>
                <MenuItem value="winRate">勝率優先</MenuItem>
                <MenuItem value="name">名稱</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </Box>

        <ToggleButtonGroup
          size="small"
          value={filterClass ?? ''}
          exclusive
          onChange={(_, value: string | null) => setFilterClass(value || null)}
          sx={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}
        >
          <ToggleButton value="">全部</ToggleButton>
          {classes.map((klass) => (
            <ToggleButton key={klass.id} value={klass.id}>
              <Typography color={klass.color}>{klass.label}</Typography>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {loadError && <Typography color="error">{loadError}</Typography>}
        {loading && <LinearProgress />}

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' },
            gap: 1.25
          }}
        >
          <Card
            sx={{ bgcolor: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                {rangeLabel}場數
              </Typography>
              <Typography variant="h5">{summary.total}</Typography>
            </CardContent>
          </Card>
          <Card
            sx={{ bgcolor: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                整體勝率
              </Typography>
              <Typography
                variant="h5"
                color={summary.winRate >= 50 ? 'success.main' : 'error.main'}
              >
                {formatWinRate(summary.winRate)}
              </Typography>
            </CardContent>
          </Card>
          <Card
            sx={{ bgcolor: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                有資料牌組
              </Typography>
              <Typography variant="h5">
                {summary.active}/{filtered.length}
              </Typography>
            </CardContent>
          </Card>
          <Card
            sx={{ bgcolor: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <CardContent>
              <Typography variant="body2" color="text.secondary">
                目前最佳
              </Typography>
              <Typography variant="subtitle1" noWrap>
                {summary.best
                  ? `${summary.best.name} (${formatWinRate(summary.best.winRate)})`
                  : '暫無資料'}
              </Typography>
            </CardContent>
          </Card>
        </Box>

        <TableContainer component={Paper} sx={{ bgcolor: 'rgba(255,255,255,0.035)' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>牌組</TableCell>
                <TableCell>職業</TableCell>
                <TableCell>分類</TableCell>
                <TableCell align="right">勝率</TableCell>
                <TableCell align="right">勝敗</TableCell>
                <TableCell align="right">樣本</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((deck) => {
                const active = deck.deckId === selectedDeckId
                return (
                  <TableRow
                    key={deck.deckId}
                    hover
                    selected={active}
                    onClick={() => {
                      setSelectedDeckId(deck.deckId)
                      void fetchMatches(deck.deckId, rangeKey)
                    }}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell>
                      <Stack direction="row" alignItems="center" gap={1}>
                        <Typography fontWeight={600}>{deck.name}</Typography>
                        {deck.isDefault && (
                          <Chip size="small" label="預設" color="success" variant="outlined" />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={deck.classLabel}
                        sx={{ color: deck.classColor, borderColor: `${deck.classColor}88` }}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{deck.categoryName}</TableCell>
                    <TableCell align="right">
                      <Typography
                        color={deck.winRate >= 50 ? 'success.main' : 'error.main'}
                        fontWeight={700}
                      >
                        {formatWinRate(deck.winRate)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {deck.wins}-{deck.losses}
                    </TableCell>
                    <TableCell align="right">
                      <Chip
                        size="small"
                        label={confidenceLabel[deck.confidence]}
                        variant="outlined"
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
              {!filtered.length && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    沒有符合條件的牌組
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {selectedDeck && (
          <Box
            sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '360px 1fr' }, gap: 1.5 }}
          >
            <Card
              sx={{
                bgcolor: 'rgba(255,255,255,0.045)',
                border: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <CardContent>
                <Stack spacing={1.25}>
                  <Box>
                    <Typography variant="subtitle2" color="text.secondary">
                      已選牌組
                    </Typography>
                    <Typography variant="h6">{selectedDeck.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {selectedDeck.classLabel}，{selectedDeck.categoryName}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        區間勝率
                      </Typography>
                      <Typography variant="h6">{formatWinRate(selectedDeck.winRate)}</Typography>
                    </Box>
                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        總筆數
                      </Typography>
                      <Typography variant="h6">{matchCount}</Typography>
                    </Box>
                  </Box>
                  <Box>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
                      主要對手
                    </Typography>
                    <Stack gap={0.75}>
                      {matchupSummary.map((item) => {
                        const meta = getClassMeta(item.classId)
                        return (
                          <Stack key={item.classId} direction="row" justifyContent="space-between">
                            <Typography color={meta.color}>{meta.label}</Typography>
                            <Typography>
                              {formatWinRate(item.winRate)} ({item.wins}/{item.total})
                            </Typography>
                          </Stack>
                        )
                      })}
                      {!matchupSummary.length && (
                        <Typography variant="body2" color="text.secondary">
                          近期尚無已結算對戰
                        </Typography>
                      )}
                    </Stack>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <TableContainer component={Paper} sx={{ bgcolor: 'rgba(255,255,255,0.035)' }}>
              {loadingMatches && <LinearProgress />}
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>對手</TableCell>
                    <TableCell>先後</TableCell>
                    <TableCell>結果</TableCell>
                    <TableCell>模式</TableCell>
                    <TableCell>時間</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {matches.map((match) => {
                    const classMeta = getClassMeta(match.oppo_class)
                    const modeMeta = getModeMeta(match.mode)
                    return (
                      <TableRow key={match.id}>
                        <TableCell sx={{ color: classMeta.color }}>{classMeta.label}</TableCell>
                        <TableCell>
                          {match.play_order === 'first'
                            ? '先攻'
                            : match.play_order === 'second'
                              ? '後攻'
                              : '-'}
                        </TableCell>
                        <TableCell>
                          <Typography
                            color={
                              match.result == null
                                ? 'text.secondary'
                                : match.result
                                  ? 'success.main'
                                  : 'error.main'
                            }
                          >
                            {match.result == null ? '未結算' : match.result ? '勝' : '敗'}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            variant="outlined"
                            color={modeMeta.color ?? 'default'}
                            label={modeMeta.label}
                          />
                        </TableCell>
                        <TableCell>{new Date(match.playedAt).toLocaleString()}</TableCell>
                      </TableRow>
                    )
                  })}
                  {!matches.length && (
                    <TableRow>
                      <TableCell colSpan={5} align="center">
                        此區間沒有對戰紀錄
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}
      </Stack>
    </Box>
  )
}

export default DeckList
