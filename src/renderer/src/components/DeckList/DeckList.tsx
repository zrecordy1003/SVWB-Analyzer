import {
  Box,
  Card,
  CardContent,
  Chip,
  Grid,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import { classes, classesMap } from '@renderer/map/classMap'
import { useEffect, useMemo, useState } from 'react'
import type { DeckCategory } from '@prisma/client'

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
}

const DeckList = (): React.JSX.Element => {
  const [categories, setCategories] = useState<DeckCategory[]>([])
  const [decks, setDecks] = useState<DeckLite[]>([])
  const [stats, setStats] = useState<DeckStat[]>([])
  const [filterClass, setFilterClass] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null)
  const [matches, setMatches] = useState<MatchRow[]>([])
  const [matchCount, setMatchCount] = useState(0)
  const [loadingMatches, setLoadingMatches] = useState(false)

  const fetchInitial = async () => {
    setLoading(true)
    try {
      const [catRes, deckRes, statsRes] = (await Promise.all([
        window.electron.ipcRenderer.invoke('deckCategories:all'),
        window.electron.ipcRenderer.invoke('decks:all'),
        window.electron.ipcRenderer.invoke('decks:stats', { rangeKey: 'all' })
      ])) as [any, any, any]

      if (!catRes?.ok) throw new Error(catRes?.error)
      if (!deckRes?.ok) throw new Error(deckRes?.error)
      if (!statsRes?.ok) throw new Error(statsRes?.error)

      const cats: DeckCategory[] = catRes.data.map((c: DeckCategory) => ({
        id: c.id,
        name: c.name
      }))
      const ds: DeckLite[] = deckRes.data.map(
        (d: { id: number; name: string; class: string; categoryId: string | null; isDefault: boolean }) => ({
          id: d.id,
          name: d.name,
          classId: d.class,
          categoryId: d.categoryId,
          isDefault: !!d.isDefault
        })
      )

      setCategories(cats)
      setDecks(ds)
      setStats(statsRes.data ?? [])
    } catch (err: any) {
      setLoadError(err?.message ?? 'Failed to load deck data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    fetchInitial().finally(() => {
      if (!mounted) return
    })
    return () => {
      mounted = false
    }
  }, [])

  const refreshStats = async () => {
    try {
      const res = (await window.electron.ipcRenderer.invoke('decks:stats', { rangeKey: 'all' })) as any
      if (!res?.ok) throw new Error(res?.error)
      setStats(res.data ?? [])
    } catch (e) {
      console.error(e)
    }
  }

  const fetchMatches = async (deckId: number) => {
    setLoadingMatches(true)
    try {
      const payload = { myDeckIds: [deckId], rangeKey: 'all', pageIndex: 0, pageSize: 10 }
      const [rows, count] = (await Promise.all([
        window.electron.ipcRenderer.invoke('matches:getPage', payload),
        window.electron.ipcRenderer.invoke('matches:count', payload)
      ])) as [MatchRow[], number]
      setMatches(rows ?? [])
      setMatchCount(count ?? 0)
    } catch (e) {
      console.error(e)
      setMatches([])
      setMatchCount(0)
    } finally {
      setLoadingMatches(false)
    }
  }

  // live update
  useEffect(() => {
    const unsub = window.electron?.ipcRenderer.on('matches:needRefetch', () => {
      refreshStats()
      if (selectedDeckId) fetchMatches(selectedDeckId)
    })
    return () => {
      unsub && unsub()
    }
  }, [selectedDeckId])

  const deckMap = useMemo(() => {
    const m = new Map<number, DeckLite>()
    decks.forEach((d) => m.set(d.id, d))
    return m
  }, [decks])

  const enriched = useMemo(() => {
    const data = stats
      .map((s) => {
        const deck = deckMap.get(s.deckId)
        if (!deck) return null
        const catName = categories.find((c) => c.id === deck.categoryId)?.name ?? '未分類'
        return {
          deckId: s.deckId,
          name: deck.name,
          classId: deck.classId,
          categoryName: catName,
          isDefault: !!deck.isDefault,
          total: s.total,
          wins: s.wins,
          winRate: s.winRate
        }
      })
      .filter(Boolean) as Array<{
      deckId: number
      name: string
      classId: string
      categoryName: string
      isDefault: boolean
      total: number
      wins: number
      winRate: number
    }>

    const missing = decks
      .filter((d) => !stats.some((s) => s.deckId === d.id))
      .map((d) => ({
        deckId: d.id,
        name: d.name,
        classId: d.classId,
        categoryName: categories.find((c) => c.id === d.categoryId)?.name ?? '未分類',
        isDefault: !!d.isDefault,
        total: 0,
        wins: 0,
        winRate: 0
      }))

    const combined = [...data, ...missing]
    combined.sort((a, b) => {
      if (b.total === a.total) return b.winRate - a.winRate
      return b.total - a.total
    })
    return combined
  }, [stats, deckMap, categories, decks])

  const filtered = useMemo(
    () => (filterClass ? enriched.filter((d) => d.classId === filterClass) : enriched),
    [enriched, filterClass]
  )

  const best = filtered[0]
  const totalMatches = filtered.reduce((sum, d) => sum + d.total, 0)
  const avgWin =
    filtered.length && totalMatches
      ? +(filtered.reduce((sum, d) => sum + d.winRate * d.total, 0) / totalMatches).toFixed(2)
      : 0

  return (
    <Box sx={{ p: 2 }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: { xs: 'flex-start', md: 'center' },
          justifyContent: 'space-between',
          gap: 1.5,
          mb: 2
        }}
      >
        <Box>
          <Typography variant="h6">牌組勝率看板</Typography>
          <Typography variant="body2" color="text.secondary">
            依我方牌組統計，勝率僅計入有結果的對戰
          </Typography>
        </Box>
        <ToggleButtonGroup
          size="small"
          value={filterClass}
          exclusive
          onChange={(_, v) => setFilterClass(v)}
        >
          <ToggleButton value={null} sx={{ px: 1.5 }}>
            全部
          </ToggleButton>
          {classes.map((c) => (
            <ToggleButton key={c.id} value={c.id} sx={{ px: 1.5 }}>
              <Typography color={c.color}>{c.label}</Typography>
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
          gap: 1.5,
          mb: 2
        }}
      >
        <Card sx={{ p: 2, background: 'rgba(255,255,255,0.04)', border: '1px solid #222' }}>
          <Typography variant="body2" color="text.secondary">
            總場數
          </Typography>
          <Typography variant="h5">{totalMatches}</Typography>
        </Card>
        <Card sx={{ p: 2, background: 'rgba(255,255,255,0.04)', border: '1px solid #222' }}>
          <Typography variant="body2" color="text.secondary">
            平均勝率
          </Typography>
          <Typography variant="h5">{avgWin.toFixed(2)}%</Typography>
        </Card>
        <Card sx={{ p: 2, background: 'rgba(255,255,255,0.08)', border: '1px solid #333' }}>
          <Typography variant="body2" color="text.secondary">
            最亮眼
          </Typography>
          {best ? (
            <Typography variant="h6">
              {best.name} · {best.winRate.toFixed(1)}%
            </Typography>
          ) : (
            <Typography variant="body2">暫無資料</Typography>
          )}
        </Card>
      </Box>

      {loadError && (
        <Typography color="error" sx={{ mb: 2 }}>
          {loadError}
        </Typography>
      )}
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      <Grid container spacing={2}>
        {filtered.map((deck) => {
          const cls = classesMap[deck.classId]
          const progress = Math.min(100, Math.max(0, deck.winRate))
          const good = deck.winRate >= 50
          const noGames = deck.total === 0
          const barColor = noGames ? 'rgba(255,255,255,0.25)' : good ? '#4caf50' : '#e57373'
          const borderColor = noGames ? 'rgba(255,255,255,0.08)' : good ? '#2e7d32' : '#8e2a2a'
          const active = selectedDeckId === deck.deckId
          return (
            <Grid item xs={12} sm={6} md={4} lg={3} key={deck.deckId}>
              <Card
                sx={{
                  height: '100%',
                  background:
                    'linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.07))',
                  border: active ? '2px solid #90caf9' : `1px solid ${borderColor}`,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                  cursor: 'pointer',
                  transform: active ? 'translateY(-2px)' : 'none',
                  transition: 'transform 0.15s ease, border 0.15s ease',
                  '&:hover': { transform: 'translateY(-2px)', borderColor: '#90caf9' }
                }}
                onClick={() => {
                  setSelectedDeckId(deck.deckId)
                  fetchMatches(deck.deckId)
                }}
              >
                <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between">
                    <Typography variant="subtitle1" noWrap>
                      {deck.name}
                    </Typography>
                    <Chip
                      size="small"
                      label={cls?.label ?? deck.classId}
                      sx={{ bgcolor: `${cls?.color ?? '#888'}33`, color: cls?.color ?? '#fff' }}
                    />
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip
                      size="small"
                      label={deck.categoryName || '未分類'}
                      variant="outlined"
                      sx={{ borderColor: 'divider' }}
                    />
                    {deck.isDefault && <Chip size="small" color="success" label="預設" />}
                    {noGames && <Chip size="small" variant="outlined" label="暫無數據" />}
                  </Stack>
                  {deck.total ? (
                    <Box>
                      <Typography
                        variant="h4"
                        sx={{ display: 'flex', alignItems: 'baseline', gap: 1, color: barColor }}
                      >
                        {deck.winRate.toFixed(1)}%
                        <Typography variant="body2" color="text.secondary">
                          {deck.wins}/{deck.total} 勝
                        </Typography>
                      </Typography>
                      <Tooltip title="勝率">
                        <LinearProgress
                          variant="determinate"
                          value={progress}
                          sx={{
                            mt: 1,
                            height: 10,
                            borderRadius: 2,
                            bgcolor: 'rgba(255,255,255,0.08)',
                            '& .MuiLinearProgress-bar': {
                              borderRadius: 2,
                              backgroundColor: barColor
                            }
                          }}
                        />
                      </Tooltip>
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      尚無對戰數據
                    </Typography>
                  )}
                </CardContent>
              </Card>
            </Grid>
          )
        })}
      </Grid>

      {selectedDeckId && (
        <Box mt={3}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            對戰紀錄 · {deckMap.get(selectedDeckId)?.name ?? '---'}（{matchCount} 場，僅顯示最近 10 筆）
          </Typography>
          {loadingMatches && <LinearProgress sx={{ mb: 1 }} />}
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>對手職業</TableCell>
                <TableCell>結果</TableCell>
                <TableCell>模式</TableCell>
                <TableCell>時間</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {matches.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{classesMap[m.oppo_class]?.label ?? m.oppo_class}</TableCell>
                  <TableCell sx={{ color: m.result == null ? 'gray' : m.result ? '#4caf50' : '#e57373' }}>
                    {m.result === null ? '進行中' : m.result ? '勝' : '敗'}
                  </TableCell>
                  <TableCell>{m.mode ?? '—'}</TableCell>
                  <TableCell>{new Date(m.playedAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {!matches.length && (
                <TableRow>
                  <TableCell colSpan={4} align="center">
                    暫無對戰紀錄
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      )}
    </Box>
  )
}

export default DeckList
