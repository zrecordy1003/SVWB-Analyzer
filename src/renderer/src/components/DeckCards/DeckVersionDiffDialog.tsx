/**
 * "What did this version change?" - the card diff between two versions.
 *
 * This is the thing the version history exists for: after swapping two cards
 * the user wants to see those two cards next to each version's record, not two
 * forty-card lists to compare by eye. Both card lists are read through the
 * existing `decks:cards` and diffed here (`diffDeckCards`); nothing new is
 * stored for it.
 *
 * Added and removed cards reuse `DeckCardList`, so they look exactly like a
 * deck's contents elsewhere (banner art when card images are on, text rows when
 * they are off). A copy-count change gets its own row, because "3 -> 2" is one
 * fact and neither list can say it.
 */
import { Alert, Box, Chip, Skeleton, Stack, Typography } from '@mui/material'
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded'
import { cardImageUrl, type StoredDeckCard } from '@shared/deckImport'
import AppDialog from '@renderer/components/Common/AppDialog'
import React from 'react'

import DeckCardList from './DeckCardList'
import {
  diffCopyCounts,
  diffDeckCards,
  isEmptyDiff,
  versionLabel,
  type DeckCardDiff
} from './deckVersions'

export type DiffEndpoint = { id: number; number: number }

async function readCards(deckId: number): Promise<StoredDeckCard[]> {
  const res = await window.electron.ipcRenderer.invoke('decks:cards', { deckId })
  if (!res?.ok) throw new Error(res?.error ?? '讀取卡表失敗')
  return res.data as StoredDeckCard[]
}

function SectionTitle({
  label,
  count,
  tone
}: {
  label: string
  count: number
  tone: 'success' | 'error' | 'warning'
}): React.JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
      <Typography variant="subtitle2" fontWeight={800}>
        {label}
      </Typography>
      <Chip
        size="small"
        color={tone}
        variant="outlined"
        label={`${count} 種`}
        sx={{ height: 20 }}
      />
    </Stack>
  )
}

function ChangedRow({
  card,
  from,
  to,
  showImages
}: {
  card: StoredDeckCard
  from: number
  to: number
  showImages: boolean
}): React.JSX.Element {
  const art = showImages ? cardImageUrl('list', card.bannerHash) : null
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      data-testid={`deck-diff-changed-${card.cardId}`}
      sx={{
        px: 1.25,
        py: 0.6,
        borderRadius: 1,
        border: '1px solid rgba(255,255,255,0.08)',
        position: 'relative',
        overflow: 'hidden'
      }}
    >
      {art && (
        <Box
          component="img"
          src={art}
          alt=""
          loading="lazy"
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: '85% center',
            opacity: 0.35
          }}
        />
      )}
      <Box
        sx={{
          position: 'relative',
          minWidth: 22,
          textAlign: 'center',
          fontSize: 12,
          fontWeight: 800,
          color: 'text.secondary'
        }}
      >
        {card.cost ?? '?'}
      </Box>
      <Typography variant="body2" noWrap sx={{ position: 'relative', flex: 1, fontWeight: 700 }}>
        {card.name}
      </Typography>
      <Typography
        variant="caption"
        sx={{ position: 'relative', fontVariantNumeric: 'tabular-nums', fontWeight: 800 }}
      >
        ×{from}
        <Box component="span" sx={{ mx: 0.5, opacity: 0.6 }}>
          →
        </Box>
        <Box component="span" sx={{ color: to > from ? 'success.light' : 'error.light' }}>
          ×{to}
        </Box>
      </Typography>
    </Stack>
  )
}

export default function DeckVersionDiffDialog({
  open,
  deckName,
  from,
  to,
  zIndex,
  onClose
}: {
  open: boolean
  deckName: string
  /** The older version. */
  from: DiffEndpoint | null
  /** The newer version. */
  to: DiffEndpoint | null
  zIndex?: number
  onClose: () => void
}): React.JSX.Element {
  const [diff, setDiff] = React.useState<DeckCardDiff<StoredDeckCard> | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showImages, setShowImages] = React.useState(false)

  React.useEffect(() => {
    if (!open || !from || !to) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setDiff(null)
    void (async () => {
      try {
        const [prev, next, settings] = await Promise.all([
          readCards(from.id),
          readCards(to.id),
          window.settings.get('settings').catch(() => null)
        ])
        if (cancelled) return
        setDiff(diffDeckCards(prev, next))
        setShowImages(Boolean(settings?.cardImages))
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? '讀取卡表失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, from, to])

  const copies = diff ? diffCopyCounts(diff) : null

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={deckName}
      subtitle={
        from && to
          ? `${versionLabel(from.number)} → ${versionLabel(to.number)} 的卡表差異`
          : undefined
      }
      icon={<CompareArrowsRoundedIcon fontSize="small" />}
      zIndex={zIndex}
      maxWidth="sm"
      headerExtra={
        copies ? (
          <Stack direction="row" spacing={0.75} data-testid="deck-diff-summary">
            <Chip
              size="small"
              color="success"
              variant="outlined"
              label={`加入 ${copies.added} 張`}
              sx={{ height: 20 }}
            />
            <Chip
              size="small"
              color="error"
              variant="outlined"
              label={`移除 ${copies.removed} 張`}
              sx={{ height: 20 }}
            />
            {diff && (
              <Chip
                size="small"
                variant="outlined"
                label={`未變 ${diff.unchanged} 種`}
                sx={{ height: 20 }}
              />
            )}
          </Stack>
        ) : undefined
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ maxHeight: '56vh', overflowY: 'auto', mx: -0.5, px: 0.5 }}>
        {loading || !diff ? (
          <Stack spacing={0.75}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} variant="rounded" height={36} />
            ))}
          </Stack>
        ) : isEmptyDiff(diff) ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ py: 3, textAlign: 'center' }}
            data-testid="deck-diff-empty"
          >
            這兩個版本的卡表相同。
          </Typography>
        ) : (
          <Stack spacing={2.5} data-testid="deck-diff-body">
            {diff.added.length > 0 && (
              <Box data-testid="deck-diff-added">
                <SectionTitle label="加入" count={diff.added.length} tone="success" />
                <DeckCardList cards={diff.added} showImages={showImages} />
              </Box>
            )}
            {diff.removed.length > 0 && (
              <Box data-testid="deck-diff-removed">
                <SectionTitle label="移除" count={diff.removed.length} tone="error" />
                <DeckCardList cards={diff.removed} showImages={showImages} />
              </Box>
            )}
            {diff.changed.length > 0 && (
              <Box>
                <SectionTitle label="張數變化" count={diff.changed.length} tone="warning" />
                <Stack spacing={0.5}>
                  {diff.changed.map(({ card, from: f, to: t }) => (
                    <ChangedRow
                      key={card.cardId}
                      card={card}
                      from={f}
                      to={t}
                      showImages={showImages}
                    />
                  ))}
                </Stack>
              </Box>
            )}
          </Stack>
        )}
      </Box>
    </AppDialog>
  )
}
