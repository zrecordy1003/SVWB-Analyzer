/**
 * 起手曲線 - the hand's mana curve as dealt and as kept, one drawn over the other.
 *
 * Hand-drawn SVG rather than a charting library. The chart is eight buckets
 * with a gridline; a library would add a runtime dependency, a theme bridge
 * and a bundle of features this never uses, to draw something MUI's own
 * `ManaCurve` already draws by hand a few folders over. It follows that
 * chart's look - the same cost badges, the same portal-green for the kept
 * hand - so a player who has seen their deck's curve reads this one without
 * a legend, although one is provided.
 *
 * # Overlay, not pairs
 *
 * The first pass drew two bars per bucket side by side. That is the textbook
 * encoding for two series and the wrong one for a before/after: the eye has
 * to compare eight pairs of heights, one pair at a time. Here the dealt hand
 * is a wide, dashed ghost and the kept hand is a solid bar drawn on top of
 * it, centred. Where the mulligan threw cards back, the ghost shows above the
 * solid bar; where it fished for them, the solid bar rises above the ghost.
 * The story - "I throw back my 5+ drops and dig for 1s and 2s" - is one
 * glance across the row of buckets, and the per-bucket delta is the only
 * digit printed on the plot. The alternatives considered: a slope/line pair
 * (reads as a trend over time, which a cost axis is not) and a single
 * signed-delta bar chart (loses the shape of the hand itself, which is what
 * a player recognises as "my curve").
 *
 * Both series are averages over the same complete hands, so they sum to the
 * same 4.0 and the difference between them is purely redistribution. The
 * average-cost shift is drawn too, as an arrow above the plot from the dealt
 * average to the kept average, so "the mulligan pulled my curve down" is a
 * mark and not a subtraction.
 */
import { Box, LinearProgress, Stack, Tooltip, Typography, useTheme } from '@mui/material'
import React from 'react'

import { CURVE_MAX_COST, OPENING_THRESHOLDS, type CurvePoint } from '@shared/openingStats'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'

import { fmtCards, fmtDelta, NUMERIC } from './openingFormat'

/** The kept hand - `ManaCurve`'s portal green, so "curve" means one colour app-wide. */
const POST_TOP = '#b8ce40'
const POST_BOTTOM = '#a0d244'
/** The dealt hand: cool and quieter, the way "before" should sit behind "after". */
const PRE_LINE = 'rgba(144, 202, 249, 0.85)'
const PRE_FILL = 'rgba(144, 202, 249, 0.16)'

const H = 200
const PAD_TOP = 34
const PAD_BOTTOM = 34
const PAD_LEFT = 30
const PAD_RIGHT = 8
const BADGE_R = 10
/** Deltas smaller than this are not labelled: at two decimals they read as noise. */
const DELTA_LABEL_MIN = 0.02

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

