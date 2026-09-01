// Form drawer used by the match editor when it needs to create or amend a deck.
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Divider,
  TextField,
  MenuItem,
  FormControl,
  InputLabel,
  Select,
  Box,
  Drawer,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import type { ClassName } from '@shared/domain'
import { DECK_NAME_MAX_LEN, suggestDeckName, type DeckImportPreview } from '@shared/deckImport'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import { classesMap } from '@renderer/map/classMap'
import DeckCardList from '@renderer/components/DeckCards/DeckCardList'
import React from 'react'
import CloseIcon from '@mui/icons-material/Close'

type Category = { id: string; name: string }
type Option = { id: number; name: string; class: ClassName; categoryId: string | null }

/**
 * The main process hands back an error CODE, not a sentence, so the wording
 * lives here where the rest of the UI's Chinese does.
 *
 * `NOT_FOUND_OR_EXPIRED` has to cover both causes at once: a mistyped code and
 * one whose three minutes ran out produce an identical response, and the portal
 * will not say which.
 */
function importErrorMessage(raw: string): string {
  if (raw.startsWith('INVALID_INPUT')) return '請貼上 4 碼牌組代碼、分享連結，或牌組 hash。'
  if (raw === 'NOT_FOUND_OR_EXPIRED')
    return '找不到這個牌組。牌組代碼在發行後 3 分鐘內有效，請回遊戲重新產生一組。'
  if (raw === 'NETWORK') return '連不上官方牌組網站，請確認網路連線後再試一次。'
  if (raw === 'UNEXPECTED_SHAPE') return '官方網站回傳了無法解析的內容，可能是網站改版了。'
  if (raw === 'DUPLICATE_NAME') return '同職業、同分類下已經有相同名稱的牌組了。'
  return raw
}

/** Compact summary of what was parsed, so the user can confirm before saving. */
function ImportPreviewCard({ preview }: { preview: DeckImportPreview }) {
  const cards = React.useMemo(
    () => [...preview.cards].sort((a, b) => (a.cost ?? 99) - (b.cost ?? 99) || a.cardId - b.cardId),
    [preview]
  )

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ px: 1.5, py: 1.25, bgcolor: 'action.hover' }}
      >
        <Chip size="small" label={`${preview.totalCards} 張`} />
        <Chip size="small" variant="outlined" label={`從者 ${preview.counts.follower}`} />
        <Chip size="small" variant="outlined" label={`法術 ${preview.counts.spell}`} />
        <Chip size="small" variant="outlined" label={`護符 ${preview.counts.amulet}`} />
      </Stack>

      {/* Always the text rows here, never art: this is the confirmation step
          for a deck code that expires in three minutes, and waiting on forty
          image downloads is the wrong thing to do with that time. Art belongs
          in the deck view, once the deck is saved. */}
      <Box sx={{ maxHeight: 220, overflowY: 'auto' }}>
        <DeckCardList cards={cards} showImages={false} />
      </Box>
    </Box>
  )
}

