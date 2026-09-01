/**
 * A deck's 40 cards, as a list or as art.
 *
 * Both modes render from the same rows, because the card art is decoration over
 * data we already have: with images switched off - which is the default, see
 * `settings.cardImages` - every card still shows its cost, name and count. The
 * `<img>` points at `svwb-card://`, so this component never knows whether a
 * picture came from disk, from the network, or not at all.
 */
import { Box, Skeleton, Stack, Typography } from '@mui/material'
import { cardImageUrl, type StoredDeckCard } from '@shared/deckImport'
import { cardTextToPlain } from '@shared/cardText'
import React from 'react'

/**
 * Structural rather than a concrete type, so this renders both a deck read back
 * from the database (`StoredDeckCard`) and one previewed straight from the
 * portal before it is saved (`DeckImportCard`). They agree on everything a card
 * row needs and differ only in fields it does not use.
 */
export type DeckCardListItem = Pick<
  StoredDeckCard,
  'cardId' | 'count' | 'name' | 'cost' | 'kind' | 'bannerHash' | 'skillText'
>

export type DeckCardListProps = {
  cards: DeckCardListItem[]
  /** Off falls back to the text rows; nothing else changes. */
  showImages: boolean
  loading?: boolean
  /** Shown when there are no cards; the import drawer wants different wording. */
  emptyText?: string
}

const KIND_LABEL: Record<string, string> = {
  follower: '從者',
  spell: '法術',
  amulet: '護符'
}

function CardArt({ card }: { card: DeckCardListItem }) {
  const src = cardImageUrl('list', card.bannerHash)
  const [failed, setFailed] = React.useState(false)

  return (
    <Box
      sx={{
        position: 'relative',
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'action.hover',
        aspectRatio: '360 / 90'
      }}
    >
      {src && !failed && (
        <Box
          component="img"
          src={src}
          alt={card.name}
          loading="lazy"
          onError={() => setFailed(true)}
          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      )}

      {/* The name always renders, over the art when there is art and on the
          placeholder when there is not. A card whose picture failed to load
          must still be identifiable. */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.75}
        sx={{
          position: 'absolute',
          inset: 'auto 0 0 0',
          px: 0.75,
          py: 0.4,
          background: 'linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0))'
        }}
      >
        <Box
          sx={{
            minWidth: 18,
            height: 18,
            borderRadius: '50%',
            bgcolor: 'rgba(0,0,0,0.65)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 800,
            display: 'grid',
            placeItems: 'center'
          }}
        >
          {card.cost ?? '?'}
        </Box>
        <Typography
          variant="caption"
          noWrap
          title={card.name}
          sx={{ flex: 1, color: '#fff', fontWeight: 700, textShadow: '0 1px 2px rgba(0,0,0,.9)' }}
        >
          {card.name}
        </Typography>
        <Typography variant="caption" sx={{ color: '#fff', fontWeight: 800 }}>
          ×{card.count}
        </Typography>
      </Stack>
    </Box>
  )
}

function CardRow({ card }: { card: DeckCardListItem }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ px: 1.5, py: 0.6, borderTop: '1px solid rgba(255,255,255,0.06)' }}
    >
      <Box
        sx={{
          minWidth: 22,
          textAlign: 'center',
          fontSize: 12,
          fontWeight: 800,
          color: 'text.secondary'
        }}
      >
        {card.cost ?? '?'}
      </Box>
      {/* Stripped, not raw: a native title cannot render the portal's markup and
          would print `<color=Keyword>…` at the user. */}
      <Typography
        variant="body2"
        sx={{ flex: 1 }}
        noWrap
        title={cardTextToPlain(card.skillText) || card.name}
      >
        {card.name}
      </Typography>
      {card.kind && (
        <Typography variant="caption" color="text.secondary">
          {KIND_LABEL[card.kind]}
        </Typography>
      )}
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ minWidth: 22, textAlign: 'right' }}
      >
        ×{card.count}
      </Typography>
    </Stack>
  )
}

export default function DeckCardList({ cards, showImages, loading, emptyText }: DeckCardListProps) {
  if (loading) {
    return (
      <Stack spacing={0.5}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} variant="rectangular" height={showImages ? 44 : 28} />
        ))}
      </Stack>
    )
  }

  if (cards.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
        {emptyText ?? '這副牌組沒有卡表資料。用「新增牌組」貼上牌組代碼或分享連結就會有。'}
      </Typography>
    )
  }

  if (!showImages) {
    return (
      <Box
        sx={{
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 1,
          overflow: 'hidden',
          '& > :first-of-type': { borderTop: 'none' }
        }}
      >
        {cards.map((card) => (
          <CardRow key={card.cardId} card={card} />
        ))}
      </Box>
    )
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 0.75,
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }
      }}
    >
      {cards.map((card) => (
        <CardArt key={card.cardId} card={card} />
      ))}
    </Box>
  )
}
