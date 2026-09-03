/**
 * The fork in the road when you add a deck: bring one in, or build one.
 *
 * Import sits on top because it is what almost everyone wants - the deck
 * already exists in the game, and retyping forty cards to reproduce it is not
 * a thing anyone does willingly. Building by hand is the honest second option,
 * not a hidden one, so it gets its own panel rather than a link.
 *
 * This is a doorway, not a destination. It used to resolve the code and then
 * show a preview - class, counts, card list, a name field, a save button -
 * which meant reading the same deck twice: once here, and again in the builder
 * that opened right afterwards. Resolving now goes straight through to the
 * builder, where every one of those things is already on screen and editable.
 *
 * # Why it is a drawer, and why there is only one of it
 *
 * It was an `AppDialog`, and the deck picker inside the match form had its own
 * separate `DeckFormDrawer` - a name field, a category select and a second copy
 * of the import box. So "add a deck" looked and behaved like two different
 * features depending on which screen you asked from, and the picker's version
 * could not reach the builder at all. There is now one component, in the same
 * drawer chrome as every other form in the app.
 *
 * What happens AFTER a deck arrives is the caller's business, and it genuinely
 * differs: the deck performance page opens the builder on it, while the match
 * form's picker just wants it selected so the user can get back to recording a
 * match. Hence `onOpenDeck` rather than a hard-wired next step.
 */
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Drawer,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined'
import CloseIcon from '@mui/icons-material/Close'
import LinkRoundedIcon from '@mui/icons-material/LinkRounded'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import ContentPasteRoundedIcon from '@mui/icons-material/ContentPasteRounded'
import type { ClassName } from '@shared/domain'
import type { ParsedDeckInput } from '@shared/deckImport'
import { DECK_NAME_MAX_LEN, suggestDeckName, type DeckImportPreview } from '@shared/deckImport'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import { classesMap } from '@renderer/map/classMap'
import React from 'react'
import { invokeIpc } from '@renderer/ipc'

import {
  BACKDROP_SX,
  BAR_SX,
  DRAWER_SURFACE_SX,
  HAIRLINE_BOTTOM,
  HAIRLINE_TOP
} from '@renderer/components/Common/surfaces'

function importErrorMessage(raw: string): string {
  if (raw.startsWith('INVALID_INPUT')) return '請貼上 4 碼牌組代碼、分享連結，或牌組 hash。'
  if (raw === 'NOT_FOUND_OR_EXPIRED')
    return '找不到這個牌組。牌組代碼在發行後 3 分鐘內有效，請回遊戲重新產生一組。'
  if (raw === 'NETWORK') return '連不上官方牌組網站，請確認網路連線後再試一次。'
  if (raw === 'UNEXPECTED_SHAPE') return '官方網站回傳了無法解析的內容，可能是網站改版了。'
  if (raw === 'DUPLICATE_NAME') return '同職業、同分類下已經有相同名稱的牌組了。'
  return raw
}

/**
 * The row under the field is always this tall, whether or not there is
 * anything in it.
 *
 * The clipboard offer arrives from an async check that lands after the dialog
 * has already been drawn, so anything that grows to hold it shoves the panel
 * below it down a moment after the user is looking at it. Reserving the line up
 * front costs one line of space and buys a dialog that never moves under the
 * cursor.
 */
const HINT_ROW_HEIGHT = 30

/** 標題列、內容與動作列對齊用的同一個左邊界，和其他抽屜一致。 */
const GUTTER = 2.5

