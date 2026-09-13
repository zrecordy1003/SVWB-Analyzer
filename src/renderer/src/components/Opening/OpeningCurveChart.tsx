/**
 * 起手曲線 - the hand's mana curve as dealt and as kept, side by side.
 *
 * Hand-drawn SVG rather than a charting library. The chart is eight pairs of
 * bars with a gridline; a library would add a runtime dependency, a theme
 * bridge and a bundle of features this never uses, to draw something MUI's own
 * `ManaCurve` already draws by hand a few folders over. It follows that chart's
 * look - the same cost badges, the same portal-green for the kept hand - so a
 * player who has seen their deck's curve reads this one without a legend,
 * although one is provided.
 *
 * Both series are averages over the same complete hands, so they sum to the
 * same 4.0 and the difference between them is purely redistribution: what the
 * user throws back and what they fish for. That is the whole point of drawing
 * them together; two separate charts would make the eye do the subtraction.
 */
import { Box, LinearProgress, Stack, Tooltip, Typography, useTheme } from '@mui/material'
import React from 'react'

import { CURVE_MAX_COST, OPENING_THRESHOLDS, type CurvePoint } from '@shared/openingStats'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import { fmtCards, fmtCost, fmtDelta, NUMERIC } from './openingFormat'

/** The kept hand - `ManaCurve`'s portal green, so "curve" means one colour app-wide. */
const POST_TOP = '#b8ce40'
const POST_BOTTOM = '#a0d244'
/** The dealt hand: cool and quieter, the way "before" should sit behind "after". */
const PRE_FILL = 'rgba(144, 202, 249, 0.62)'

const H = 168
const PAD_TOP = 22
const PAD_BOTTOM = 34
const PAD_LEFT = 30
const PAD_RIGHT = 8
const BADGE_R = 10

/** Every bucket from 0 to `CURVE_MAX_COST`, so an unusual deck cannot shift the axis. */
function fillBuckets(curve: CurvePoint[]): CurvePoint[] {
  const byCost = new Map(curve.map((p) => [Math.min(CURVE_MAX_COST, p.cost), p]))
  const out: CurvePoint[] = []
  for (let cost = 0; cost <= CURVE_MAX_COST; cost++) {
    const p = byCost.get(cost)
    out.push({ cost, pre: p?.pre ?? 0, post: p?.post ?? 0 })
  }
  return out
}

function Legend({ swatch, label }: { swatch: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={0.75}>
      {swatch}
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  )
}

