/**
 * A deck's card list, on demand.
 *
 * Fetches only while open, because most decks are never inspected and the card
 * art behind `svwb-card://` is downloaded lazily by the images themselves - a
 * drawer that never opens costs nothing at all.
 *
 * A drawer rather than the `AppDialog` this used to be: the point of opening a
 * deck is to look at its cards, and `DeckCardBoard` wants to lay those out the
 * way the game's own deck page does - large portraits, sorted by cost, a wide
 * row per kind. A ~600px-wide dialog crushes that into a cramped 2-across
 * grid; a drawer gets the width a card wall actually needs while still
 * leaving the deck list it was opened from in view behind it.
 */
import { Alert, Box, Button, Drawer, IconButton, Stack, Typography } from '@mui/material'
import { ThemeProvider, createTheme, useTheme } from '@mui/material/styles'
import CloseIcon from '@mui/icons-material/Close'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import QrCode2RoundedIcon from '@mui/icons-material/QrCode2Rounded'
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined'
import type { StoredDeckCard } from '@shared/deckImport'
import React from 'react'

import {
  BACKDROP_SX,
  BAR_SX,
  DRAWER_SURFACE_SX,
  HAIRLINE_BOTTOM,
  HAIRLINE_TOP
} from '@renderer/components/Common/surfaces'

import DeckCardBoard from './DeckCardBoard'
import DeckCodeDialog from './DeckCodeDialog'
import ManaCurve from './ManaCurve'
import DeckBuilder from '@renderer/components/DeckBuilder/DeckBuilder'

/** 標題列、內容與動作列對齊用的同一個左邊界，和其他抽屜一致。 */
const GUTTER = 2.5

