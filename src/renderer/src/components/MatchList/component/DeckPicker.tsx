// src/renderer/components/matches/DeckPicker.tsx
import React from 'react'
import {
  Autocomplete,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ListSubheader,
  Stack,
  TextField,
  Typography,
  Button
} from '@mui/material'
import { createFilterOptions } from '@mui/material/Autocomplete'
import type { ClassName } from '@prisma/client'
import DeckEditDialog from './DeckEditDialog'
import { classesMap } from '@renderer/map/classMap'

/* ================================
 * Types
 * ================================ */

type DeckRow = { id: number; name: string; class: ClassName; categoryId: string | null }
type Category = { id: string; name: string; sort?: number }

/** 顯示用 Option：帶上 categoryName；__create__ 為空清單時的哨兵。 */
type Option = (DeckRow & { categoryName: string }) & { __create__?: boolean }

/** 回傳給父層的精簡 deck（確保能即時顯示 name） */
export type DeckLite = { id: number; name: string; class: ClassName }

type Props = {
  label: string
  /** 若指定，只顯示該職業的牌組 */
  klass?: ClassName
  /** 仍以 deckId 控制選取狀態（避免破壞外部呼叫） */
  value: number | null
  /** 回傳 Deck 物件（父層可直接顯示 name）；null 代表清空 */
  onChange: (deck: DeckLite | null) => void
}

/* ================================
 * Constants & Helpers
 * ================================ */

const UNGROUPED_LABEL = '（未分類）'
const BIG = 9_999_999

/** 依 sort 排序分類（同 sort 時以 name 排） */
const sortCategories = (a: Category, b: Category) => {
  const sa = a.sort ?? 0
  const sb = b.sort ?? 0
  return sa === sb ? a.name.localeCompare(b.name, 'zh-Hant') : sa - sb
}

/** 將分類陣列做成 map */
const toCatNameMap = (cats: Category[]) => {
  const map = new Map<string, string>()
  cats.forEach((c) => map.set(c.id, c.name))
  return map
}

/** 建立空清單時使用的哨兵選項 */
const makeCreateSentinel = (klass?: ClassName): Option => ({
  id: -1,
  name: '新增牌組',
  class: klass ?? 'witch', // 任意合法值，不會實際使用
  categoryId: null,
  categoryName: '',
  __create__: true
})

/** 官方過濾器（同時比對 名稱/分類/職業標籤） */
const defaultFilter = createFilterOptions<Option>({
  stringify: (o) => [o.name, o.categoryName, classesMap[o.class]?.label].filter(Boolean).join(' ')
})

/* ================================
 * Component
 * ================================ */

