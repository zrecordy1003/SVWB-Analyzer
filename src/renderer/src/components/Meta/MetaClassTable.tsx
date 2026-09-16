/**
 * 七個職業，一列一個：用它的人先攻打成什麼樣、後攻打成什麼樣、合起來什麼樣。
 *
 * 這張表同時是旁邊那個環（`MetaSharePie`）的圖例：職業色與徽章在這裡，佔比
 * 只在環上。兩邊共用 `highlighted`，滑過任何一邊另一邊會亮起來。佔比的數字
 * 原本也印在這裡一欄，使用者看過以後要它只留在環上 - 同一個量畫兩次，讀者會
 * 以為那是兩件事，而表格的版面該讓給勝率。
 *
 * # 三個勝率，一個顏色系統
 *
 * 先攻、後攻、總勝率三欄用同一支 `rateColor`，和分析器的對位表是同一組色階，
 * 所以「綠＝贏面大」在整個 app 裡是同一件事。先後攻分開列是這一版的重點：
 * 很多職業兩側差了十個百分點以上，那個差距是這頁最值錢的一眼。差距夠大時
 * 兩欄之間多一顆「先 +x」的徽章，門檻與樣式沿用熱圖的 `SWING_THRESHOLD` -
 * 同一個量在兩頁若用兩種門檻，讀者會以為那是資料的差別。
 *
 * # 樣本數全部收進 hover
 *
 * 「每個百分比旁邊永遠有 n」是這個 app 其他統計畫面的底線，這張表原本也
 * 在勝率底下印了一行 n。使用者在螢幕上看過以後要它進 hover：表要一眼看得完。
 * 那是他的決定；這裡守住的底線改成**一次 hover 就看得到列上每個數字的 n**：
 * 整列是一個 tooltip，裡面是總勝率（含 95% 區間）、先攻、後攻各自的勝敗與 n、
 * 遇到場次、使用者數。tooltip 不再只掛在勝率那一格 - 掛在一格上，先後攻兩欄
 * 的 n 就會變成「在頁面某處」而不是「一次滑鼠移動內」。
 *
 * 總勝率的 n 來自伺服器的 `byClass`，先後攻的 n 是格子加總，兩個可以不一樣
 * （`metaModel` 說明了為什麼，以及為什麼不互相修正）。不一樣時 tooltip 多一行
 * 說有對位因人數不足未公開 - 兩個 n 並排而不解釋，讀者會當成 bug。
 */
import React from 'react'
import { Box, Tooltip, Typography } from '@mui/material'

import ClassIcon from '@renderer/components/Common/ClassIcon'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import { classTextSx } from '@renderer/map/classMap'
import { SWING_THRESHOLD, rateColor } from '@renderer/components/Analyzer/matchupRows'

import type { MetaClassRow, MetaSideSplit } from './metaModel'

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

/** 職業 · 先攻 · 後攻 · 先後差徽章 · 總勝率。三個勝率等寬，讀成一家人。 */
const COLUMNS = {
  gridTemplateColumns: 'minmax(104px, 1fr) 80px 80px 60px 80px'
}
/** 窄的時候先丟掉徽章：它是兩欄的差，兩欄都在，差自己看得出來。 */
const COLUMNS_NARROW = { gridTemplateColumns: 'minmax(92px, 1fr) 68px 68px 0 68px' }

const HIDE_NARROW = { '@media (max-width: 720px)': { display: 'none' } } as const