export default function DeckContentsDrawer({
  open,
  deckId,
  deckName,
  categories = [],
  onClose,
  onSaved,
  zIndex
}: {
  open: boolean
  deckId: number | null
  deckName: string
  /** Passed through to the editor, so a category can be changed while editing. */
  categories?: { id: string; name: string }[]
  onClose: () => void
  /** Called after an edit is saved, so the caller can refresh its own list. */
  onSaved?: () => void
  /**
   * 疊在已經浮著的東西上面時的底層。
   *
   * 牌組戰績是從頁面開的，1250 那個預設就對；牌組管理是從一個 1500 的抽屜裡
   * 開的，不抬高整個抽屜會開在它後面。從這裡再開出去的建構器與代碼對話框跟著
   * 往上一階——它們是這個抽屜的下一層，不是它的背景。
   */
  zIndex?: number
}) {
  const [cards, setCards] = React.useState<StoredDeckCard[]>([])
  const [loading, setLoading] = React.useState(false)
  const [showImages, setShowImages] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadKey, setReloadKey] = React.useState(0)
  const [publishing, setPublishing] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  /**
   * Which row this drawer is actually showing.
   *
   * Starts as `deckId`, but an edit that forks (the deck has been played)
   * writes a NEW row and leaves `deckId` pointing at the old card list. The
   * user is looking at the list they just changed, so the drawer follows the
   * saved row rather than re-reading the frozen one.
   */
  const [viewDeckId, setViewDeckId] = React.useState<number | null>(deckId)
  React.useEffect(() => {
    setViewDeckId(deckId)
  }, [deckId, open])

  React.useEffect(() => {
    if (!open || viewDeckId == null) return
    let cancelled = false

    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const [res, settings] = await Promise.all([
          window.electron.ipcRenderer.invoke('decks:cards', { deckId: viewDeckId }),
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
  }, [open, viewDeckId, reloadKey])

  const hasCards = !loading && cards.length > 0

  /**
   * 卡牆上每張卡的能力 tooltip 走 MUI 預設的 `theme.zIndex.tooltip`
   * （1500）。這個抽屜常被抬到 1500 以上打開（例如牌組管理是 1540），這時
   * tooltip 反而疊在抽屜底下、滑過卡片什麼都看不到。做法和 `DeckBuilder`
   * 抬高巢狀 Popover 一樣：套一層只改 `zIndex.tooltip` 的巢狀主題。
   */
  const outerTheme = useTheme()
  const layeredTheme = React.useMemo(
    () =>
      zIndex === undefined ? null : createTheme(outerTheme, { zIndex: { tooltip: zIndex + 10 } }),
    [outerTheme, zIndex]
  )

  const drawer = (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      // 沒設的話會落在 MUI 預設的 `zIndex.drawer`（1200），疊在 App 頂部那條
      // 固定 AppBar（`zIndex.drawer + 1` = 1201）底下 - 抽屜上緣正好被工具列蓋掉
      // 一截。抬到工具列之上，同時仍留在 `DeckBuilder`／`DeckCodeDialog` 這兩個
      // 從裡面打開的 Dialog（預設 1300）之下。
      sx={{ zIndex: zIndex ?? 1250 }}
      slotProps={{
        backdrop: { sx: BACKDROP_SX },
        paper: {
          elevation: 0,
          // 這一頁的重點是卡牆本身 - 兩欄小圖塞不下官方那種一眼看完整條費用曲線
          // 的排法，所以寬度比其他抽屜都寬，但仍留一截牌組列表在背後，讓人記得
          // 自己是從哪裡點進來的。
          sx: { ...DRAWER_SURFACE_SX, width: 'min(1040px, calc(100vw - 96px))' }
        }
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* ---------- 標題列 ---------- */}
        <Box
          sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: GUTTER, pt: GUTTER, pb: 1.75, flexShrink: 0 }}
        >
          <Stack direction="row" alignItems="center" spacing={2}>
            {/* 官方牌組頁的左欄：牌名在上，分享／編輯在下。這欄不吃剩餘空間 -
                中間要留給費用曲線，太長的牌名就用 `noWrap` 收掉，跟官方那頁
                固定寬度左欄的做法一樣。 */}
            <Box sx={{ minWidth: 0, flexShrink: 0, maxWidth: 260 }}>
              <Typography
                variant="h6"
                component="h2"
                noWrap
                sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.3 }}
              >
                {deckName}
              </Typography>
              {/* 這副牌真的會動到的兩件事，貼著標題一起先看到 - 原本擠在底部
                  動作列，離牌名最遠、離視線最後，而它們才是打開這個抽屜最常見
                  的兩個理由。設定性質的「顯示卡圖」留在底部，不跟著搬上來。 */}
              {hasCards && (
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<QrCode2RoundedIcon sx={{ fontSize: 17 }} />}
                    onClick={() => setPublishing(true)}
                    sx={{
                      borderRadius: 999,
                      textTransform: 'none',
                      fontWeight: 700,
                      px: 1.75,
                      color: 'text.secondary',
                      borderColor: 'rgba(255,255,255,0.16)',
                      transition: 'border-color .15s, background-color .15s, color .15s',
                      '&:hover': {
                        borderColor: 'rgba(255,255,255,0.32)',
                        bgcolor: 'rgba(255,255,255,0.05)',
                        color: 'text.primary'
                      }
                    }}
                  >
                    發行牌組代碼
                  </Button>
                  <Button
                    variant="contained"
                    disableElevation
                    size="small"
                    startIcon={<EditOutlinedIcon sx={{ fontSize: 17 }} />}
                    onClick={() => setEditing(true)}
                    sx={{
                      borderRadius: 999,
                      textTransform: 'none',
                      fontWeight: 800,
                      px: 1.75,
                      boxShadow: '0 4px 16px -6px rgba(122,162,247,0.65)',
                      transition: 'box-shadow .15s, transform .15s',
                      '&:hover': {
                        boxShadow: '0 6px 20px -6px rgba(122,162,247,0.8)',
                        transform: 'translateY(-1px)'
                      }
                    }}
                  >
                    編輯牌組
                  </Button>
                </Stack>
              )}
            </Box>

            {/* 費用曲線放在牌名和關閉鍵中間，跟官方牌組頁同一個位置 - 那一頁
                把它擺在標題列正中央，兩側才是可以互動的東西（分享／編輯在
                左，QR Code 在右）。 */}
            {hasCards && (
              <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: 0 }}>
                <Box sx={{ width: '100%', maxWidth: 400 }}>
                  <ManaCurve cards={cards} height={40} statsPlacement="right" />
                </Box>
              </Box>
            )}

            <IconButton
              size="small"
              onClick={onClose}
              aria-label="關閉牌組內容"
              sx={{ color: 'text.secondary', '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' } }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
        </Box>

        {/* ---------- 內容 ---------- */}
        {/* 直向 flex：錯誤提示照原本高度撐開，卡片區吃掉剩下的高度 - 這樣
            `DeckCardBoard` 拿到的是一個有限高度的容器，才能用 `auto-fill`
            照高度決定要排幾列，而不是被外層的 `overflowY: auto` 直接壓成
            內容自己的高度。 */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            px: GUTTER,
            py: 2.5
          }}
        >
          {error && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: 2, flexShrink: 0 }}>
              {error}
            </Alert>
          )}

          <Box sx={{ flex: 1, minHeight: 0 }}>
            <DeckCardBoard cards={cards} showImages={showImages} loading={loading} />
          </Box>
        </Box>

        {/* ---------- 動作列 ---------- */}
        {/* 開卡圖是設定，不是對這副牌做的動作，所以留在底部自己一排，不跟已經
            搬到標題下面的那兩顆真的會動到牌組的按鈕擠在一起。設定開了以後這
            排就沒有東西可畫，整條列就不出現。 */}
        {hasCards && !showImages && (
          <Box sx={{ ...BAR_SX, ...HAIRLINE_TOP, px: GUTTER, py: 1.25, flexShrink: 0 }}>
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
          </Box>
        )}
      </Box>

      <DeckBuilder
        open={editing}
        deckId={viewDeckId}
        categories={categories}
        zIndex={zIndex === undefined ? undefined : zIndex + 10}
        onClose={() => setEditing(false)}
        onSaved={(saved) => {
          // Refresh this drawer too: the user is looking at the list they just
          // changed, and leaving the old one up would read as a failed save.
          // Follow the saved row - a fork is a new id.
          setViewDeckId(saved.id)
          setReloadKey((n) => n + 1)
          onSaved?.()
        }}
      />

      <DeckCodeDialog
        open={publishing}
        deckId={viewDeckId}
        deckName={deckName}
        zIndex={zIndex === undefined ? undefined : zIndex + 10}
        onClose={() => setPublishing(false)}
      />
    </Drawer>
  )

  return layeredTheme ? <ThemeProvider theme={layeredTheme}>{drawer}</ThemeProvider> : drawer
}
