/**
 * Matchup win rate bars - 對各職業的先攻／後攻勝率並排長條圖。
 *
 * 和熱圖看同一份資料，回答的問題卻不同：熱圖適合把七個職業乘兩種先後攻當成
 * 一張網格來讀數字，長條圖適合一眼看出「差距有多大」。長度比顏色更容易比較，
 * 所以想知道哪個對局特別吃先攻時，這張圖幾乎不用讀數字。
 *
 * 兩條長條刻意分開而不是堆疊：先攻與後攻是兩個各自獨立的勝率，不是一個整體
 * 的兩個部分，堆起來的長度不代表任何東西。
 *
 * 尺規固定在 0% – 100% 而不是跟著資料縮放：讓軸自己貼合資料會把 48% 和 52%
 * 畫成一面倒。50% 那條線是這張圖唯一重要的錨點，所以它一直在。
 */
import React, { useMemo } from 'react'
import { Box, Button, MenuItem, Select, Tooltip, Typography } from '@mui/material'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'

import ClassIcon from '@renderer/components/Common/ClassIcon'
import EmptyState from '@renderer/components/Common/EmptyState'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import { useFlipRows } from '@renderer/components/Common/useFlipRows'
import {
  DROPDOWN_ITEM_SX,
  DROPDOWN_PAPER_SX
} from '@renderer/components/Common/filters/dropdownSurface'
import {
  DELTA_LABEL_THRESHOLD,
  MATCHUP_SORT_LABELS,
  VERDICT_LABELS,
  buildMatchupRows,
  rateColor,
  sortMatchupRows,
  useMatchupSort,
  verdictOf,
  type MatchupRow,
  type MatchupSortKey,
  type Rate
} from '../matchupRows'

import type { RankedWinrateByOpponent } from '@shared/types'

/**
 * 尺規是完整的 0% – 100%，長度因此就是勝率本身，不需要換算。
 *
 * 刻度只標 0 / 30 / 50 / 70 / 100：30 與 70 是「這場對局明顯有一邊比較好打」
 * 的兩條界線，50 是均勢。中間再多的刻度只會讓尺規比長條還吵。
 */
const DOMAIN_MIN = 0
const DOMAIN_MAX = 100
const DOMAIN_SPAN = DOMAIN_MAX - DOMAIN_MIN
const TICKS = [0, 30, 50, 70, 100]

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

const SORT_OPTIONS: MatchupSortKey[] = ['overall', 'first', 'second', 'swing', 'games', 'class']

const ratioOf = (rate: number): number =>
  Math.min(1, Math.max(0, (rate - DOMAIN_MIN) / DOMAIN_SPAN))

const fmtRate = (rate: number | null): string => (rate === null ? '—' : `${rate.toFixed(1)}%`)

/** 長條那欄的三段：先／後攻標籤、軌道、勝率。 */
const SIDE_LABEL_WIDTH = 34
const VALUE_WIDTH = 52
const COLUMN_GAP = 8

/** 一個 0–1 的位置換成軌道上的 x；軌道兩側各有一欄固定寬度要先扣掉。 */
const plotX = (t: number): string =>
  `calc(${SIDE_LABEL_WIDTH + COLUMN_GAP}px + (100% - ${
    SIDE_LABEL_WIDTH + VALUE_WIDTH + COLUMN_GAP * 2
  }px) * ${t})`

/** 桌機是「職業 | 長條」兩欄，窄畫面收成一欄，不做橫向捲動。 */
const ROW_GRID = {
  display: 'grid',
  gridTemplateColumns: 'minmax(112px, 150px) 1fr',
  columnGap: 1.5,
  alignItems: 'center',
  '@media (max-width: 720px)': { gridTemplateColumns: '1fr', rowGap: 0.75 }
} as const

/**
 * 一條長條連同它的標籤與勝率。
 *
 * 先／後攻的字在軌道左邊、數字在右邊：三段各自對齊成一直行，掃的時候不必在
 * 長條之間找數字。字一直在，所以先後攻不是只靠顏色分辨。
 */
