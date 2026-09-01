/**
 * The deck's mana curve, drawn the way the official Deck Portal draws it.
 *
 * Measured from `#deck-detail .detail .graph-area` rather than guessed:
 *
 *   .graph      background rgb(13,17,25), flex, align-items: flex-end
 *   .graph-bar  width 100%, linear-gradient(0deg, #a0d244, #b8ce40)
 *   .cur-count  centred, bold, #fff7ea
 *   layout      count above, bar, cost below; eight buckets, 1 through 8+
 *
 * Two deliberate departures:
 *
 * - A 0-cost bucket appears only when the deck actually has 0-cost cards. The
 *   portal has no such column; showing an always-empty one would be a permanent
 *   gap in the chart for a case that almost never comes up.
 * - The cost marker is a numbered badge, not the portal's cost icon. That icon
 *   is a Cygames asset and not ours to ship (ASSETS_POLICY.md); the number is
 *   the information anyway.
 */
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import React from 'react'

/** From the portal's own `.graph-bar` gradient. */
const BAR_GRADIENT = 'linear-gradient(0deg, #a0d244 0%, #b8ce40 100%)'
/**
 * The track a bar grows in.
 *
 * The portal uses a flat `rgb(13,17,25)`, which works there because its panel
 * is lighter. Dropped straight onto this app's near-black bar it vanished:
 * running the app showed seven of the eight columns as empty space, so an
 * all-but-one-empty curve read as a rendering failure rather than as a curve.
 *
 * A hair lighter than the surface, plus an outline, so every column is visible
 * as a column whether or not anything is in it.
 */
const TRACK_BG = 'rgba(255,255,255,0.045)'
const TRACK_BORDER = '1px solid rgba(255,255,255,0.07)'
/** From `.graph-area`; warm off-white rather than pure white. */
const COUNT_COLOUR = '#fff7ea'

/** Anything this cost or above shares the last column, as on the portal. */
const MAX_BUCKET = 8

export type ManaCurveCard = { cost: number | null; count: number; kind?: string | null }

/** Bucket a deck's cards by cost. Internal - fast refresh wants one export here. */
function summariseCurve(cards: ReadonlyArray<ManaCurveCard>): {
  buckets: { cost: number; count: number; label: string }[]
  total: number
  counts: { follower: number; spell: number; amulet: number }
} {
  const byCost = new Map<number, number>()
  const counts = { follower: 0, spell: 0, amulet: 0 }
  let total = 0

  for (const card of cards) {
    const bucket = Math.min(MAX_BUCKET, Math.max(0, card.cost ?? 0))
    byCost.set(bucket, (byCost.get(bucket) ?? 0) + card.count)
    total += card.count
    if (card.kind === 'follower' || card.kind === 'spell' || card.kind === 'amulet') {
      counts[card.kind] += card.count
    }
  }

  // 1..8 always; 0 only when it is real, so the chart has no permanent gap.
  const start = (byCost.get(0) ?? 0) > 0 ? 0 : 1
  const buckets: { cost: number; count: number; label: string }[] = []
  for (let cost = start; cost <= MAX_BUCKET; cost++) {
    buckets.push({
      cost,
      count: byCost.get(cost) ?? 0,
      label: cost === MAX_BUCKET ? `${MAX_BUCKET}+` : String(cost)
    })
  }

  return { buckets, total, counts }
}

/**
 * How far along the deck is, and what to say about it.
 *
 * This replaced a banner across the top of the builder that said "還差 39 張才
 * 滿 40" in a full-width Alert. It was correct and it was shouting: the count
 * is already on screen twice, and a permanent warning bar for the ordinary
 * state of a deck being built trains people to ignore banners.
 *
 * The number carries the state instead - colour for the stage, the sentence on
 * hover for anyone who wants it.
 */
