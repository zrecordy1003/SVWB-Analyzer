// src/renderer/components/matches/DeckPicker.tsx
import React, { useEffect, useMemo, useState } from 'react'
import {
  Autocomplete,
  Box,
  Chip,
  CircularProgress,
  ListSubheader,
  TextField,
  Typography,
  Divider
} from '@mui/material'
import { ClassName } from '@prisma/client'
import { classesMap } from '@renderer/map/classMap'

type DeckRow = { id: number; name: string; class: ClassName; categoryId: string | null }
type Category = { id: string; name: string }
type Option = DeckRow & { categoryName: string }

type Props = {
  label: string
  klass?: ClassName
  value: number | null | undefined
  onChange: (id: number | null) => void
}

const UNCATEGORIZED = '未分類'

const ClassDot = ({ klass }: { klass?: ClassName }) => (
  <Box
    sx={{
      width: 10,
      height: 10,
      borderRadius: '50%',
      bgcolor: klass ? classesMap[klass]?.color : 'text.disabled',
      mr: 1
    }}
  />
)

const DeckPicker: React.FC<Props> = ({ label, klass, value, onChange }) => {
  const [loading, setLoading] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const [decks, setDecks] = useState<DeckRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!klass) {
      setCategories([])
      setDecks([])
      return
    }
    let mounted = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        // 後端仍回 { categories, decks }；帶入 klass 讓後端就地過濾（若後端還沒做，就會回全部，前端會再過濾一次）
        const res = await window.electron.ipcRenderer.invoke('decks:list', klass)
        if (res?.error) throw new Error(String(res.error))
        const cats: Category[] = Array.isArray(res?.categories) ? res.categories : []
        const dks: DeckRow[] = Array.isArray(res?.decks)
          ? res.decks.map((d: any) => ({
              id: Number(d.id),
              name: String(d.name),
              class: d.class as ClassName,
              categoryId: d.categoryId ?? null
            }))
          : []
        if (!mounted) return
        setCategories(cats)
        // 前端再保險過濾一次，**只保留對應職業**
        setDecks(dks.filter((d) => d.class === klass))
      } catch (e: any) {
        if (mounted) {
          setError(e?.message ?? '取得牌組清單失敗')
          setCategories([])
          setDecks([])
        }
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [klass])

  const options: Option[] = useMemo(() => {
    const catName = new Map(categories.map((c) => [c.id, c.name]))
    const arr = decks.map((d) => ({
      ...d,
      categoryName: d.categoryId ? (catName.get(d.categoryId) ?? UNCATEGORIZED) : UNCATEGORIZED
    }))
    arr.sort((a, b) => {
      if (a.categoryName !== b.categoryName)
        return a.categoryName.localeCompare(b.categoryName, 'zh-TW')
      return a.name.localeCompare(b.name, 'zh-TW')
    })
    return arr
  }, [categories, decks])

  const selected = options.find((o) => o.id === value) ?? null

  // 若還沒選職業：禁用 + 提示
  if (!klass) {
    return (
      <TextField
        label={label}
        size="small"
        disabled
        placeholder="請先選擇職業"
        helperText="選擇職業後會顯示對應牌組"
        fullWidth
      />
    )
  }

  return (
    <Autocomplete
      value={selected}
      onChange={(_e, v) => onChange(v?.id ?? null)}
      options={options}
      loading={loading}
      groupBy={(o) => o.categoryName}
      renderGroup={(params) => (
        <Box key={params.key}>
          <ListSubheader disableSticky>
            <Typography variant="subtitle2" sx={{ pl: 1, py: 0.5 }}>
              {params.group}
            </Typography>
          </ListSubheader>
          <Divider />
          {params.children}
        </Box>
      )}
      getOptionLabel={(o) => o.name}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      renderOption={(props, option) => (
        <Box component="li" {...props} sx={{ display: 'flex', alignItems: 'center' }}>
          <ClassDot klass={option.class} />
          <Typography sx={{ flex: 1 }}>{option.name}</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={classesMap[option.class]?.label ?? option.class}
            sx={{ ml: 1 }}
          />
        </Box>
      )}
      noOptionsText={loading ? '載入中…' : '此職業尚無牌組'}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          size="small"
          error={!!error}
          helperText={error ?? ''}
          fullWidth
        />
      )}
      sx={{ minWidth: 320 }}
    />
  )
}

export default DeckPicker
