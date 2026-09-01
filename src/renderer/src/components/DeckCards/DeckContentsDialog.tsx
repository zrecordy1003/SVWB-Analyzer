/**
 * A deck's card list, on demand.
 *
 * Fetches only while open, because most decks are never inspected and the card
 * art behind `svwb-card://` is downloaded lazily by the images themselves - a
 * dialog that never opens costs nothing at all.
 *
 * Built on `AppDialog`, which owns the chrome. The layout here is only about
 * where this deck's own three things go: what the deck is (header), what is in
 * it (body), and what you can do with it (footer). Those used to be stacked
 * into one scrolling column, so the buttons drifted with the card list and
 * every deck put them somewhere slightly different.
 */
import { Alert, Box, Button, Chip, Stack } from '@mui/material'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import QrCode2RoundedIcon from '@mui/icons-material/QrCode2Rounded'
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined'
import type { StoredDeckCard } from '@shared/deckImport'
import AppDialog from '@renderer/components/Common/AppDialog'
import React from 'react'

import DeckCardList from './DeckCardList'
import DeckCodeDialog from './DeckCodeDialog'
import DeckBuilder from '@renderer/components/DeckBuilder/DeckBuilder'

export default function DeckContentsDialog({
  open,
  deckId,
  deckName,
  categories = [],
  onClose,
  onSaved
}: {
  open: boolean
  deckId: number | null
  deckName: string
  /** Passed through to the editor, so a category can be changed while editing. */
  categories?: { id: string; name: string }[]
  onClose: () => void
  /** Called after an edit is saved, so the caller can refresh its own list. */
  onSaved?: () => void
}) {
  const [cards, setCards] = React.useState<StoredDeckCard[]>([])
  const [loading, setLoading] = React.useState(false)
  const [showImages, setShowImages] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadKey, setReloadKey] = React.useState(0)
  const [publishing, setPublishing] = React.useState(false)
  const [editing, setEditing] = React.useState(false)

  React.useEffect(() => {
    if (!open || deckId == null) return
    let cancelled = false

    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const [res, settings] = await Promise.all([
          window.electron.ipcRenderer.invoke('decks:cards', { deckId }),
          window.settings.get('settings')
        ])
        if (cancelled) return
        if (!res?.ok) throw new Error(res?.error ?? '讀取卡表失敗')
        setCards(res.data)
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
  }, [open, deckId, reloadKey])

  const total = cards.reduce((sum, c) => sum + c.count, 0)
  const counts = cards.reduce(
    (acc, c) => {
      if (c.kind) acc[c.kind] += c.count
      return acc
    },
    { follower: 0, spell: 0, amulet: 0 }
  )

  const hasCards = !loading && cards.length > 0

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={deckName}
      headerExtra={
        total > 0 ? (
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`${total} 張`} sx={{ fontWeight: 700 }} />
            <Chip size="small" variant="outlined" label={`從者 ${counts.follower}`} />
            <Chip size="small" variant="outlined" label={`法術 ${counts.spell}`} />
            <Chip size="small" variant="outlined" label={`護符 ${counts.amulet}`} />
          </Stack>
        ) : undefined
      }
      actions={
        hasCards ? (
          <>
            {/* Turning card art on is a setting, not an action on this deck, so
                it stays on the quiet side of the footer rather than lining up
                with the two buttons that actually do something to the deck. */}
            {!showImages && (
              <Button
                size="small"
                startIcon={<ImageOutlinedIcon />}
                onClick={() => {
                  void window.settings
                    .set('settings.cardImages', true)
                    .then(() => setShowImages(true))
                }}
                sx={{ color: 'text.secondary', textTransform: 'none' }}
              >
                顯示卡圖
              </Button>
            )}
            <Box sx={{ flex: 1 }} />
            {/* Sending the deck back to the game is the point of holding a card
                list at all, so it sits with the cards rather than in a menu. */}
            <Button
              variant="outlined"
              startIcon={<QrCode2RoundedIcon />}
              onClick={() => setPublishing(true)}
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
            >
              發行牌組代碼
            </Button>
            <Button
              variant="contained"
              disableElevation
              startIcon={<EditOutlinedIcon />}
              onClick={() => setEditing(true)}
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
            >
              編輯牌組
            </Button>
          </>
        ) : undefined
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
          {error}
        </Alert>
      )}

      {/* The list scrolls inside a fixed frame instead of growing the dialog.
          A forty-card deck and a four-card one otherwise open two dialogs of
          very different heights, and the footer buttons land somewhere new
          each time. */}
      <Box sx={{ maxHeight: '52vh', overflowY: 'auto', mx: -0.5, px: 0.5 }}>
        <DeckCardList cards={cards} showImages={showImages} loading={loading} />
      </Box>

      <DeckBuilder
        open={editing}
        deckId={deckId}
        categories={categories}
        onClose={() => setEditing(false)}
        onSaved={() => {
          // Refresh this dialog too: the user is looking at the list they just
          // changed, and leaving the old one up would read as a failed save.
          setReloadKey((n) => n + 1)
          onSaved?.()
        }}
      />

      <DeckCodeDialog
        open={publishing}
        deckId={deckId}
        deckName={deckName}
        onClose={() => setPublishing(false)}
      />
    </AppDialog>
  )
}
