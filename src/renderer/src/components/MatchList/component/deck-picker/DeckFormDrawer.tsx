// Form drawer used by the match editor when it needs to create or amend a deck.
import {
  Alert,
  Button,
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
import { classesMap } from '@renderer/map/classMap'
import React from 'react'
import CloseIcon from '@mui/icons-material/Close'

type Category = { id: string; name: string }
type Option = { id: number; name: string; class: ClassName; categoryId: string | null }

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
    }
  }, [open, initialDeck, intent, initialCategoryId])

  const handleSave = async () => {
    const trimmed = deckName.trim()
    if (!trimmed) return setError('請輸入牌組名稱')
    setSaving(true)
    try {
      if (intent === 'create') {
        const res = await window.electron.ipcRenderer.invoke('decks:create', {
          name: trimmed,
          class: deckClass,
          categoryId: selectedCategoryId || null
        })
        if (!res?.ok) throw new Error(res?.error ?? '建立失敗')
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
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    bgcolor: classesMap[deckClass].color
                  }}
                />
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
                slotProps={{ htmlInput: { maxLength: 8 } }}
                helperText={`${deckName.length}/8`}
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
              {saving ? '儲存中…' : intent === 'create' ? '建立牌組' : '儲存變更'}
            </Button>
          </Stack>
        </Box>
      </Box>
    </Drawer>
  )
}