function SideBar({
  side,
  stat,
  color
}: {
  side: string
  stat: Rate
  color: string
}): React.JSX.Element {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: `${SIDE_LABEL_WIDTH}px 1fr ${VALUE_WIDTH}px`,
        columnGap: `${COLUMN_GAP}px`,
        alignItems: 'stretch',
        flex: '1 1 0',
        minHeight: 0
      }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary', alignSelf: 'center' }}>
        {side}
      </Typography>

      {/* 軌道高度跟著列一起長，但有上限 - 太厚就變成進度條了。 */}
      <Box
        sx={{
          position: 'relative',
          alignSelf: 'center',
          width: '100%',
          height: '100%',
          minHeight: 10,
          maxHeight: 18,
          borderRadius: '2px',
          bgcolor: 'rgba(255,255,255,0.05)'
        }}
      >
        {/* 50% 是這張圖唯一重要的錨點：只看長度分不出優勢還是劣勢。 */}
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            top: -1,
            bottom: -1,
            left: `${(ratioOf(50) * 100).toFixed(2)}%`,
            borderLeft: '1px dashed',
            borderColor: 'rgba(255,255,255,0.3)'
          }}
        />
        {stat.rate !== null && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: `max(2px, ${(ratioOf(stat.rate) * 100).toFixed(2)}%)`,
              borderRadius: '2px',
              bgcolor: color,
              opacity: 0.85,
              transition: 'width .3s ease',
              '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
            }}
          />
        )}
      </Box>

      {/* 數字跟著離 50% 的距離上色，分三階 - 掃到一半就知道這格是贏面還是
          輸面，不必再回頭比對長條落在虛線的哪一邊。 */}
      <Typography
        variant="caption"
        sx={{
          ...NUMERIC,
          textAlign: 'right',
          alignSelf: 'center',
          fontWeight: 700,
          color: rateColor(stat.rate) ?? 'text.primary'
        }}
      >
        {fmtRate(stat.rate)}
      </Typography>
    </Box>
  )
}

function MatchupBarRow({
  row,
  onClick,
  rowRef
}: {
  row: MatchupRow
  onClick?: (row: MatchupRow) => void
  /** 排序變動時由 FLIP 量位置用 */
  rowRef?: (node: unknown) => void
}): React.JSX.Element {
  const swing = row.swing
  const showDelta = swing !== null && Math.abs(swing) >= DELTA_LABEL_THRESHOLD
  const verdict = verdictOf(row.overall)

  /**
   * Tooltip 是這一列的完整版：三種情況（先攻／後攻／整體）各一行，勝率、
   * 戰績、場數各自對齊成一直行。原本那三行純文字要一個字一個字讀完才知道
   * 哪個數字是哪個，排成表格以後可以直接往下掃。
   */
  const tooltipLine = (
    label: string,
    stat: Rate,
    tone?: string,
    strong = false
  ): React.JSX.Element => (
    <>
      <Box display="flex" alignItems="center" gap={0.75} sx={{ minWidth: 0 }}>
        {tone && (
          <Box sx={{ width: 6, height: 6, borderRadius: '1px', bgcolor: tone, flexShrink: 0 }} />
        )}
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', fontWeight: strong ? 700 : 400 }}
        >
          {label}
        </Typography>
      </Box>
      <Typography
        variant="body2"
        sx={{
          ...NUMERIC,
          textAlign: 'right',
          fontWeight: 700,
          color: rateColor(stat.rate) ?? 'text.primary'
        }}
      >
        {fmtRate(stat.rate)}
      </Typography>
      <Typography
        variant="caption"
        sx={{ ...NUMERIC, textAlign: 'right', color: 'text.secondary' }}
      >
        {stat.total === 0 ? '—' : `${stat.wins}勝 ${stat.losses}敗`}
      </Typography>
      <Typography variant="caption" sx={{ ...NUMERIC, textAlign: 'right', color: 'text.disabled' }}>
        {stat.total === 0 ? '' : `${stat.total} 場`}
      </Typography>
    </>
  )

  const tooltip = (
    <Box sx={{ minWidth: 236 }}>
      <Box
        display="flex"
        alignItems="center"
        gap={1}
        sx={{ pb: 0.75, mb: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        {/* 徽章帶著 `tone`：取不到官方圖時退回同一顆色塊，長相與從前相同。 */}
        <ClassIcon id={row.key} size={18} tone={row.color} />
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          {row.label}
        </Typography>
        <Box flex={1} />
        {verdict && (
          <Typography
            variant="caption"
            sx={{
              px: 0.75,
              py: 0.125,
              borderRadius: 0.75,
              bgcolor: 'rgba(255,255,255,0.06)',
              color: rateColor(row.overall) ?? 'text.secondary'
            }}
          >
            {VERDICT_LABELS[verdict]}
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto auto auto auto',
          columnGap: 1.25,
          rowGap: 0.5,
          alignItems: 'center'
        }}
      >
        {tooltipLine('先攻', row.first, 'primary.main')}
        {tooltipLine('後攻', row.second, 'secondary.main')}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto auto auto auto',
          columnGap: 1.25,
          alignItems: 'center',
          pt: 0.75,
          mt: 0.75,
          borderTop: '1px solid',
          borderColor: 'divider'
        }}
      >
        {tooltipLine('整體', row.all, undefined, true)}
      </Box>

      {showDelta && (
        <Typography
          variant="caption"
          component="div"
          sx={{
            ...NUMERIC,
            mt: 0.75,
            color: swing > 0 ? 'primary.main' : 'secondary.main'
          }}
        >
          {swing > 0 ? '先攻優勢' : '後攻優勢'} +{Math.abs(swing).toFixed(1)}%
        </Typography>
      )}
    </Box>
  )

  return (
    <Tooltip
      title={tooltip}
      placement="top"
      followCursor
      slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
    >
      <Box
        ref={rowRef}
        onClick={onClick ? () => onClick(row) : undefined}
        sx={{
          ...ROW_GRID,
          flex: '1 1 0',
          minHeight: 0,
          px: 1,
          py: 0.75,
          borderRadius: 1,
          cursor: onClick ? 'pointer' : 'default',
          transition: 'background-color .12s',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' }
        }}
      >
        {/* 職業，先後差接在它底下 - 那是這一列的結論，不是第三個並排的數字。
            徽章擺在兩行的外面而不是跟在職業名那一行：有先後差時這一格是兩行高，
            徽章跟著第一行就會偏上，領著整塊反而是對著兩行的中線。 */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          {/* 和熱圖那一列同一顆徽章、同一個 `dim`：兩種畫法看同一份資料，
              職業那一欄不該長得不一樣。沒有場次時一起壓暗。 */}
          <ClassIcon id={row.key} tone={row.color} dim={row.games === 0} />
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="body2"
              noWrap
              sx={{ color: row.games === 0 ? 'text.disabled' : 'rgba(255,255,255,0.9)' }}
            >
              {row.label}
            </Typography>
            {showDelta && (
              <Typography
                variant="caption"
                component="div"
                // 用那一邊自己的顏色：這行講的是哪一邊有利，和下面兩條長條
                // 是同一組編碼，不必再回頭對照哪條是先攻
                sx={{
                  ...NUMERIC,
                  color: swing > 0 ? 'primary.main' : 'secondary.main'
                }}
              >
                {swing > 0 ? '先攻優勢' : '後攻優勢'} +{Math.abs(swing).toFixed(1)}%
              </Typography>
            )}
          </Box>
        </Box>

        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            alignSelf: 'stretch',
            justifyContent: 'center',
            minHeight: 0
          }}
        >
          <SideBar side="先攻" stat={row.first} color="primary.main" />
          <SideBar side="後攻" stat={row.second} color="secondary.main" />
        </Box>
      </Box>
    </Tooltip>
  )
}

