/* eslint-disable @typescript-eslint/no-explicit-any */
// src/renderer/components/matches/DeckEditDialog.tsx
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  MenuItem,
  FormControl,
  InputLabel,
  Select,
  Box
} from '@mui/material'
import type { ClassName } from '@prisma/client'
import { classesMap } from '@renderer/map/classMap'
import React from 'react'

type Category = { id: string; name: string }
type Option = { id: number; name: string; class: ClassName; categoryId: string | null }

export default function DeckEditDialog({
  open,
  mode,
  init,
  klass,
  categories,
  defaultCategoryId, // ⬅️ 新增：建立時的預設分類
  onClose,
  onSaved
}: {
  open: boolean
  mode: 'create' | 'edit'
  init: Option | null
  klass: ClassName
  categories: Category[]
  defaultCategoryId?: string | '' // ⬅️ 新增
  onClose: () => void
  onSaved: (deck: Option) => void
}) {
  const [name, setName] = React.useState(init?.name ?? '')
  const [categoryId, setCategoryId] = React.useState<string | ''>(init?.categoryId ?? '')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setName(init?.name ?? '')
      // create 模式：優先帶入 defaultCategoryId；edit 模式：帶入 init.categoryId
      if (mode === 'create') {
        setCategoryId(defaultCategoryId ?? '')
      } else {
        setCategoryId(init?.categoryId ?? '')
      }
      setSaving(false)
    }
  }, [open, init, mode, defaultCategoryId])

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      if (mode === 'create') {
        const res = await window.electron.ipcRenderer.invoke('decks:create', {
          name: trimmed,
          class: klass,
          categoryId: categoryId || null
        })
        if (!res?.ok) throw new Error(res?.error ?? '建立失敗')
        onSaved(res.data)
      } else {
        const res = await window.electron.ipcRenderer.invoke('decks:update', {
          id: init!.id,
          name: trimmed,
          categoryId: categoryId || null
        })
        if (!res?.ok) throw new Error(res?.error ?? '更新失敗')
        onSaved(res.data)
      }
      onClose()
    } catch (err: any) {
      alert(err?.message ?? '操作失敗')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle bgcolor={'#1d1d1d'}>{mode === 'create' ? '新增牌組' : '編輯牌組'}</DialogTitle>
      <DialogContent dividers sx={{ bgcolor: '#1d1d1d' }}>
        <Box display={'flex'} flexDirection={'column'} gap={2} m={1}>
          <FormControl size="small" disabled>
            <TextField size="small" label="職業" value={classesMap[klass].label} disabled />
          </FormControl>
          <FormControl size="small" disabled={saving}>
            <InputLabel>分類</InputLabel>
            <Select
              label="分類"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value as string)}
            >
              {/* <MenuItem disabled value="">
              （未分類）
            </MenuItem> */}
              {categories.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            autoFocus
            label="牌組名稱"
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="small"
            disabled={saving}
            slotProps={{
              htmlInput: { maxLength: 8 }
            }}
            helperText={`${name.length}/8`}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ bgcolor: '#1d1d1d' }}>
        <Button onClick={onClose} disabled={saving}>
          取消
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? '儲存中…' : '儲存'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