export default function NewDeckDrawer({
  open,
  onClose,
  onOpenDeck,
  onBuildManually,
  klass,
  zIndex
}: {
  open: boolean
  onClose: () => void
  /** 剛匯入的——或本來就有的——那副牌組，交給呼叫端決定接下來做什麼。 */
  onOpenDeck: (deckId: number) => void
  /** 交給空白的建構器；這個抽屜會先關上。 */
  onBuildManually: () => void
  /**
   * 限定職業。
   *
   * 對局表單的牌組欄是「某一個職業的牌組」，匯進來一副別的職業的牌在那裡永遠是
   * 錯的，所以在這一關就擋下來並說清楚。牌組戰績沒有這個限制，也就不傳。
   */
  klass?: ClassName
  /** 疊在已經浮著的東西上面時要抬高——例如從對局表單抽屜裡打開。 */
  zIndex?: number
}) {
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /**
   * A deck code or link already sitting on the clipboard.
   *
   * Offered rather than pasted: silently filling a field with something the
   * user copied for another reason is the kind of helpfulness that reads as a
   * bug. Main only ever hands back the PARSED value, so nothing else that
   * happens to be on the clipboard crosses into the renderer.
   */
  const [clip, setClip] = React.useState<ParsedDeckInput | null>(null)

  React.useEffect(() => {
    if (!open) return
    setText('')
    setError(null)
    setBusy(false)
    setClip(null)

    // Checked once, on open - a user gesture - rather than polled.
    void invokeIpc('decks:clipboardCandidate')
      .then((res) => setClip(res?.ok ? res.data : null))
      .catch(() => setClip(null))
  }, [open])

  /**
   * Create the deck, and let the builder deal with everything after that.
   *
   * The name is only a starting point, so it is not worth stopping to ask for:
   * the builder has a name field and is a far better place to change it than a
   * dialog the user is passing through. The suggestion is class plus date, so
   * two decks of one class built on one day collide - that is a naming clash
   * and not a failure, so it numbers them instead of reporting it.
   */
  const importDeck = async (preview: DeckImportPreview): Promise<number> => {
    const base = suggestDeckName(classesMap[preview.className!].label, new Date())
    for (let attempt = 0; attempt < 20; attempt++) {
      const suffix = attempt === 0 ? '' : String(attempt + 1)
      const name = base.slice(0, DECK_NAME_MAX_LEN - suffix.length) + suffix
      const res = await invokeIpc('decks:import', { preview, name })
      if (res?.ok) return res.data.id as number

      const raw: string = res?.error ?? '匯入失敗'
      if (raw === 'DUPLICATE_NAME') continue
      // Someone imported the same deck between the preview and this call. The
      // deck exists either way, which is what was asked for.
      if (raw.startsWith('DUPLICATE_CONTENT:')) return Number(raw.split(':')[1])
      throw new Error(importErrorMessage(raw))
    }
    throw new Error('同職業下同一天已經有太多同名的牌組，請先整理一下再匯入。')
  }

  /**
   * `override` is what lets the clipboard chip resolve in a single click.
   *
   * Filling the field and then making the user press 解析 is two gestures for
   * one intention - they clicked the thing that says what is on their
   * clipboard. The text still lands in the field, so what happened stays
   * visible rather than being magic.
   */
  const handleResolve = async (override?: string): Promise<void> => {
    const input = (override ?? text).trim()
    if (!input) return
    if (override !== undefined) setText(override)
    setBusy(true)
    setError(null)
    try {
      const res = await invokeIpc('decks:importPreview', { text: input })
      if (!res?.ok) throw new Error(importErrorMessage(res?.error ?? 'UNEXPECTED_SHAPE'))

      const preview: DeckImportPreview = res.data.preview

      // 限定職業時先擋下來。存進去再說「這不是你要的職業」，使用者就得自己去
      // 牌組管理把它刪掉。
      if (klass && preview.className && preview.className !== klass) {
        throw new Error(
          `這是${classesMap[preview.className].label}牌組，和目前這一側的${classesMap[klass].label}不符。`
        )
      }

      // Already in the collection. Opening the copy we have is what "import
      // this deck" means when the deck is already here; a conflict dialog
      // would only invent a decision the user does not have to make.
      const existing: number | null = res.data.duplicateDeckId ?? null
      if (existing !== null) {
        onOpenDeck(existing)
        onClose()
        return
      }

      if (!preview.className) throw new Error(importErrorMessage('UNEXPECTED_SHAPE'))

      onOpenDeck(await importDeck(preview))
      onClose()
    } catch (err: any) {
      setError(err?.message ?? '解析失敗')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={busy ? undefined : onClose}
      sx={zIndex === undefined ? undefined : { zIndex }}
      slotProps={{
        backdrop: { sx: BACKDROP_SX },
        paper: {
          elevation: 0,
          sx: { ...DRAWER_SURFACE_SX, width: 'min(480px, calc(100vw - 32px))' }
        }
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* ---------- 標題列 ---------- */}
        <Box
          sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: GUTTER, pt: GUTTER, pb: 1.75, flexShrink: 0 }}
        >
          <Stack direction="row" alignItems="flex-start" spacing={1.5}>
            <Box
              sx={{
                display: 'grid',
                placeItems: 'center',
                width: 36,
                height: 36,
                borderRadius: 2,
                flexShrink: 0,
                color: 'text.secondary',
                bgcolor: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              {klass ? <ClassIcon id={klass} size={22} /> : <AddIcon fontSize="small" />}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="h6"
                component="h2"
                sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.3 }}
              >
                新增牌組
              </Typography>
              <Typography
                variant="caption"
                sx={{ display: 'block', color: 'text.secondary', mt: 0.25 }}
              >
                {klass
                  ? `貼上代碼帶一副${classesMap[klass].label}牌組進來，或自己組一副`
                  : '貼上代碼帶進來，或自己組一副'}
              </Typography>
            </Box>
            <IconButton
              size="small"
              onClick={onClose}
              disabled={busy}
              aria-label="關閉新增牌組"
              sx={{ color: 'text.secondary', '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' } }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
        </Box>

        {/* ---------- 內容 ---------- */}
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: GUTTER, py: 2.5 }}>
          {error && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
              {error}
            </Alert>
          )}

          {/* ---- import ---- */}
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              從遊戲或牌組網站把牌組帶進來
            </Typography>

            {/* One field with the action inside it, rather than a field and a
              button side by side: the two are a single gesture, and splitting
              them left a stranded button that was disabled most of the time. */}
            <TextField
              autoFocus
              fullWidth
              placeholder="貼上牌組代碼或分享連結"
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={busy}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleResolve()
                }
              }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <LinkRoundedIcon fontSize="small" sx={{ color: 'text.disabled' }} />
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      <Button
                        size="small"
                        variant="contained"
                        disableElevation
                        onClick={() => void handleResolve()}
                        disabled={busy || !text.trim()}
                        sx={{
                          minWidth: 64,
                          borderRadius: 1.5,
                          fontWeight: 800,
                          textTransform: 'none'
                        }}
                      >
                        {busy ? <CircularProgress size={16} color="inherit" /> : '解析'}
                      </Button>
                    </InputAdornment>
                  )
                }
              }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  borderRadius: 2.5,
                  bgcolor: 'rgba(255,255,255,0.04)',
                  pr: 0.75,
                  transition: 'background-color .15s, box-shadow .15s',
                  '& fieldset': { borderColor: 'rgba(255,255,255,0.10)' },
                  '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.20)' },
                  '&.Mui-focused': {
                    bgcolor: 'rgba(122,162,247,0.06)',
                    boxShadow: '0 0 0 3px rgba(122,162,247,0.16)'
                  },
                  '&.Mui-focused fieldset': { borderColor: 'rgba(122,162,247,0.7)' }
                }
              }}
            />

            {/* A fixed slot that is always there. It carries the clipboard offer
              when there is one and the format hint when there is not, so the
              offer landing never moves anything below it. */}
            <Box
              sx={{
                height: HINT_ROW_HEIGHT,
                mt: 0.75,
                display: 'flex',
                alignItems: 'center',
                minWidth: 0
              }}
            >
              {clip && !busy ? (
                <Box
                  onClick={() => void handleResolve(clip.value)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      void handleResolve(clip.value)
                    }
                  }}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.75,
                    maxWidth: '100%',
                    minWidth: 0,
                    height: 26,
                    pl: 1,
                    pr: 1.25,
                    borderRadius: 999,
                    cursor: 'pointer',
                    border: '1px solid rgba(122,162,247,0.35)',
                    bgcolor: 'rgba(122,162,247,0.10)',
                    color: 'primary.light',
                    transition: 'background-color .15s, border-color .15s',
                    '&:hover': {
                      bgcolor: 'rgba(122,162,247,0.2)',
                      borderColor: 'rgba(122,162,247,0.6)'
                    }
                  }}
                >
                  <ContentPasteRoundedIcon sx={{ fontSize: 15 }} />
                  {/* The code is shown because four characters are something a
                    person recognises. A hash is not - a tail like "…lO.ftEe"
                    is noise, so the chip only says that it is one. */}
                  <Typography variant="caption" sx={{ fontWeight: 700, minWidth: 0 }} noWrap>
                    貼上剪貼簿的
                    {clip.kind === 'code' ? '牌組代碼' : '分享連結'}
                    {clip.kind === 'code' && (
                      <Box
                        component="span"
                        sx={{ fontFamily: 'monospace', ml: 0.75, letterSpacing: 1 }}
                      >
                        {clip.value}
                      </Box>
                    )}
                  </Typography>
                </Box>
              ) : (
                <Typography variant="caption" sx={{ color: 'text.disabled' }} noWrap>
                  {busy ? '正在讀取牌組…' : '支援 4 碼牌組代碼、分享連結，或牌組 hash'}
                </Typography>
              )}
            </Box>
          </Box>

          {/* A labelled rule rather than a heading: it says "or instead of that"
            in one line, which is the entire relationship between the two. */}
          <Stack direction="row" alignItems="center" spacing={1.5} sx={{ my: 2 }}>
            <Box sx={{ flex: 1, height: 1, bgcolor: 'rgba(255,255,255,0.09)' }} />
            <Typography variant="caption" sx={{ color: 'text.disabled', letterSpacing: '0.1em' }}>
              或
            </Typography>
            <Box sx={{ flex: 1, height: 1, bgcolor: 'rgba(255,255,255,0.09)' }} />
          </Stack>

          {/* ---- manual ---- */}
          {/* The same dashed frame as the tile that opened this dialog, so the
            two read as the same offer at two depths rather than as two
            unrelated controls. */}
          <Box
            onClick={
              busy
                ? undefined
                : () => {
                    onClose()
                    onBuildManually()
                  }
            }
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClose()
                onBuildManually()
              }
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              px: 2,
              py: 1.75,
              borderRadius: 2.5,
              cursor: busy ? 'default' : 'pointer',
              border: '1px dashed rgba(255,255,255,0.22)',
              backgroundColor: 'rgba(255,255,255,0.015)',
              transition: 'border-color .15s, background-color .15s, color .15s',
              '&:hover': {
                borderColor: 'rgba(140,180,255,0.55)',
                backgroundColor: 'rgba(122,162,247,0.07)'
              }
            }}
          >
            <BuildOutlinedIcon sx={{ color: 'text.secondary' }} />
            <Box flex={1} minWidth={0}>
              <Typography variant="body2" fontWeight={800}>
                手動建立
              </Typography>
              <Typography variant="caption" color="text.secondary">
                從卡池一張一張挑，跟官方的牌組建構器一樣
              </Typography>
            </Box>
            <ChevronRightRoundedIcon sx={{ color: 'text.disabled' }} />
          </Box>
        </Box>

        {/* ---------- 動作列 ---------- */}
        <Box sx={{ ...BAR_SX, ...HAIRLINE_TOP, px: GUTTER, py: 1.75, flexShrink: 0 }}>
          <Stack direction="row" justifyContent="flex-end">
            {/* 只有一顆「取消」：這個抽屜沒有「送出」——兩個入口都是點了就走。
                但抽屜總得有個看得見的出口，而底部就是眼睛最後停的地方。 */}
            <Button
              onClick={onClose}
              disabled={busy}
              sx={{ textTransform: 'none', borderRadius: 2 }}
            >
              取消
            </Button>
          </Stack>
        </Box>
      </Box>
    </Drawer>
  )
}