type Props = {
  data: RankedWinrateByOpponent | null | undefined
  /** 未來要接 matchup 詳情、對戰紀錄時從這裡進去。 */
  onMatchupClick?: (row: MatchupRow) => void
}

const MatchupBars: React.FC<Props> = ({ data, onMatchupClick }) => {
  const { sortKey, descending, setSortKey, setDescending } = useMatchupSort()

  const allRows = useMemo(() => buildMatchupRows(data), [data])
  const rows = useMemo(
    () => sortMatchupRows(allRows, sortKey, descending),
    [allRows, sortKey, descending]
  )

  // 換條件、換排序時讓每一列滑到新位置，眼睛才跟得住自己在看的那一列
  const registerRow = useFlipRows(rows.map((row) => row.key))

  if (!data || !data.byOpponent || data.overall.all.total === 0) {
    return (
      <EmptyState description="這組條件下沒有任何對戰紀錄。放寬場數或時間區間，或清掉幾條進階條件再看看。" />
    )
  }

  const overall = data.overall
  const edge =
    overall.first.total > 0 && overall.second.total > 0
      ? overall.first.winRate - overall.second.winRate
      : null

  const rateOrNull = (stat: { total: number; winRate: number }): number | null =>
    stat.total > 0 ? stat.winRate : null

  const summary: Array<{ label: string; value: string; color?: string }> = [
    {
      label: '總勝率',
      value: fmtRate(rateOrNull(overall.all)),
      color: rateColor(rateOrNull(overall.all))
    },
    {
      label: '先攻',
      value: fmtRate(rateOrNull(overall.first)),
      color: rateColor(rateOrNull(overall.first))
    },
    {
      label: '後攻',
      value: fmtRate(rateOrNull(overall.second)),
      color: rateColor(rateOrNull(overall.second))
    },
    {
      // 先手優勢是兩個勝率相減，不是離 50% 多遠，所以不套那組顏色
      label: '先手優勢',
      value: edge === null ? '—' : `${edge >= 0 ? '+' : '−'}${Math.abs(edge).toFixed(1)}%`
    },
    { label: '對局數', value: overall.all.total.toLocaleString() }
  ]

  return (
    // 撐滿分析器給的高度：摘要、排序與尺規各佔固定的一段，剩下的由七列平分，
    // 所以空間多的時候是長條變粗、列變鬆，而不是在下半部留一塊空白。
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 摘要一行帶過，不做五張 KPI 卡：它是這張圖的背景，不是主角。 */}
      <Box
        display="flex"
        alignItems="center"
        flexWrap="wrap"
        gap={1.5}
        sx={{ px: 1, pb: 1.25, rowGap: 0.5 }}
      >
        {summary.map((item, index) => (
          <React.Fragment key={item.label}>
            {index > 0 && (
              <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                ·
              </Typography>
            )}
            <Box display="flex" alignItems="baseline" gap={0.5}>
              <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                {item.label}
              </Typography>
              <Typography
                variant="body2"
                sx={{ ...NUMERIC, fontWeight: 700, color: item.color ?? 'text.primary' }}
              >
                {item.value}
              </Typography>
            </Box>
          </React.Fragment>
        ))}

        <Box flex={1} />

        {/* 排序不該搶過圖本身，所以是一個小下拉加一顆翻轉按鈕。 */}
        <Select
          size="small"
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as MatchupSortKey)}
          MenuProps={{
            anchorOrigin: { vertical: 'bottom', horizontal: 'right' },
            transformOrigin: { vertical: 'top', horizontal: 'right' },
            slotProps: { paper: { sx: { ...DROPDOWN_PAPER_SX, minWidth: 160 } } }
          }}
          sx={{
            height: 28,
            minWidth: 116,
            borderRadius: 1.5,
            fontSize: 13,
            bgcolor: 'action.hover',
            '& .MuiSelect-select': { py: 0, pl: 1.25 },
            '& .MuiOutlinedInput-notchedOutline': { borderColor: 'divider' }
          }}
        >
          {SORT_OPTIONS.map((key) => (
            <MenuItem key={key} value={key} sx={DROPDOWN_ITEM_SX}>
              <Typography variant="body2">{MATCHUP_SORT_LABELS[key]}</Typography>
            </MenuItem>
          ))}
        </Select>
        {/* 方向自己講清楚：一顆只有雙箭頭的按鈕看不出現在是哪一邊在上面，
            所以箭頭跟著方向轉，旁邊直接寫「高到低」。 */}
        <Button
          size="small"
          onClick={() => setDescending(!descending)}
          startIcon={
            descending ? (
              <ArrowDownwardRoundedIcon sx={{ fontSize: 16 }} />
            ) : (
              <ArrowUpwardRoundedIcon sx={{ fontSize: 16 }} />
            )
          }
          sx={{
            height: 28,
            px: 1,
            minWidth: 0,
            borderRadius: 1.5,
            color: 'text.secondary',
            bgcolor: 'action.hover',
            whiteSpace: 'nowrap',
            '&:hover': { bgcolor: 'action.selected', color: 'text.primary' }
          }}
        >
          {descending ? '高到低' : '低到高'}
        </Button>
      </Box>

      {/* 尺規。刻度和每一列軌道裡那條 50% 線共用同一組幾何。 */}
      <Box sx={{ ...ROW_GRID, px: 1, pb: 0.5 }}>
        <Box sx={{ '@media (max-width: 720px)': { display: 'none' } }} />
        <Box sx={{ position: 'relative', height: 16 }}>
          {TICKS.map((tick) => (
            <Typography
              key={tick}
              variant="caption"
              sx={{
                position: 'absolute',
                left: plotX(ratioOf(tick)),
                // 兩端的刻度改成貼齊自己那一邊，否則 0 與 100 會被切掉一半
                transform:
                  tick === DOMAIN_MIN
                    ? 'none'
                    : tick === DOMAIN_MAX
                      ? 'translateX(-100%)'
                      : 'translateX(-50%)',
                color: tick === 50 ? 'text.secondary' : 'text.disabled',
                fontSize: 10,
                whiteSpace: 'nowrap'
              }}
            >
              {tick === 50 ? '50% 均勢' : `${tick}%`}
            </Typography>
          ))}
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {rows.map((row) => (
          <MatchupBarRow
            key={row.key}
            row={row}
            onClick={onMatchupClick}
            rowRef={registerRow(row.key)}
          />
        ))}
      </Box>
    </Box>
  )
}

export default MatchupBars
