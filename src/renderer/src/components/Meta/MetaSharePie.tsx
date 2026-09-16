/**
 * 環境佔比 - 七個職業各佔多少，畫成一個環。
 *
 * 手繪 SVG，不掛圖表函式庫：七段弧加一圈底，換一個依賴進來只為了畫這個不划算，
 * 而且 `Opening/` 那兩張圖已經立了同樣的先例。
 *
 * # 為什麼是環而不是實心的餅
 *
 * 中間那個洞不是裝飾。沒有滑到任何一塊時它放總觀測場次 - 整張圖的分母；滑到
 * 一塊時換成那個職業的名字與佔比。這樣圖上不必每一塊都貼字，小塊的也不會把
 * 標籤疊到鄰居身上：**佔比夠寬的直接寫百分比，不夠寬的靠 hover 或旁邊那張表。**
 *
 * # 圖例就是旁邊那張表
 *
 * 這裡沒有自己的圖例。同一頁的職業表已經有職業色與徽章，再畫一份只是重複；
 * 反過來讓兩邊共用一個 `highlighted`（滑過一塊亮起對應那列，滑過一列亮起對應
 * 那塊），兩個東西就讀成一個元件。狀態由 `MetaPage` 持有，這個檔案只回報。
 *
 * # 老實說：圓餅圖在這裡不是最強的編碼
 *
 * 七個職業的佔比常常都在一成到兩成之間，而人眼比較相鄰弧長的能力比比較長條
 * 差得多。使用者要的是圓餅圖，所以畫的是圓餅圖；為了補這個弱點，精確的數字
 * 留在表格裡（那一欄現在是純數字，不再有長條），這張圖負責的是「誰大誰小、
 * 有沒有一家獨大」這種一眼的形狀。
 *
 * # 零與滿
 *
 * 佔比為 0 的職業不畫弧（畫一條零寬的弧再貼標籤只會壓在別人身上），表格裡那
 * 列會用暗掉的徽章說它沒出現過。只剩一個職業時弧的起點等於終點，SVG 的 `A`
 * 指令會什麼都不畫，所以那種情況改用兩個半圓拼成整圈。
 */
import React from 'react'
import { Box, Tooltip, Typography, useTheme } from '@mui/material'

import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import type { MetaClassRow } from './metaModel'

const SIZE = 200
const CX = SIZE / 2
const CY = SIZE / 2
const R_OUTER = 92
const R_INNER = 58
/** 被選（在下方對位表裡）的那一塊往外凸一點，和表格那列的底色是同一件事。 */
const R_SELECTED_BUMP = 4
/** 低於這個佔比的弧不貼百分比：弧長不夠放五個字，硬貼會疊到鄰居。 */
const LABEL_MIN_SHARE = 7
const TAU = Math.PI * 2

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

const polar = (r: number, angle: number): [number, number] => [
  CX + r * Math.cos(angle),
  CY + r * Math.sin(angle)
]

/**
 * 一段環形扇區的路徑。角度從十二點鐘開始順時針，和表格由上往下的順序一致。
 *
 * 整圈（只剩一個職業有資料）走另一條路：以 evenodd 畫兩個同心圓，因為一條
 * 起點等於終點的弧在 SVG 裡等於沒畫。
 */
function sectorPath(a0: number, a1: number, rOuter: number): string {
  if (a1 - a0 >= TAU - 1e-6) {
    return [
      `M ${CX - rOuter} ${CY}`,
      `a ${rOuter} ${rOuter} 0 1 0 ${rOuter * 2} 0`,
      `a ${rOuter} ${rOuter} 0 1 0 ${-rOuter * 2} 0`,
      `M ${CX - R_INNER} ${CY}`,
      `a ${R_INNER} ${R_INNER} 0 1 0 ${R_INNER * 2} 0`,
      `a ${R_INNER} ${R_INNER} 0 1 0 ${-R_INNER * 2} 0`,
      'Z'
    ].join(' ')
  }
  const large = a1 - a0 > Math.PI ? 1 : 0
  const [ox0, oy0] = polar(rOuter, a0)
  const [ox1, oy1] = polar(rOuter, a1)
  const [ix0, iy0] = polar(R_INNER, a0)
  const [ix1, iy1] = polar(R_INNER, a1)
  return [
    `M ${ox0} ${oy0}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${ox1} ${oy1}`,
    `L ${ix1} ${iy1}`,
    `A ${R_INNER} ${R_INNER} 0 ${large} 0 ${ix0} ${iy0}`,
    'Z'
  ].join(' ')
}

