/**
 * Matchup win rate heatmap - 對各職業的先攻／後攻勝率表。
 *
 * Replaces the bar chart that stood here through four revisions. The bars kept
 * failing for the same reason: seven opponents times two play orders is a grid,
 * and a grid drawn as bars forces the eye to travel a length to recover a
 * number it could have read directly. A table lets the colour do the scanning
 * and the digits do the reading, which is how every competitive stats site ends
 * up presenting matchup spreads.
 *
 * The colour scale is diverging around 50% with a neutral dead band, because
 * 50% is the only meaningful midpoint here and 49% is not a losing matchup.
 * Fills stay translucent over the dark surface so the figures keep their own
 * contrast rather than fighting the cell behind them.
 *
 * Sample size deliberately does NOT get a heatmap. It is a qualifier on every
 * other number in the row, so it reads one step quieter - and a thin sample
 * mutes that row's fills instead of shouting, so 4/6 never looks as solid as
 * 120/180.
 */
import React, { useMemo } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import ArrowDropUpIcon from '@mui/icons-material/ArrowDropUp'

import EmptyState from '@renderer/components/Common/EmptyState'
import { useFlipRows } from '@renderer/components/Common/useFlipRows'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import { classesMap } from '@renderer/map/classMap'
import {
  LOSS_RGB,
  RATE_DEAD_BAND as DEAD_BAND,
  rateColor,
  SWING_THRESHOLD,
  WIN_RGB,
  buildMatchupRows,
  sortMatchupRows,
  useMatchupSort,
  type MatchupRow as Row,
  type MatchupSortKey as SortKey,
  type Rate
} from '../matchupRows'

import type { RankedWinrateByOpponent } from '@shared/types'

type MatchupHeatmapProps = {
  data: RankedWinrateByOpponent | null | undefined
}

const NEUTRAL_FILL = 'rgba(255,255,255,0.045)'
/** Where the colour ramp tops out. Beyond 15 points a matchup is simply lopsided. */
const FULL_SCALE = 15
const MIN_ALPHA = 0.1
const MAX_ALPHA = 0.4

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

/** grid template shared by the header and every row, so the columns cannot drift. */
const COLUMNS = {
  gridTemplateColumns: 'minmax(96px, 1.6fr) 76px 76px 68px 76px minmax(92px, 108px)'
}
/** Mobile / narrow: games folds away, the three rates stay. */
const COLUMNS_NARROW = {
  gridTemplateColumns: 'minmax(84px, 1.4fr) 1fr 1fr 0 1fr 0'
}