export default function DeckPicker({ label, klass, value, onChange }: Props) {
  // ---------- Server state ----------
  const [loading, setLoading] = React.useState(true)
  const [categories, setCategories] = React.useState<Category[]>([])
  const [options, setOptions] = React.useState<Option[]>([])

  // ---------- Dialog state ----------
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState<null | Option>(null)
  const [confirmOpen, setConfirmOpen] = React.useState<null | Option>(null)
  const [deleting, setDeleting] = React.useState(false)
  const [createCategoryId] = React.useState<string | ''>('')

  // ---------- Load data once ----------
  React.useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      try {
        const [catRes, deckRes] = await Promise.all([
          window.electron.ipcRenderer.invoke('deckCategories:all'),
          window.electron.ipcRenderer.invoke('decks:all')
        ])
        if (!mounted) return

        if (!catRes?.ok) throw new Error(catRes?.error ?? '讀取分類失敗')
        if (!deckRes?.ok) throw new Error(deckRes?.error ?? '讀取牌組失敗')

        const sortedCats: Category[] = [...catRes.data].sort(sortCategories)
        const catNameMap = toCatNameMap(sortedCats)

        const list: Option[] = (deckRes.data as DeckRow[]).map((d) => ({
          ...d,
          categoryName: d.categoryId ? (catNameMap.get(d.categoryId) ?? '') : ''
        }))

        setCategories(sortedCats)
        setOptions(list)
      } catch (err: any) {
        alert(err?.message ?? '載入失敗')
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  // ---------- Derived maps ----------
  /** id -> sortIndex（未分類視為最大） */
  const catSortIndex = React.useMemo(() => {
    const m = new Map<string, number>()
    categories.forEach((c, i) => m.set(c.id, c.sort ?? i))
    return m
  }, [categories])

  // ---------- Options (filtered + sorted) ----------
  const filteredOptions = React.useMemo(() => {
    const list = options.filter((o) => (klass ? o.class === klass : true))
    list.sort((a, b) => {
      const sa = a.categoryId ? (catSortIndex.get(a.categoryId) ?? BIG) : BIG
      const sb = b.categoryId ? (catSortIndex.get(b.categoryId) ?? BIG) : BIG
      if (sa !== sb) return sa - sb
      return a.name.localeCompare(b.name, 'zh-Hant')
    })
    return list
  }, [options, klass, catSortIndex])

  const selectedOption = React.useMemo(
    () => filteredOptions.find((o) => o.id === value) ?? null,
    [filteredOptions, value]
  )

  // ---------- Handlers ----------
  /** 新增 Deck 後：立刻加入 options、並把物件回傳給父層（確保 SummaryHeader 即時顯示 name） */
  const handleCreated = React.useCallback(
    (deck: DeckRow) => {
      const categoryName = deck.categoryId
        ? (categories.find((c) => c.id === deck.categoryId)?.name ?? '')
        : ''
      setOptions((prev) => [...prev, { ...deck, categoryName }])
      onChange({ id: deck.id, name: deck.name, class: deck.class })
    },
    [categories, onChange]
  )

  const handleUpdated = React.useCallback((deck: DeckRow) => {
    setOptions((prev) =>
      prev.map((o) => (o.id === deck.id ? { ...o, ...deck, categoryName: o.categoryName } : o))
    )
  }, [])

  const doDelete = React.useCallback(
    async (target: Option) => {
      setDeleting(true)
      try {
        const res = await window.electron.ipcRenderer.invoke('decks:delete', { id: target.id })
        if (!res?.ok) throw new Error(res?.error ?? '刪除失敗')
        setOptions((prev) => prev.filter((o) => o.id !== target.id))
        if (value === target.id) onChange(null)
        setConfirmOpen(null)
      } catch (err: any) {
        alert(err?.message ?? '刪除失敗')
      } finally {
        setDeleting(false)
      }
    },
    [onChange, value]
  )

  /* ================================
   * Render
   * ================================ */

  return (
    <>
      <Autocomplete<Option, false, false, false>
        value={selectedOption}
        onChange={(_, opt) => {
          if (opt?.__create__) return
          onChange(opt ? { id: opt.id, name: opt.name, class: opt.class } : null)
        }}
        options={filteredOptions}
        filterOptions={(opts, params) => {
          const filtered = defaultFilter(opts, params)
          if (!loading && filtered.length === 0) filtered.push(makeCreateSentinel(klass))
          return filtered
        }}
        loading={loading}
        getOptionLabel={(o) => (o.__create__ ? '' : o.name)}
        groupBy={(o) => (o.__create__ ? '' : o.categoryName || UNGROUPED_LABEL)}
        noOptionsText=""
        isOptionEqualToValue={(a, b) => a.id === b.id}
        disablePortal
        autoHighlight
        selectOnFocus
        slotProps={{
          paper: { elevation: 2 },
          listbox: { style: { maxHeight: 320, paddingTop: 0, paddingBottom: 0 } }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            placeholder="搜尋或選擇牌組"
            slotProps={{
              input: {
                ...params.InputProps,
                endAdornment: (
                  <>
                    {loading ? <CircularProgress size={18} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                )
              }
            }}
          />
        )}
        renderGroup={(params) => {
          // 只有哨兵時不渲染 header
          if (!params.group) return <ul key={params.key}>{params.children}</ul>
          return (
            <li key={params.key}>
              <ListSubheader disableSticky>
                <Stack direction="row" alignItems="center" justifyContent="space-between" pr={1}>
                  <Typography variant="subtitle1">{params.group}</Typography>
                  {/* <Tooltip title="在此分類新增牌組">
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        const groupName = params.group
                        const catId =
                          groupName === UNGROUPED_LABEL ? '' : (catNameToId.get(groupName) ?? '')
                        setCreateCategoryId(catId)
                        setCreateOpen(true)
                      }}
                    >
                      <AddIcon fontSize="small" />
                    </IconButton>
                  </Tooltip> */}
                </Stack>
              </ListSubheader>
              {params.children}
              <Divider />
            </li>
          )
        }}
        renderOption={(props, option) => {
          // 哨兵：顯示「新增牌組」
          // if (option.__create__) {
          //   return (
          //     <Box
          //       component="li"
          //       {...props}
          //       onMouseDown={(e) => e.preventDefault()} // 避免 mousedown 直接關閉下拉
          //       sx={{ display: 'flex', justifyContent: 'space-between', width: '90%' }}
          //       onClick={(e) => {
          //         e.stopPropagation()
          //         setCreateCategoryId(firstSortedCategoryId || '')
          //         setCreateOpen(true)
          //       }}
          //     >
          //       <Typography
          //         variant="body2"
          //         color="text.secondary"
          //         display="flex"
          //         alignItems="center"
          //         gap={1}
          //       >
          //         <AddIcon fontSize="small" />
          //         新增牌組
          //       </Typography>
          //     </Box>
          //   )
          // }
          const color = classesMap[option.class]?.color as string | undefined
          if (option.__create__) {
            return (
              <Box my={3} display={'flex'} alignItems={'center'} gap={1}>
                <Chip
                  size="small"
                  label={classesMap[option.class].label}
                  sx={{ bgcolor: color ? `${color}50` : undefined }}
                />
                目前暫無牌組
              </Box>
            )
          }

          return (
            <Box
              component="li"
              {...props}
              sx={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                '&.MuiAutocomplete-option': { justifyContent: 'space-between' }
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
                <Chip
                  size="small"
                  label={classesMap[option.class].label}
                  sx={{ bgcolor: color ? `${color}50` : undefined }}
                />
                <Typography noWrap>{option.name}</Typography>
              </Stack>

              {/* <Stack direction="row" alignItems="center" spacing={0.5} sx={{ ml: 'auto' }}>
                <Tooltip title="編輯">
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditOpen(option)
                    }}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>

                <Tooltip title="刪除">
                  <IconButton
                    size="small"
                    color="error"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmOpen(option)
                    }}
                  >
                    <DeleteForeverIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack> */}
            </Box>
          )
        }}
      />

      {/* 新增 Deck（預設分類：群組右上新增 or 空清單按鈕） */}
      {klass && (
        <DeckEditDialog
          open={createOpen}
          mode="create"
          init={null}
          klass={klass}
          categories={categories}
          defaultCategoryId={createCategoryId}
          onClose={() => setCreateOpen(false)}
          onSaved={handleCreated}
        />
      )}

      {/* 編輯 Deck */}
      {editOpen && (
        <DeckEditDialog
          open={!!editOpen}
          mode="edit"
          init={editOpen}
          klass={editOpen.class}
          categories={categories}
          onClose={() => setEditOpen(null)}
          onSaved={handleUpdated}
        />
      )}

      {/* 刪除確認 */}
      <Dialog open={!!confirmOpen} onClose={() => (deleting ? undefined : setConfirmOpen(null))}>
        <DialogTitle>刪除確認</DialogTitle>
        <DialogContent>確定要刪除「{confirmOpen?.name}」嗎？此動作無法復原。</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(null)} disabled={deleting}>
            取消
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => confirmOpen && doDelete(confirmOpen)}
            disabled={deleting}
          >
            {deleting ? '刪除中…' : '刪除'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
