/**
 * One deck, as a tile you can recognise across the room.
 *
 * The table this replaced was denser and more comparable, and that trade was
 * made deliberately: a deck's identity is its cards, and four columns of text
 * made every row look the same. What the table did well - letting you compare
 * win rates at a glance - is kept by the bar along the bottom, which is a
 * shared scale across every tile rather than a number you have to read.
 *
 * The background is the deck's own cover-card art. Three things make that
 * survivable rather than noisy:
 *
 * - It is dimmed hard and sits under a gradient. The art is there to be
 *   recognised, not read; the text on top has to win.
 * - The class colour tints the tile even when there is art, so a glance sorts
 *   decks by class before it sorts them by picture.
 * - A deck with no art - built by hand, or imported before the card cache had
 *   the card - falls back to that same class tint alone. It looks like a
 *   quieter member of the same family, not like a broken tile.
 */
import { Box, Chip, Stack, Typography } from '@mui/material'
import { cardImageUrl } from '@shared/deckImport'
import React from 'react'

import ClassIcon from '@renderer/components/Common/ClassIcon'
import { classTone } from '@renderer/components/Common/classTone'
import { classesMap } from '@renderer/map/classMap'

/**
 * Recognise the common archetypes in a free-text category name.
 *
 * Moved here from the table this tile replaced rather than dropped: the user
 * types their own category names, and colouring the three everyone uses is what
 * lets a glance across the grid separate aggro decks from control ones.
 */
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

export type DeckTileData = {
  id: number
  name: string
  classId: string | null
  categoryName: string | null
  heroBannerHash: string | null
  composition: { follower: number; spell: number; amulet: number } | null
  total: number
  wins: number
  winRate: number
}

export default function DeckTile({
  deck,
  onClick
}: {
  deck: DeckTileData
  onClick: () => void
}): React.JSX.Element {
  const tone = classTone(deck.classId)
  const art = cardImageUrl('list', deck.heroBannerHash)
  const archetype = getDeckArchetype(deck.categoryName)
  const played = deck.total > 0
  const [artFailed, setArtFailed] = React.useState(false)

  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 2,
        cursor: 'pointer',
        minHeight: 150,
        border: '1px solid rgba(255,255,255,0.08)',
        // The class tint is the base layer, so a deck without art still reads
        // as its class rather than as an empty box.
        backgroundColor: '#141926',
        backgroundImage: `linear-gradient(100deg, ${tone}26 0%, ${tone}0a 45%, rgba(0,0,0,0) 70%)`,
        transition: 'transform .14s, box-shadow .14s, border-color .14s',
        '&:hover': {
          transform: 'translateY(-2px)',
          borderColor: `${tone}66`,
          boxShadow: `0 10px 26px -10px rgba(0,0,0,.8), 0 0 0 1px ${tone}33`
        }
      }}
    >
      {art && !artFailed && (
        <Box
          component="img"
          src={art}
          alt=""
          loading="lazy"
          onError={() => setArtFailed(true)}
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            // Near full strength. Legibility is the scrim's job, not the
            // image's: dimming the art to protect the text made every tile look
            // the same again, which is the exact thing the art is here to fix.
            opacity: 0.92
          }}
        />
      )}

      {/* Keeps text legible over whatever the art happens to be. */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          // Opaque where the text is, clear where it is not. The turn happens
          // just past the middle, so the right half of the card is genuinely
          // visible rather than merely present.
          background:
            'linear-gradient(90deg, rgba(11,14,21,0.97) 0%, rgba(11,14,21,0.93) 40%, rgba(11,14,21,0.55) 66%, rgba(11,14,21,0.12) 100%)'
        }}
      />

      {/* The class stripe: the fastest thing to read on the tile. */}
      <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, bgcolor: tone }} />

      <Stack sx={{ position: 'relative', height: '100%', px: 2, py: 1.5 }} spacing={0.75}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography fontWeight={800} noWrap sx={{ flex: 1, minWidth: 0 }} title={deck.name}>
            {deck.name}
          </Typography>
          {(archetype || deck.categoryName) && (
            <Chip
              size="small"
              label={archetype?.label ?? deck.categoryName}
              sx={{
                height: 20,
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
                color: archetype?.color,
                bgcolor: archetype?.background ?? 'rgba(255,255,255,0.08)'
              }}
            />
          )}
        </Stack>

        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Stack direction="row" alignItems="center" spacing={0.75}>
            {/* 18 rather than the 20 the lists use: this line is caption-sized
                and sits under a deck name, so a full-height mark would outweigh
                the text it belongs to. */}
            <ClassIcon id={deck.classId} size={18} tone={tone} />
            <Typography variant="caption" color="text.secondary">
              {classesMap[String(deck.classId)]?.label ?? '未分類'}
            </Typography>
          </Stack>

          {/* Only when there IS a card list. Three zeroes on a deck created by
              hand would claim it is empty rather than that we do not know. */}
          {deck.composition && (
            <>
              <Box sx={{ width: 3, height: 3, borderRadius: '50%', bgcolor: 'text.disabled' }} />
              <Stack direction="row" spacing={0.75}>
                {(
                  [
                    ['從者', deck.composition.follower],
                    ['法術', deck.composition.spell],
                    ['護符', deck.composition.amulet]
                  ] as const
                ).map(([label, n]) => (
                  <Typography
                    key={label}
                    variant="caption"
                    sx={{
                      color: 'text.secondary',
                      fontVariantNumeric: 'tabular-nums',
                      opacity: n === 0 ? 0.45 : 1
                    }}
                  >
                    {label}
                    <Box component="span" sx={{ fontWeight: 800, ml: 0.4 }}>
                      {n}
                    </Box>
                  </Typography>
                ))}
              </Stack>
            </>
          )}
        </Stack>

        <Box sx={{ flex: 1 }} />

        {played ? (
          <>
            <Stack direction="row" alignItems="baseline" spacing={1}>
              <Typography
                sx={{
                  fontSize: 22,
                  fontWeight: 900,
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                  color: deck.winRate >= 50 ? 'success.light' : 'error.light'
                }}
              >
                {deck.winRate.toFixed(1)}
                <Box component="span" sx={{ fontSize: 12, fontWeight: 700, ml: 0.25 }}>
                  %
                </Box>
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {deck.wins}勝 {deck.total - deck.wins}敗 ・ {deck.total} 場
              </Typography>
            </Stack>

            {/* One shared scale across every tile - this is what replaces the
                table's sortable win-rate column. */}
            <Box
              sx={{
                height: 4,
                borderRadius: 2,
                bgcolor: 'rgba(255,255,255,0.09)',
                overflow: 'hidden'
              }}
            >
              <Box
                sx={{
                  width: `${Math.min(100, deck.winRate)}%`,
                  height: '100%',
                  bgcolor: deck.winRate >= 50 ? 'success.main' : 'error.main'
                }}
              />
            </Box>
          </>
        ) : (
          <Typography variant="caption" sx={{ color: 'text.disabled' }}>
            還沒有對局紀錄
          </Typography>
        )}
      </Stack>
    </Box>
  )
}