export default function OpeningCurveChart({
  curve,
  complete,
  avgCostPre,
  avgCostPost
}: {
  curve: CurvePoint[]
  /** Complete hands in range; drives the "N more games" state. */
  complete: number
  avgCostPre: number | null
  avgCostPost: number | null
}): React.JSX.Element {
  const theme = useTheme()
  const gridColour = theme.palette.divider
  const textColour = theme.palette.text.secondary

  // The chart is drawn in real pixels, measured off its container, because
  // `preserveAspectRatio="none"` would distort the badges. The observer is
  // attached whether or not a curve exists yet - the container is only
  // rendered in the drawn state, so the ref is simply null until then.
  const [width, setWidth] = React.useState(560)
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Below the line the handler ships an empty curve; above it the curve may
  // still be empty if every complete hand lacked a cost (cache miss). Both
  // land here, and the sentence differs.
  if (curve.length === 0) {
    const remaining = Math.max(0, OPENING_THRESHOLDS.curve - complete)
    return (
      <Box
        data-testid="opening-curve-empty"
        sx={{
          height: H + 40,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.25,
          px: 3,
          textAlign: 'center'
        }}
      >
        {remaining > 0 ? (
          <>
            <Typography variant="body2" fontWeight={700}>
              再打 {remaining} 場就會出現曲線
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420 }}>
              曲線只用八格全部認出來的手牌畫，不到 {OPENING_THRESHOLDS.curve} 場不畫 -
              少幾張卡算出來的不是比較粗的曲線，是錯的曲線。目前 {complete} 場。
            </Typography>
            <Box sx={{ width: 240 }}>
              <LinearProgress
                variant="determinate"
                value={(complete / OPENING_THRESHOLDS.curve) * 100}
                sx={{ height: 6, borderRadius: 3, bgcolor: 'action.hover' }}
                aria-label={`曲線進度 ${complete} / ${OPENING_THRESHOLDS.curve}`}
              />
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{ ...NUMERIC, display: 'block', mt: 0.5 }}
              >
                {complete} / {OPENING_THRESHOLDS.curve}
              </Typography>
            </Box>
          </>
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420 }}>
            場數夠了，但這些手牌的卡片費用還沒有進到卡片快取，畫不出曲線。之後會自動補上。
          </Typography>
        )}
      </Box>
    )
  }

  const buckets = fillBuckets(curve)
  const peakRaw = Math.max(0.5, ...buckets.flatMap((b) => [b.pre, b.post]))
  // Round the axis up to the next quarter card so the tallest bar has headroom
  // for its label and the gridlines land on readable values.
  const peak = Math.ceil(peakRaw * 4) / 4
  const gridStep = peak > 1.5 ? 0.5 : 0.25
  const gridLines: number[] = []
  for (let v = gridStep; v <= peak + 1e-9; v += gridStep) gridLines.push(v)

  const plotW = Math.max(120, width - PAD_LEFT - PAD_RIGHT)
  const plotH = H - PAD_TOP - PAD_BOTTOM
  const slot = plotW / buckets.length
  const gap = Math.min(10, slot * 0.18)
  const barW = Math.max(4, (slot - gap * 3) / 2)
  const y = (v: number): number => PAD_TOP + plotH - (v / peak) * plotH

  const costDelta = avgCostPre !== null && avgCostPost !== null ? avgCostPost - avgCostPre : null

  return (
    <Box data-testid="opening-curve">
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        rowGap={0.5}
        sx={{ mb: 0.5 }}
      >
        <Stack direction="row" spacing={2}>
          <Legend
            swatch={<Box sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: PRE_FILL }} />}
            label="換前（發到的）"
          />
          <Legend
            swatch={
              <Box
                sx={{
                  width: 12,
                  height: 12,
                  borderRadius: 0.5,
                  backgroundImage: `linear-gradient(0deg, ${POST_BOTTOM}, ${POST_TOP})`
                }}
              />
            }
            label="換後（留下的）"
          />
        </Stack>

        {/* 平均費用：兩個數字和它們的差，箭頭方向就是習慣的方向。 */}
        <Tooltip
          title="每手四張的平均費用，換前與換後。往下走代表你把高費換掉、去找低費；往上走是反過來。"
          placement="top"
        >
          <Stack
            direction="row"
            alignItems="baseline"
            spacing={0.75}
            sx={{ ...NUMERIC, cursor: 'help' }}
          >
            <Typography variant="caption" color="text.secondary">
              平均費用
            </Typography>
            <Typography variant="body2" fontWeight={800}>
              {fmtCost(avgCostPre)}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              →
            </Typography>
            <Typography variant="body2" fontWeight={800}>
              {fmtCost(avgCostPost)}
            </Typography>
            {costDelta !== null && (
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 700,
                  color: Math.abs(costDelta) < 0.05 ? 'text.disabled' : 'text.secondary'
                }}
              >
                ({fmtDelta(costDelta, 2)})
              </Typography>
            )}
          </Stack>
        </Tooltip>
      </Stack>

      <Box ref={ref} sx={{ width: '100%' }}>
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label="起手曲線：每個費用在換前與換後的平均張數"
          style={{ display: 'block', overflow: 'visible' }}
        >
          <defs>
            <linearGradient id="opening-post-grad" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor={POST_BOTTOM} />
              <stop offset="100%" stopColor={POST_TOP} />
            </linearGradient>
          </defs>

          {/* gridlines + axis labels */}
          {[0, ...gridLines].map((v) => (
            <g key={v}>
              <line
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotW}
                y1={y(v)}
                y2={y(v)}
                stroke={gridColour}
                strokeWidth={1}
                strokeDasharray={v === 0 ? undefined : '3 4'}
              />
              <text
                x={PAD_LEFT - 6}
                y={y(v) + 3.5}
                fontSize={10}
                fill={textColour}
                textAnchor="end"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {v.toFixed(v % 1 === 0 ? 0 : 2).replace(/\.?0+$/, '') || '0'}
              </text>
            </g>
          ))}

          {buckets.map((b, i) => {
            const x0 = PAD_LEFT + i * slot + gap
            const xPre = x0 + gap / 2
            const xPost = xPre + barW + gap
            const label = b.cost === CURVE_MAX_COST ? `${CURVE_MAX_COST}+` : String(b.cost)
            const delta = b.post - b.pre
            const tip = (
              <Box sx={{ ...NUMERIC, minWidth: 180 }}>
                <Typography variant="caption" component="div" fontWeight={700}>
                  {label} 費
                </Typography>
                <Typography variant="caption" component="div">
                  換前 {fmtCards(b.pre)} · 換後 {fmtCards(b.post)}
                </Typography>
                <Typography variant="caption" component="div" color="text.secondary">
                  {Math.abs(delta) < 0.005
                    ? '幾乎沒動'
                    : `${delta > 0 ? '多留了' : '換掉了'} ${Math.abs(delta).toFixed(2)} 張`}
                </Typography>
              </Box>
            )
            return (
              <Tooltip
                key={b.cost}
                title={tip}
                placement="top"
                slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
              >
                <g style={{ cursor: 'help' }} tabIndex={0} aria-label={`${label} 費`}>
                  {/* hit area, so hovering the gap between the two bars still works */}
                  <rect
                    x={PAD_LEFT + i * slot}
                    y={PAD_TOP - 8}
                    width={slot}
                    height={plotH + 8 + PAD_BOTTOM}
                    fill="transparent"
                  />
                  <rect
                    x={xPre}
                    y={y(b.pre)}
                    width={barW}
                    height={Math.max(0, y(0) - y(b.pre))}
                    rx={2}
                    fill={PRE_FILL}
                  />
                  <rect
                    x={xPost}
                    y={y(b.post)}
                    width={barW}
                    height={Math.max(0, y(0) - y(b.post))}
                    rx={2}
                    fill="url(#opening-post-grad)"
                  />
                  {/* the value only on the taller bar of the pair; two numbers per
                      bucket at this width run into each other */}
                  <text
                    x={(b.post >= b.pre ? xPost : xPre) + barW / 2}
                    y={y(Math.max(b.pre, b.post)) - 5}
                    fontSize={10}
                    fontWeight={700}
                    fill={theme.palette.text.primary}
                    textAnchor="middle"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {Math.max(b.pre, b.post).toFixed(2)}
                  </text>
                  {/* cost badge, the same look as `CostBadge` */}
                  <circle
                    cx={PAD_LEFT + i * slot + slot / 2}
                    cy={y(0) + 18}
                    r={BADGE_R}
                    fill="rgba(90,130,215,0.28)"
                    stroke="rgba(140,180,255,0.35)"
                  />
                  <text
                    x={PAD_LEFT + i * slot + slot / 2}
                    y={y(0) + 18 + 3.5}
                    fontSize={label.length > 1 ? 9 : 10.5}
                    fontWeight={800}
                    fill="#dce9ff"
                    textAnchor="middle"
                  >
                    {label}
                  </text>
                </g>
              </Tooltip>
            )
          })}
        </svg>
      </Box>
    </Box>
  )
}