const fmtRate = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`)

function RateCell({ rate }: { rate: number | null }): React.JSX.Element {
  return (
    <Typography
      variant="body2"
      sx={{
        ...NUMERIC,
        textAlign: 'right',
        color: rate === null ? 'text.disabled' : (rateColor(rate) ?? 'text.primary')
      }}
    >
      {fmtRate(rate)}
    </Typography>
  )
}

/** tooltip 裡的一行：標籤、勝率、勝敗、n。四欄對齊，讀者的眼睛不用逐行找。 */
function FigureLine({
  label,
  rate,
  detail,
  n
}: {
  label: string
  rate: number | null
  detail: React.ReactNode
  n: number
}): React.JSX.Element {
  return (
    <>
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}
      </Box>
      <Box
        component="span"
        sx={{ textAlign: 'right', color: rateColor(rate) ?? 'text.primary', fontWeight: 600 }}
      >
        {fmtRate(rate)}
      </Box>
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {detail}
      </Box>
      <Box component="span" sx={{ textAlign: 'right', color: 'text.secondary' }}>
        n={n.toLocaleString()}
      </Box>
    </>
  )
}

const winsLosses = (split: MetaSideSplit): string =>
  split.total === 0 ? '沒有這一側的資料' : `${split.wins} 勝 ${split.total - split.wins} 敗`

function RowTooltip({ row }: { row: MetaClassRow }): React.JSX.Element {
  return (
    <Typography variant="body2" component="div" sx={NUMERIC}>
      <Box
        component="div"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto auto auto auto',
          columnGap: 1.5,
          rowGap: 0.25,
          alignItems: 'baseline'
        }}
      >
        {row.total === 0 ? (
          <Box component="span" sx={{ gridColumn: '1 / -1', color: 'text.secondary' }}>
            這個區間沒有人用這個職業記錄到對局
          </Box>
        ) : (
          <>
            <FigureLine
              label="總勝率"
              rate={row.rate}
              detail={`95% 區間 ${row.interval.low.toFixed(1)}–${row.interval.high.toFixed(1)}`}
              n={row.total}
            />
            <FigureLine
              label="先攻"
              rate={row.first.rate}
              detail={winsLosses(row.first)}
              n={row.first.total}
            />
            <FigureLine
              label="後攻"
              rate={row.second.rate}
              detail={winsLosses(row.second)}
              n={row.second.total}
            />
          </>
        )}
      </Box>
      <Box component="div" sx={{ mt: 0.75, color: 'text.secondary' }}>
        遇到 {row.encounters.toLocaleString()} 場
        {row.total > 0 && ` · 至少 ${row.installs} 位使用者`}
      </Box>
      {/* 先後攻的分母加起來比總勝率的小：不是算錯，是有對位沒被公開。這行只在
          真的差的時候出現 - 場次是整數，差 1 場也是差，沒有「捨入誤差」可言。 */}
      {row.withheld > 0 && (
        <Box component="div" sx={{ mt: 0.25, color: 'text.secondary' }}>
          另有 {row.withheld.toLocaleString()} 場的對位因人數不足未公開，不在先攻／後攻的分母裡
        </Box>
      )}
    </Typography>
  )
}

export default function MetaClassTable({
  rows,
  selected,
  highlighted,
  onHighlight,
  onSelect
}: {
  rows: MetaClassRow[]
  /** 目前在下方對位表裡的職業，讓兩塊之間看得出關聯。 */
  selected: string | null
  /** 滑鼠或焦點停在哪個職業上 - 和 `MetaSharePie` 共用，由上層持有。 */
  highlighted: string | null
  onHighlight: (id: string | null) => void
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <Box>
      <Box
        sx={{
          display: 'grid',
          ...COLUMNS,
          '@media (max-width: 720px)': COLUMNS_NARROW,
          alignItems: 'center',
          gap: 1,
          px: 1,
          pb: 0.75,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          color: 'rgba(255,255,255,0.5)'
        }}
      >
        <Typography variant="caption">職業</Typography>
        <Typography variant="caption" sx={{ textAlign: 'right' }}>
          先攻勝率
        </Typography>
        <Typography variant="caption" sx={{ textAlign: 'right' }}>
          後攻勝率
        </Typography>
        <Box sx={HIDE_NARROW} />
        <Typography variant="caption" sx={{ textAlign: 'right' }}>
          總勝率
        </Typography>
      </Box>

      {rows.map((row) => {
        const active = row.id === selected
        const lit = row.id === highlighted
        const bigSwing = row.swing !== null && Math.abs(row.swing) >= SWING_THRESHOLD
        return (
          // Tooltip 包整列而不是某一格：列上三個百分比的 n 都在同一個 hover 裡。
          // MUI 會把自己的 hover／focus 監聽和底下那些合在一起，highlight 照常運作。
          <Tooltip
            key={row.id}
            placement="top"
            followCursor
            enterDelay={150}
            slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
            title={<RowTooltip row={row} />}
          >
            <Box
              onClick={() => onSelect(row.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(row.id)
                }
              }}
              onMouseEnter={() => onHighlight(row.id)}
              onMouseLeave={() => onHighlight(null)}
              onFocus={() => onHighlight(row.id)}
              onBlur={() => onHighlight(null)}
              sx={{
                display: 'grid',
                ...COLUMNS,
                '@media (max-width: 720px)': COLUMNS_NARROW,
                alignItems: 'center',
                gap: 1,
                px: 1,
                py: 0.85,
                borderRadius: 1.5,
                cursor: 'pointer',
                outline: 'none',
                // 被選是底色，被滑到是 hover 色 - 兩者疊在同一列時被選的贏，
                // 因為那是會影響下方那張圖的狀態。
                bgcolor: active ? 'action.selected' : lit ? 'action.hover' : 'transparent',
                transition: 'background-color .15s',
                '&:focus-visible': { boxShadow: '0 0 0 2px rgba(144,202,249,0.5) inset' }
              }}
            >
              <Box display="flex" alignItems="center" gap={0.75} minWidth={0}>
                <ClassIcon id={row.id} size={20} tone={row.color} dim={row.encounters === 0} />
                <Typography variant="body2" noWrap sx={classTextSx(row.id)}>
                  {row.label}
                </Typography>
              </Box>

              <RateCell rate={row.first.rate} />
              <RateCell rate={row.second.rate} />

              {/* 先後差只在幅度夠大時才出現，其餘留白 - 和熱圖同一條規則、同一個樣子。 */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  ...HIDE_NARROW
                }}
              >
                {bigSwing && row.swing !== null && (
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
                )}
              </Box>

              <RateCell rate={row.rate} />
            </Box>
          </Tooltip>
        )
      })}
    </Box>
  )
}