function sizeState(total: number, deckSize: number): { colour: string; hint: string } {
  if (total === 0) {
    return { colour: 'text.disabled', hint: '還沒有卡片。從左邊點卡片加入牌組。' }
  }
  if (total < deckSize) {
    return {
      colour: 'warning.main',
      hint: `還差 ${deckSize - total} 張才滿 ${deckSize}。未滿也可以儲存，但遊戲不會接受未滿的牌組。`
    }
  }
  if (total > deckSize) {
    return { colour: 'error.main', hint: `超過 ${deckSize} 張了，請移除 ${total - deckSize} 張。` }
  }
  return { colour: 'success.main', hint: `剛好 ${deckSize} 張，可以儲存並發行牌組代碼帶回遊戲。` }
}

export default function ManaCurve({
  cards,
  height = 72,
  deckSize
}: {
  cards: ReadonlyArray<ManaCurveCard>
  /** Track height in px. The bar is scaled against the tallest bucket. */
  height?: number
  /** When given, the total reads as `n / deckSize` and carries the deck state. */
  deckSize?: number
}): React.JSX.Element {
  const { buckets, total, counts } = React.useMemo(() => summariseCurve(cards), [cards])
  // Scaled to the tallest column, not to 40: a curve where nothing reaches the
  // top of the track tells you nothing about its own shape.
  const peak = Math.max(1, ...buckets.map((b) => b.count))

  return (
    <Box>
      <Stack direction="row" spacing={0.5} alignItems="flex-end">
        {buckets.map((bucket) => (
          <Stack key={bucket.cost} spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="caption"
              align="center"
              sx={{
                fontWeight: 700,
                lineHeight: 1.2,
                color: COUNT_COLOUR,
                // An empty column keeps its zero but recedes, so the eye
                // follows the shape rather than counting labels.
                opacity: bucket.count === 0 ? 0.3 : 1
              }}
            >
              {bucket.count}
            </Typography>

            <Box
              sx={{
                height,
                bgcolor: TRACK_BG,
                border: TRACK_BORDER,
                borderRadius: 0.5,
                display: 'flex',
                alignItems: 'flex-end',
                overflow: 'hidden'
              }}
            >
              <Box
                sx={{
                  width: '100%',
                  height: `${(bucket.count / peak) * 100}%`,
                  backgroundImage: BAR_GRADIENT,
                  transition: 'height .3s'
                }}
              />
            </Box>

            <Box
              sx={{
                mx: 'auto',
                minWidth: 20,
                height: 20,
                px: 0.5,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: 11,
                fontWeight: 800,
                color: '#dce9ff',
                bgcolor: 'rgba(90,130,215,0.28)',
                border: '1px solid rgba(140,180,255,0.35)'
              }}
            >
              {bucket.label}
            </Box>
          </Stack>
        ))}
      </Stack>

      <Stack
        direction="row"
        spacing={1.5}
        justifyContent="center"
        sx={{ mt: 1.25, color: 'text.secondary' }}
      >
        {deckSize == null ? (
          <Typography variant="caption" sx={{ fontWeight: 800, color: COUNT_COLOUR }}>
            {total} 張
          </Typography>
        ) : (
          // Downwards: the count sits under the chart, so a tooltip above it
          // would land on the cost badges - the one row it must not cover.
          <Tooltip title={sizeState(total, deckSize).hint} placement="bottom" arrow>
            <Typography
              variant="caption"
              sx={{
                fontWeight: 900,
                cursor: 'help',
                fontVariantNumeric: 'tabular-nums',
                color: sizeState(total, deckSize).colour,
                transition: 'color .2s',
                textDecoration: 'underline dotted',
                textUnderlineOffset: 3,
                textDecorationColor: 'rgba(255,255,255,0.25)'
              }}
            >
              {total} / {deckSize}
            </Typography>
          </Tooltip>
        )}
        <Typography variant="caption">從者 {counts.follower}</Typography>
        <Typography variant="caption">法術 {counts.spell}</Typography>
        <Typography variant="caption">護符 {counts.amulet}</Typography>
      </Stack>
    </Box>
  )
}