/** Legend row + the series' average cost: swatch, two-character label, the number. */
function SeriesStat({
  swatch,
  label,
  value
}: {
  swatch: React.ReactNode
  label: string
  value: number | null
}): React.JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      {swatch}
      <Typography variant="caption" color="text.secondary" sx={{ width: 28 }}>
        {label}
      </Typography>
      <Typography
        component="span"
        sx={{ ...NUMERIC, fontSize: 18, fontWeight: 900, lineHeight: 1 }}
      >
        {value === null ? '—' : value.toFixed(2)}
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
  // land here, and the picture differs: one is a progress bar, the other a
  // sentence, because there is nothing for the user to do about the second.
  if (curve.length === 0) {
    const remaining = Math.max(0, OPENING_THRESHOLDS.curve - complete)
    return (
      <Box
        data-testid="opening-curve-empty"
        sx={{
          height: H,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          px: 3,
          textAlign: 'center'
        }}
      >
        {remaining > 0 ? (
          <>
            <Typography component="div" sx={{ ...NUMERIC, lineHeight: 1.1 }}>
              <Box component="span" sx={{ fontSize: 13, color: 'text.secondary', mr: 0.75 }}>
                再
              </Box>
              <Box component="span" sx={{ fontSize: 34, fontWeight: 900 }}>
                {remaining}
              </Box>
              <Box component="span" sx={{ fontSize: 13, color: 'text.secondary', ml: 0.75 }}>
                場
              </Box>
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
          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 360 }}>
            場數夠了，但卡片費用還沒進到快取；之後會自動補上。
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
  const ghostW = slot * 0.72
  const barW = slot * 0.4
  const y = (v: number): number => PAD_TOP + plotH - (v / peak) * plotH
  const centre = (i: number): number => PAD_LEFT + i * slot + slot / 2
  /** A continuous cost (an average) on the bucket axis; 7.4 lands inside the 7+ bucket. */
  const costX = (c: number): number => PAD_LEFT + (Math.min(c, CURVE_MAX_COST) + 0.5) * slot

  const costDelta = avgCostPre !== null && avgCostPost !== null ? avgCostPost - avgCostPre : null
  const shiftY = PAD_TOP - 16

  return (
    <Box
      data-testid="opening-curve"
      sx={{ display: 'flex', gap: 2, alignItems: 'stretch', flexWrap: 'wrap' }}
    >
      <Box ref={ref} sx={{ flex: '1 1 380px', minWidth: 0 }}>
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
            <marker
              id="opening-shift-head"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0.5 L8,4 L0,7.5 Z" fill={POST_TOP} />
            </marker>
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

          {/* The average-cost shift: a dot where the dealt hand's average
              sits on the cost axis, an arrow to where the kept hand's does.
              Left is down-curving. */}
          {avgCostPre !== null && avgCostPost !== null && (
            <g aria-hidden>
              {Math.abs(avgCostPost - avgCostPre) > 0.01 && (
                <line
                  x1={costX(avgCostPre)}
                  x2={costX(avgCostPost)}
                  y1={shiftY}
                  y2={shiftY}
                  stroke={POST_TOP}
                  strokeWidth={1.5}
                  markerEnd="url(#opening-shift-head)"
                />
              )}
              <circle
                cx={costX(avgCostPre)}
                cy={shiftY}
                r={3.5}
                fill={theme.palette.background.paper}
                stroke={PRE_LINE}
                strokeWidth={1.5}
              />
            </g>
          )}

          {buckets.map((b, i) => {
            const cx = centre(i)
            const label = b.cost === CURVE_MAX_COST ? `${CURVE_MAX_COST}+` : String(b.cost)
            const delta = b.post - b.pre
            const top = Math.max(b.pre, b.post)
            const tip = (
              <Box sx={{ ...NUMERIC, minWidth: 180 }}>
                <Typography variant="caption" component="div" fontWeight={700}>
                  {label} 費
                </Typography>
                <Typography variant="caption" component="div">
                  發到 {fmtCards(b.pre)} → 留下 {fmtCards(b.post)}
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
                  {/* hit area, so hovering the gap between buckets still works */}
                  <rect
                    x={PAD_LEFT + i * slot}
                    y={PAD_TOP - 8}
                    width={slot}
                    height={plotH + 8 + PAD_BOTTOM}
                    fill="transparent"
                  />
                  {/* the dealt hand: wide dashed ghost */}
                  <rect
                    x={cx - ghostW / 2}
                    y={y(b.pre)}
                    width={ghostW}
                    height={Math.max(0, y(0) - y(b.pre))}
                    rx={3}
                    fill={PRE_FILL}
                    stroke={PRE_LINE}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  {/* the kept hand: narrow solid bar, centred on the ghost */}
                  <rect
                    x={cx - barW / 2}
                    y={y(b.post)}
                    width={barW}
                    height={Math.max(0, y(0) - y(b.post))}
                    rx={2}
                    fill="url(#opening-post-grad)"
                  />
                  {/* the only digit on the plot: the signed change, coloured by
                      which series is on top */}
                  {Math.abs(delta) >= DELTA_LABEL_MIN && (
                    <text
                      x={cx}
                      y={y(top) - 5}
                      fontSize={9.5}
                      fontWeight={700}
                      fill={delta > 0 ? POST_TOP : PRE_LINE}
                      textAnchor="middle"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {fmtDelta(delta, 2)}
                    </text>
                  )}
                  {/* cost badge, the same look as `CostBadge` */}
                  <circle
                    cx={cx}
                    cy={y(0) + 18}
                    r={BADGE_R}
                    fill="rgba(90,130,215,0.28)"
                    stroke="rgba(140,180,255,0.35)"
                  />
                  <text
                    x={cx}
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

      {/* Legend and the two averages in one column: the swatch says which bar,
          the number says where that hand's average cost sits, the delta
          underneath is the arrow above the plot, as a digit. */}
      <Stack
        spacing={1.25}
        justifyContent="center"
        sx={{ flex: '0 0 auto', minWidth: 132, pl: { md: 1 } }}
        data-testid="opening-curve-legend"
      >
        <SeriesStat
          swatch={
            <Box
              sx={{
                width: 14,
                height: 14,
                borderRadius: 0.5,
                bgcolor: PRE_FILL,
                border: `1px dashed ${PRE_LINE}`
              }}
            />
          }
          label="發到"
          value={avgCostPre}
        />
        <SeriesStat
          swatch={
            <Box
              sx={{
                width: 14,
                height: 14,
                borderRadius: 0.5,
                backgroundImage: `linear-gradient(0deg, ${POST_BOTTOM}, ${POST_TOP})`
              }}
            />
          }
          label="留下"
          value={avgCostPost}
        />
        {costDelta !== null && (
          <Typography
            component="div"
            sx={{
              ...NUMERIC,
              pl: '22px',
              fontSize: 13,
              fontWeight: 800,
              color: Math.abs(costDelta) < 0.05 ? 'text.disabled' : 'text.secondary'
            }}
          >
            {fmtDelta(costDelta, 2)}
            <Box component="span" sx={{ fontSize: 11, fontWeight: 400, ml: 0.5 }}>
              費
            </Box>
          </Typography>
        )}
      </Stack>
    </Box>
  )
}