export default function MetaSharePie({
  rows,
  selected,
  highlighted,
  onHighlight,
  onSelect
}: {
  /** 已經照佔比由大到小排好（`metaClassRows` 保證），這裡不再排一次。 */
  rows: MetaClassRow[]
  /** 目前在下方對位表裡的職業。 */
  selected: string | null
  /** 滑鼠或鍵盤焦點停在哪個職業上 - 表格與這張圖共用同一個。 */
  highlighted: string | null
  onHighlight: (id: string | null) => void
  onSelect: (id: string) => void
}): React.JSX.Element {
  const theme = useTheme()
  const gap = theme.palette.background.paper
  const total = rows.reduce((sum, row) => sum + row.encounters, 0)
  const focused = highlighted ? rows.find((row) => row.id === highlighted) : undefined

  // 角度用 encounters 算而不是 share：share 已經四捨五入到小數兩位，七塊加起來
  // 不一定剛好是 100，最後一塊會留一條細縫或疊上第一塊。
  let cursor = -Math.PI / 2
  const slices = rows
    .filter((row) => row.encounters > 0)
    .map((row) => {
      const span = total > 0 ? (row.encounters / total) * TAU : 0
      const a0 = cursor
      const a1 = cursor + span
      cursor = a1
      return { row, a0, a1, mid: (a0 + a1) / 2 }
    })

  return (
    <Box
      sx={{
        width: SIZE,
        height: SIZE,
        flexShrink: 0,
        position: 'relative'
      }}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="group"
        aria-label="環境佔比"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* 底圈：沒有任何資料時圖也不會消失成一個洞。 */}
        <circle
          cx={CX}
          cy={CY}
          r={(R_OUTER + R_INNER) / 2}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={R_OUTER - R_INNER}
        />

        {slices.map(({ row, a0, a1, mid }) => {
          const isHighlighted = row.id === highlighted
          const isSelected = row.id === selected
          const dimmed = highlighted !== null && !isHighlighted
          const rOuter = isSelected ? R_OUTER + R_SELECTED_BUMP : R_OUTER
          const [lx, ly] = polar((rOuter + R_INNER) / 2, mid)
          const label = `${row.label} ${row.share.toFixed(1)}%，遇到 ${row.encounters.toLocaleString()} 場`
          return (
            <Tooltip
              key={row.id}
              placement="top"
              slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
              title={
                <Typography variant="body2" component="div">
                  <Box component="span" sx={{ fontWeight: 700, color: row.color }}>
                    {row.label}
                  </Box>
                  <Box component="span" sx={{ ...NUMERIC, ml: 1 }}>
                    {row.share.toFixed(1)}% · {row.encounters.toLocaleString()} 場
                  </Box>
                </Typography>
              }
            >
              <g
                // `g` 而不是 `path` 拿焦點：標籤文字要跟著一起亮暗，也要一起被點。
                tabIndex={0}
                role="button"
                aria-label={label}
                aria-pressed={isSelected}
                onMouseEnter={() => onHighlight(row.id)}
                onMouseLeave={() => onHighlight(null)}
                onFocus={() => onHighlight(row.id)}
                onBlur={() => onHighlight(null)}
                onClick={() => onSelect(row.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(row.id)
                  }
                }}
                style={{ cursor: 'pointer', outline: 'none' }}
              >
                <path
                  d={sectorPath(a0, a1, rOuter)}
                  fill={row.color}
                  fillRule="evenodd"
                  // 塊與塊之間用面板色描一條細線當縫，比縮角度可靠：極小的一塊
                  // 縮了角度就不見了。
                  stroke={gap}
                  strokeWidth={1.5}
                  opacity={isHighlighted ? 1 : dimmed ? 0.4 : 0.85}
                  style={{ transition: 'opacity .15s' }}
                />
                {row.share >= LABEL_MIN_SHARE && (
                  <text
                    x={lx}
                    y={ly}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={11}
                    fontWeight={700}
                    fill="rgba(0,0,0,0.78)"
                    opacity={dimmed ? 0.4 : 1}
                    style={{ ...NUMERIC, pointerEvents: 'none', transition: 'opacity .15s' }}
                  >
                    {row.share.toFixed(1)}%
                  </text>
                )}
              </g>
            </Tooltip>
          )
        })}

        {/* 中央：預設是分母，滑到一塊就換成那一塊。字放 SVG 裡而不是疊一層
            HTML，才會跟著 viewBox 一起縮。 */}
        {focused ? (
          <>
            <text
              x={CX}
              y={CY - 8}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fontWeight={800}
              fill={focused.color}
              style={{ pointerEvents: 'none' }}
            >
              {focused.label}
            </text>
            <text
              x={CX}
              y={CY + 12}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={18}
              fontWeight={900}
              fill={theme.palette.text.primary}
              style={{ ...NUMERIC, pointerEvents: 'none' }}
            >
              {focused.share.toFixed(1)}%
            </text>
          </>
        ) : (
          <>
            <text
              x={CX}
              y={CY - 6}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={20}
              fontWeight={900}
              fill={theme.palette.text.primary}
              style={{ ...NUMERIC, pointerEvents: 'none' }}
            >
              {total.toLocaleString()}
            </text>
            <text
              x={CX}
              y={CY + 14}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={11}
              fill={theme.palette.text.secondary}
              style={{ pointerEvents: 'none' }}
            >
              場觀測
            </text>
          </>
        )}
      </svg>
    </Box>
  )
}