const fmtRate = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`)

/** Diverging fill: grey inside the dead band, then red or green by distance. */
function cellFill(rate: number | null): string {
  if (rate === null) return 'transparent'
  const delta = rate - 50
  if (Math.abs(delta) < DEAD_BAND) return NEUTRAL_FILL

  const strength = Math.min(1, (Math.abs(delta) - DEAD_BAND) / (FULL_SCALE - DEAD_BAND))
  const alpha = MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * strength
  return `rgba(${delta > 0 ? WIN_RGB : LOSS_RGB}, ${alpha.toFixed(3)})`
}

const MatchupHeatmap: React.FC<MatchupHeatmapProps> = ({ data: stats }) => {
  // 排序狀態與長條圖共用：換一種畫法不該把順序換掉。
  const { sortKey, descending, setSortKey, setDescending } = useMatchupSort()

  const allRows = useMemo<Row[]>(() => buildMatchupRows(stats), [stats])

  const rows = useMemo(
    () => sortMatchupRows(allRows, sortKey, descending),
    [allRows, descending, sortKey]
  )

  // 換條件、換排序時讓每一列滑到新位置，和長條圖用的是同一段過渡
  const registerRow = useFlipRows(rows.map((row) => row.key))

  const busiest = useMemo(() => Math.max(1, ...allRows.map((row) => row.games)), [allRows])

  if (!stats || !stats.byOpponent || stats.overall.all.total === 0) {
    // 和對局列表共用同一塊空狀態：兩頁問的是同一個問題（是不是篩過頭了），
    // 答案不該長得不一樣。
    return (
      <EmptyState description="這組條件下沒有任何對戰紀錄。放寬場數或時間區間，或清掉幾條進階條件再看看。" />
    )
  }

  const overall = stats.overall
  const advantage =
    overall.first.total > 0 && overall.second.total > 0
      ? overall.first.winRate - overall.second.winRate
      : null

  const dateRange =
    stats.start && stats.end
      ? `${new Date(stats.start).toLocaleDateString()} – ${new Date(stats.end).toLocaleDateString()}`
      : stats.limit
        ? null
        : '全部期間'

  /**
   * The cap is applied to the matches that already passed class, mode, deck and
   * CR - so with a narrow class it often never binds, and the toolbar's 場數
   * buttons then look broken because 50, 100 and 200 all return the same rows.
   * Say which of the two actually decided the scope.
   */
  const capBound = stats.limit !== null && stats.overall.all.total >= stats.limit
  const scope =
    stats.limit === null
      ? null
      : capBound
        ? `最近 ${stats.limit} 場`
        : `共 ${stats.overall.all.total} 場（未滿 ${stats.limit}）`
  const period = [scope, dateRange].filter(Boolean).join(' · ')

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setDescending(!descending)
      return
    }
    setSortKey(key)
    // Rates and volumes are both "bigger is more interesting" on first click.
    setDescending(true)
  }

  const metric = (
    label: string,
    value: string,
    tone?: 'win' | 'loss',
    unit?: string
  ): React.JSX.Element => (
    <Box>
      <Typography variant="caption" sx={{ opacity: 0.55, display: 'block', lineHeight: 1.6 }}>
        {label}
      </Typography>
      <Box display="flex" alignItems="baseline" gap={0.5}>
        <Typography
          sx={{
            ...NUMERIC,
            fontSize: 20,
            lineHeight: 1.3,
            color:
              tone === 'win'
                ? 'success.light'
                : tone === 'loss'
                  ? 'error.light'
                  : 'rgba(255,255,255,0.92)'
          }}
        >
          {value}
        </Typography>
        {/* 單位落在數字旁邊而不是併進數字裡：這樣它讀起來是註解，
            也不會跟著等寬數字一起被排版。 */}
        {unit && (
          <Typography variant="caption" sx={{ opacity: 0.5 }}>
            {unit}
          </Typography>
        )}
      </Box>
    </Box>
  )

  const rateTone = (value: number | null): 'win' | 'loss' | undefined => {
    if (value === null) return undefined
    if (value >= 50 + DEAD_BAND) return 'win'
    if (value <= 50 - DEAD_BAND) return 'loss'
    return undefined
  }

  const headerCell = (label: string, key: SortKey, align: 'left' | 'right'): React.JSX.Element => {
    const active = sortKey === key
    return (
      <Box
        onClick={() => toggleSort(key)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
          gap: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
          color: active ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
          transition: 'color .15s',
          '&:hover': { color: 'rgba(255,255,255,0.9)' }
        }}
      >
        <Typography variant="caption" sx={{ letterSpacing: '.02em' }}>
          {label}
        </Typography>
        {/* The indicator only exists on the sorted column; a full set of grey
            chevrons on every header is noise pretending to be affordance. */}
        {active &&
          (descending ? (
            <ArrowDropDownIcon sx={{ fontSize: 16 }} />
          ) : (
            <ArrowDropUpIcon sx={{ fontSize: 16 }} />
          ))}
      </Box>
    )
  }

  const rateCell = (stat: Rate, label: string, row: Row, strong = false): React.JSX.Element => {
    const losses = Math.max(0, stat.total - stat.wins)
    return (
      <Tooltip
        placement="top"
        slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
        title={
          stat.total === 0 ? (
            `${label}：這個區間沒有紀錄`
          ) : (
            // 標題一行、勝率一個大的、戰績一行帶過：原本五行「A：B」要一行行
            // 讀完才拼得出全貌，而這裡真正想知道的只有勝率和它撐在多少場上。
            <Box sx={{ minWidth: 150 }}>
              <Box
                display="flex"
                alignItems="center"
                gap={1}
                sx={{ pb: 0.75, mb: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '2px',
                    bgcolor: row.color,
                    flexShrink: 0
                  }}
                />
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {row.label}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {label}
                </Typography>
              </Box>
              <Box display="flex" alignItems="baseline" gap={1}>
                <Typography
                  sx={{
                    ...NUMERIC,
                    fontSize: 20,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    color: rateColor(stat.rate) ?? 'text.primary'
                  }}
                >
                  {stat.winRate.toFixed(1)}%
                </Typography>
                <Typography variant="caption" sx={{ ...NUMERIC, color: 'text.secondary' }}>
                  {stat.wins}勝 {losses}敗 · {stat.total} 場
                </Typography>
              </Box>
            </Box>
          )
        }
      >
        <Box
          sx={{
            // 跟著列一起長高：高度多出來的時候，色塊變大比留白有用 -
            // 這張表是靠顏色掃的，色塊越大越好掃。
            height: '100%',
            minHeight: 26,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            px: 0.75,
            borderRadius: 1,
            bgcolor: cellFill(stat.rate)
          }}
        >
          <Typography
            sx={{
              ...NUMERIC,
              fontSize: strong ? 14 : 13,
              color: stat.rate === null ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.95)'
            }}
          >
            {fmtRate(stat.rate)}
          </Typography>
        </Box>
      </Tooltip>
    )
  }

  return (
    // 撐滿分析器給的高度：標題、摘要與表頭各佔固定的一段，剩下的全部給資料列
    // 平分。空間多的時候列變高、色塊變大，而不是在畫面下半留一塊空白。
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* ---------- 標題與 compact summary ---------- */}
      <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={2} mb={1.5}>
        <Box display="flex" alignItems="baseline" gap={1} flexWrap="wrap">
          <Typography variant="h6" sx={{ color: classesMap[stats.myClass]?.color }}>
            {classesMap[stats.myClass]?.label ?? stats.myClass}
          </Typography>
          <Typography variant="h6" sx={{ color: 'rgba(255,255,255,0.9)' }}>
            對各職業勝率
          </Typography>
          {stats.myDecks && stats.myDecks.length > 0 && (
            <Typography variant="body2" sx={{ opacity: 0.6 }}>
              牌組：{stats.myDecks.map((d) => d.name).join('、')}
            </Typography>
          )}
          {typeof stats.crMin === 'number' && typeof stats.crMax === 'number' && (
            <Typography variant="body2" sx={{ ...NUMERIC, opacity: 0.6 }}>
              CR {stats.crMin}–{stats.crMax}
            </Typography>
          )}
        </Box>
        <Typography variant="caption" sx={{ opacity: 0.6, whiteSpace: 'nowrap' }}>
          {period}
        </Typography>
      </Box>

      <Box
        display="flex"
        alignItems="flex-start"
        gap={{ xs: 2.5, md: 4 }}
        flexWrap="wrap"
        sx={{ pb: 2, borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        {metric('總勝率', fmtRate(overall.all.total > 0 ? overall.all.winRate : null))}
        {metric(
          '先攻',
          fmtRate(overall.first.total > 0 ? overall.first.winRate : null),
          rateTone(overall.first.total > 0 ? overall.first.winRate : null)
        )}
        {metric(
          '後攻',
          fmtRate(overall.second.total > 0 ? overall.second.winRate : null),
          rateTone(overall.second.total > 0 ? overall.second.winRate : null)
        )}
        {metric(
          '先手優勢',
          advantage === null
            ? '—'
            : `${advantage >= 0 ? '+' : '−'}${Math.abs(advantage).toFixed(1)}`,
          undefined,
          advantage === null ? undefined : '%'
        )}
        {metric('對局數', overall.all.total.toLocaleString())}
      </Box>

      {/* ---------- 表頭。範圍由上方工具列的場數與進階篩選決定，
           這張表不再自己開一個「最低場數」- 兩個都叫場數的控制項擺在同一頁，
           讀起來就是在打架。樣本薄的那幾列改用淡化與標籤說明。 ---------- */}
      <Box
        sx={{
          display: 'grid',
          ...COLUMNS,
          '@media (max-width: 720px)': COLUMNS_NARROW,
          alignItems: 'center',
          gap: 1,
          px: 1,
          pt: 2,
          pb: 0.75,
          borderBottom: '1px solid rgba(255,255,255,0.06)'
        }}
      >
        {headerCell('對手職業', 'class', 'left')}
        {headerCell('先攻', 'first', 'right')}
        {headerCell('後攻', 'second', 'right')}
        <Typography
          variant="caption"
          sx={{
            textAlign: 'right',
            color: 'rgba(255,255,255,0.5)',
            '@media (max-width: 720px)': { display: 'none' }
          }}
        >
          先後差
        </Typography>
        {headerCell('總勝率', 'overall', 'right')}
        <Box sx={{ '@media (max-width: 720px)': { display: 'none' } }}>
          {headerCell('對局數', 'games', 'right')}
        </Box>
      </Box>

      {/* ---------- 資料列 ---------- */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', pt: 0.5 }}>
        {rows.map((row) => {
          const bigSwing = row.swing !== null && Math.abs(row.swing) >= SWING_THRESHOLD

          return (
            <Box
              key={row.key}
              ref={registerRow(row.key)}
              sx={{
                display: 'grid',
                ...COLUMNS,
                '@media (max-width: 720px)': COLUMNS_NARROW,
                // 每一列平分剩下的高度；擠不下時退回這個下限，再由外層捲動
                flex: '1 1 0',
                minHeight: 34,
                alignItems: 'stretch',
                gap: 1,
                px: 1,
                py: 0.5,
                borderRadius: 1,
                transition: 'background-color .12s',
                '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' }
              }}
            >
              <Box display="flex" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '2px',
                    bgcolor: row.color,
                    opacity: row.games === 0 ? 0.3 : 1,
                    flexShrink: 0
                  }}
                />
                <Typography
                  variant="body2"
                  noWrap
                  sx={{
                    color: row.games === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)'
                  }}
                >
                  {row.label}
                </Typography>
              </Box>

              {rateCell(row.first, '先攻', row)}
              {rateCell(row.second, '後攻', row)}

              {/* 先後差只在幅度夠大時才出現，其餘留白 - 每一列都掛徽章就等於沒有徽章。 */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  '@media (max-width: 720px)': { display: 'none' }
                }}
              >
                {bigSwing && row.swing !== null && (
                  <Tooltip
                    title={`先攻與後攻相差 ${Math.abs(row.swing).toFixed(1)}%，${
                      row.swing > 0 ? '先攻明顯有利' : '後攻明顯有利'
                    }`}
                  >
                    <Typography
                      sx={{
                        ...NUMERIC,
                        fontSize: 11,
                        px: 0.5,
                        borderRadius: 0.75,
                        color: 'rgba(255,255,255,0.62)',
                        bgcolor: 'rgba(255,255,255,0.05)'
                      }}
                    >
                      {row.swing > 0 ? '先 +' : '後 +'}
                      {Math.abs(row.swing).toFixed(1)}
                    </Typography>
                  </Tooltip>
                )}
              </Box>

              {rateCell(row.all, '總計', row, true)}

              {/* 對局數不上熱度色：它是其他數字的限定條件，該低一階。 */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 0.75,
                  '@media (max-width: 720px)': { display: 'none' }
                }}
              >
                <Box
                  sx={{
                    width: 26,
                    height: 3,
                    borderRadius: 999,
                    bgcolor: 'rgba(255,255,255,0.07)',
                    flexShrink: 0,
                    overflow: 'hidden'
                  }}
                >
                  <Box
                    sx={{
                      width: `${(row.games / busiest) * 100}%`,
                      height: '100%',
                      bgcolor: 'rgba(255,255,255,0.3)'
                    }}
                  />
                </Box>
                <Typography
                  sx={{
                    ...NUMERIC,
                    fontSize: 12,
                    color: 'rgba(255,255,255,0.5)',
                    minWidth: 26,
                    textAlign: 'right'
                  }}
                >
                  {row.games.toLocaleString()}
                </Typography>
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export default MatchupHeatmap