export default function DeckFormDrawer({
  open,
  intent,
  initialDeck,
  deckClass,
  categories,
  initialCategoryId,
  onClose,
  onSubmitSuccess
}: {
  open: boolean
  intent: 'create' | 'edit'
  initialDeck: Option | null
  deckClass: ClassName
  categories: Category[]
  initialCategoryId?: string | ''
  onClose: () => void
  onSubmitSuccess: (deck: Option) => void
}) {
  const [deckName, setDeckName] = React.useState(initialDeck?.name ?? '')
  const [selectedCategoryId, setSelectedCategoryId] = React.useState<string | ''>(
    initialDeck?.categoryId ?? ''
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [importText, setImportText] = React.useState('')
  const [resolving, setResolving] = React.useState(false)
  const [preview, setPreview] = React.useState<DeckImportPreview | null>(null)
  const [duplicateDeckId, setDuplicateDeckId] = React.useState<number | null>(null)
  const [replaceDeckId, setReplaceDeckId] = React.useState<number | null>(null)

  const resetImport = React.useCallback(() => {
    setImportText('')
    setPreview(null)
    setDuplicateDeckId(null)
    setReplaceDeckId(null)
  }, [])

  React.useEffect(() => {
    if (open) {
      setDeckName(initialDeck?.name ?? '')
      if (intent === 'create') {
        setSelectedCategoryId(initialCategoryId ?? '')
      } else {
        setSelectedCategoryId(initialDeck?.categoryId ?? '')
      }
      setSaving(false)
      setError(null)
      resetImport()
    }
  }, [open, initialDeck, intent, initialCategoryId, resetImport])

  const handleResolve = async () => {
    const text = importText.trim()
    if (!text) return
    setResolving(true)
    setError(null)
    setPreview(null)
    setDuplicateDeckId(null)
    setReplaceDeckId(null)
    try {
      const res = await window.electron.ipcRenderer.invoke('decks:importPreview', { text })
      if (!res?.ok) throw new Error(res?.error ?? 'UNEXPECTED_SHAPE')

      const found: DeckImportPreview = res.data.preview

      // The drawer is opened for one class at a time and hands the created deck
      // straight back to that class's picker, so a deck of another class cannot
      // be saved here without the caller silently losing it.
      if (found.className && found.className !== deckClass) {
        setError(
          `這是${classesMap[found.className].label}牌組，與目前選擇的${classesMap[deckClass].label}不符。` +
            `請先切換到${classesMap[found.className].label}再匯入。`
        )
        return
      }

      setPreview(found)
      setDuplicateDeckId(res.data.duplicateDeckId ?? null)
      if (!deckName.trim() && found.className) {
        setDeckName(suggestDeckName(classesMap[found.className].label, new Date()))
      }
    } catch (err: any) {
      setError(importErrorMessage(err?.message ?? 'UNEXPECTED_SHAPE'))
    } finally {
      setResolving(false)
    }
  }

  const handleSave = async () => {
    const trimmed = deckName.trim()
    if (!trimmed) return setError('請輸入牌組名稱')
    setSaving(true)
    try {
      if (intent === 'create' && preview) {
        const res = await window.electron.ipcRenderer.invoke('decks:import', {
          preview,
          name: trimmed,
          categoryId: selectedCategoryId || null,
          replaceDeckId
        })
        if (!res?.ok) {
          const raw: string = res?.error ?? '匯入失敗'
          if (raw.startsWith('DUPLICATE_CONTENT:')) {
            setDuplicateDeckId(Number(raw.split(':')[1]))
            throw new Error('這副牌已經匯入過了，請選擇要更新既有牌組還是改個名字另存。')
          }
          throw new Error(importErrorMessage(raw))
        }
        onSubmitSuccess(res.data)
      } else if (intent === 'create') {
        const res = await window.electron.ipcRenderer.invoke('decks:create', {
          name: trimmed,
          class: deckClass,
          categoryId: selectedCategoryId || null
        })
        if (!res?.ok) throw new Error(importErrorMessage(res?.error ?? '建立失敗'))
        onSubmitSuccess(res.data)
      } else {
        const res = await window.electron.ipcRenderer.invoke('decks:update', {
          id: initialDeck!.id,
          name: trimmed,
          categoryId: selectedCategoryId || null
        })
        if (!res?.ok) throw new Error(res?.error ?? '更新失敗')
        onSubmitSuccess(res.data)
      }
      onClose()
    } catch (err: any) {
      setError(err?.message ?? '操作失敗')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      hideBackdrop
      sx={{ zIndex: (theme) => theme.zIndex.modal + 2 }}
      PaperProps={{
        sx: {
          width: 420,
          maxWidth: 'calc(100vw - 32px)',
          borderTopLeftRadius: 16,
          borderBottomLeftRadius: 16,
          boxShadow: 24,
          overflow: 'hidden'
        }
      }}
    >
      <Box sx={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
        <Box sx={{ px: 3, pt: 3, pb: 2.5 }}>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="h6" component="h2" fontWeight={700}>
                {intent === 'create' ? '新增牌組' : '編輯牌組'}
              </Typography>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75 }}>
                <ClassIcon id={deckClass} size={18} />
                <Typography variant="body2" color="text.secondary">
                  {classesMap[deckClass].label}牌組
                </Typography>
              </Stack>
            </Box>
            <IconButton onClick={onClose} disabled={saving} size="small" aria-label="關閉牌組編輯">
              <CloseIcon />
            </IconButton>
          </Stack>
        </Box>

        <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 1 }}>
          <Stack spacing={3}>
            {error && <Alert severity="error">{error}</Alert>}

            {intent === 'create' && (
              <Box>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
                  從遊戲匯入
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 1 }}
                >
                  貼上分享連結，或遊戲內的 4 碼牌組代碼（代碼發行後 3 分鐘內有效）。
                </Typography>
                <Stack direction="row" spacing={1}>
                  <TextField
                    fullWidth
                    size="small"
                    placeholder="ufj1 或 https://shadowverse-wb.com/…"
                    value={importText}
                    onChange={(event) => setImportText(event.target.value)}
                    disabled={saving || resolving}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void handleResolve()
                      }
                    }}
                  />
                  <Button
                    variant="outlined"
                    onClick={() => void handleResolve()}
                    disabled={saving || resolving || !importText.trim()}
                    sx={{ flexShrink: 0 }}
                  >
                    {resolving ? <CircularProgress size={18} /> : '解析'}
                  </Button>
                </Stack>

                {preview && (
                  <Stack spacing={1} sx={{ mt: 1.5 }}>
                    {preview.partial && (
                      <Alert severity="warning">
                        部分卡片資料讀不到，仍可建立牌組，但卡表會缺少細節。
                      </Alert>
                    )}
                    {duplicateDeckId !== null && (
                      <Alert
                        severity="info"
                        action={
                          <Button
                            size="small"
                            onClick={() =>
                              setReplaceDeckId(replaceDeckId === null ? duplicateDeckId : null)
                            }
                          >
                            {replaceDeckId === null ? '改為更新' : '取消更新'}
                          </Button>
                        }
                      >
                        {replaceDeckId === null
                          ? '你已經有一副相同內容的牌組。'
                          : '將更新既有的那一副牌組。'}
                      </Alert>
                    )}
                    <ImportPreviewCard preview={preview} />
                  </Stack>
                )}
                <Divider sx={{ mt: 2.5 }} />
              </Box>
            )}

            <Box>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                基本資料
              </Typography>
              <TextField
                autoFocus
                fullWidth
                label="牌組名稱"
                value={deckName}
                onChange={(event) => setDeckName(event.target.value)}
                disabled={saving}
                slotProps={{ htmlInput: { maxLength: DECK_NAME_MAX_LEN } }}
                helperText={`${deckName.length}/${DECK_NAME_MAX_LEN}`}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void handleSave()
                  }
                }}
              />
            </Box>

            <Box>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                牌組分類
              </Typography>
              <FormControl fullWidth disabled={saving}>
                <InputLabel>選擇分類</InputLabel>
                <Select
                  label="選擇分類"
                  value={selectedCategoryId}
                  onChange={(event) => setSelectedCategoryId(event.target.value as string)}
                >
                  {categories.map((category) => (
                    <MenuItem key={category.id} value={category.id}>
                      {category.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
          </Stack>
        </Box>

        <Box sx={{ borderTop: 1, borderColor: 'divider', px: 3, py: 2.5 }}>
          <Stack direction="row" justifyContent="flex-end" spacing={1}>
            <Button onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button
              variant="contained"
              onClick={() => void handleSave()}
              disabled={saving || !deckName.trim()}
            >
              {saving
                ? '儲存中…'
                : intent !== 'create'
                  ? '儲存變更'
                  : replaceDeckId !== null
                    ? '更新牌組'
                    : preview
                      ? '匯入牌組'
                      : '建立牌組'}
            </Button>
          </Stack>
        </Box>
      </Box>
    </Drawer>
  )
}
