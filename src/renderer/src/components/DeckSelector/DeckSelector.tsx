import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
  IconButton,
  InputAdornment,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CheckIcon from '@mui/icons-material/Check'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import { classes } from '@renderer/map/classMap'

/** BattleState 介面（來自事件） */
interface BattleState {
  inBattle: boolean
  ownClass: string | null
  enemyClass: string | null
  playOrder: string | null
}

/** === DB 型別 === */
type DbDeckCategory = { id: string; name: string; createdAt: string }
type DbDeck = { id: number; name: string; class: string; categoryId: string | null }

/** === UI 型別 === */
type ClassId = (typeof classes)[number]['id']
type DeckCategory = { id: string; name: string }
type Deck = { id: number; name: string; classId: ClassId; categoryId: string | null }

type DeckSelectorProps = {
  value?: number | null
  onChange?: (deckId: number | null, deck?: Deck) => void
  label?: string
  width?: number | string
  allowCreate?: boolean
}

/** 分類顯示對應 */
const CATEGORY_LABEL_MAP: Record<string, string> = {
  aggro: '快攻',
  midrange: '中速',
  control: '控制'
}
const getCategoryLabel = (name: string) => CATEGORY_LABEL_MAP[name] ?? name

/** 名稱長度限制 */
const DISPLAY_NAME_LIMIT = 8
const displayName = (s: string) =>
  s.length > DISPLAY_NAME_LIMIT ? s.slice(0, DISPLAY_NAME_LIMIT) + '…' : s

export const DeckSelector: React.FC<DeckSelectorProps> = ({
  value,
  onChange,
  label = '選擇牌組',
  width = 320,
  allowCreate = true
}) => {
  const [internalSelectedId, setInternalSelectedId] = useState<number | null>(null)
  const selectedId = value !== undefined ? value : internalSelectedId

  // Dialog 狀態
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  // DB 資料
  const [categories, setCategories] = useState<DeckCategory[]>([])
  const [decks, setDecks] = useState<Deck[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  // Tabs 狀態
  const [activeClass, setActiveClass] = useState<ClassId>('witch')
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)

  // 新增
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 預設牌組
  const [defaultDecks, setDefaultDecks] = useState<Record<ClassId, number | null>>({
    elf: null,
    royal: null,
    witch: null,
    dragon: null,
    bishop: null,
    nightmare: null,
    nemesis: null
  })

  // 編輯
  const [editing, setEditing] = useState<Deck | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null)

  // 刪除
  const [deleting, setDeleting] = useState<Deck | null>(null)

  // 初始化
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const res = await window.electron.ipcRenderer.invoke('decks:list')
        if (!mounted) return
        if (res?.error) throw new Error(res.error)
        const cats: DeckCategory[] = (res?.categories as DbDeckCategory[]).map((c) => ({
          id: c.id,
          name: c.name
        }))
        const ds: Deck[] = (res?.decks as DbDeck[]).map((d) => ({
          id: d.id,
          name: d.name,
          classId: d.class as ClassId,
          categoryId: d.categoryId
        }))
        setCategories(cats)
        setDecks(ds)
        if (!activeCategoryId && cats.length) setActiveCategoryId(cats[0].id)
        setLoadError(null)
      } catch (err: any) {
        setLoadError(err?.message ?? '載入失敗（Failed to load）')
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  // 戰鬥聯動
  useEffect(() => {
    const handler = (_e: unknown, msg: BattleState) => {
      if (msg.inBattle && msg.ownClass) {
        const cls = msg.ownClass as ClassId
        setActiveClass(cls)
        const defId = defaultDecks[cls]
        if (defId) {
          const d = decks.find((x) => x.id === defId)
          if (d) {
            if (value === undefined) setInternalSelectedId(d.id)
            onChange?.(d.id, d)
          }
        }
      }
    }
    const unsubscribe = window.electron?.ipcRenderer.on?.('battle:status', handler)
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
      else window.electron?.ipcRenderer.removeListener?.('battle:status', handler as any)
    }
  }, [decks, defaultDecks, value, onChange])

  const selectedDeck = useMemo(
    () => decks.find((d) => d.id === selectedId) || null,
    [decks, selectedId]
  )

  const categoryCounts = useMemo(() => {
    const byCat: Record<string, number> = {}
    for (const cat of categories) byCat[cat.id] = 0
    for (const d of decks) {
      if (d.classId === activeClass && d.categoryId) {
        byCat[d.categoryId] = (byCat[d.categoryId] ?? 0) + 1
      }
    }
    return byCat
  }, [decks, categories, activeClass])

  const filtered = useMemo(() => {
    if (!activeCategoryId) return []
    const q = query.trim().toLowerCase()
    let base = decks.filter((d) => d.classId === activeClass && d.categoryId === activeCategoryId)
    if (q) base = base.filter((d) => d.name.toLowerCase().includes(q))
    return base
  }, [decks, activeClass, activeCategoryId, query])

  const handleChoose = (deck: Deck) => {
    if (value === undefined) setInternalSelectedId(deck.id)
    onChange?.(deck.id, deck)
    setDefaultDecks((prev) => ({ ...prev, [deck.classId]: deck.id }))
    setOpen(false)
  }
  const handleClear = () => {
    if (value === undefined) setInternalSelectedId(null)
    onChange?.(null, undefined)
  }
  const handleSetDefaultOnly = (deck: Deck) => {
    setDefaultDecks((prev) => ({ ...prev, [deck.classId]: deck.id }))
  }

  const handleCreate = async () => {
    if (!activeCategoryId) return
    const name = newName.trim()
    if (!name) return setError('需要名稱')
    if (name.length > 8) return setError('名稱最多 8 字')
    const dup = decks.some(
      (d) =>
        d.classId === activeClass &&
        d.categoryId === activeCategoryId &&
        d.name.toLowerCase() === name.toLowerCase()
    )
    if (dup) return setError('名稱已存在')
    setError(null)
    try {
      setCreating(true)
      const res = await window.electron.ipcRenderer.invoke('decks:create', {
        name,
        classId: activeClass,
        categoryId: activeCategoryId
      })
      if (res?.error) throw new Error(res.error)
      const createdDb = res as DbDeck
      const created: Deck = {
        id: createdDb.id,
        name: createdDb.name,
        classId: createdDb.class as ClassId,
        categoryId: createdDb.categoryId
      }
      setDecks((prev) => [created, ...prev])
      if (value === undefined) setInternalSelectedId(created.id)
      onChange?.(created.id, created)
      setDefaultDecks((prev) => ({ ...prev, [created.classId]: created.id }))
      setNewName('')
      setOpen(false)
    } catch (err: any) {
      setError(err?.message ?? '建立失敗')
    } finally {
      setCreating(false)
    }
  }

  const handleEditSave = async () => {
    if (!editing) return
    const newTrim = editName.trim()
    if (!newTrim) return
    if (newTrim.length > 8) return setError('名稱最多 8 字')
    try {
      const res = await window.electron.ipcRenderer.invoke('decks:update', {
        id: editing.id,
        name: newTrim,
        categoryId: editCategoryId
      })
      if (res?.error) throw new Error(res.error)
      const updatedDb = res as DbDeck
      const updated: Deck = {
        id: updatedDb.id,
        name: updatedDb.name,
        classId: updatedDb.class as ClassId,
        categoryId: updatedDb.categoryId
      }
      setDecks((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
      if (selectedId === updated.id) onChange?.(updated.id, updated)
      setEditing(null)
    } catch (err: any) {
      setError(err?.message ?? '更新失敗')
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await window.electron.ipcRenderer.invoke('decks:delete', { id: deleting.id })
      setDecks((prev) => prev.filter((d) => d.id !== deleting.id))
      if (selectedId === deleting.id) {
        if (value === undefined) setInternalSelectedId(null)
        onChange?.(null, undefined)
      }
      setDeleting(null)
    } catch (err: any) {
      setError(err?.message ?? '刪除失敗')
    }
  }

  return (
    <>
      {/* 選擇器主卡片 */}
      <Card variant="outlined" sx={{ width, height: 56, display: 'flex' }}>
        <CardActionArea onClick={() => setOpen(true)} sx={{ flex: 1, minHeight: 0 }}>
          <CardContent
            sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
              py: 1,
              overflow: 'hidden'
            }}
          >
            <Stack direction="row" alignItems="center" gap={1} sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="overline" sx={{ opacity: 0.8 }} noWrap>
                  {label}
                </Typography>
                <Typography variant="h6" noWrap>
                  {selectedDeck ? selectedDeck.name : '選擇牌組'}
                </Typography>
              </Box>
            </Stack>
            <Stack direction="row" gap={1} alignItems="center">
              {selectedDeck ? (
                <Chip size="small" color="success" variant="outlined" label="已選擇" />
              ) : (
                <Chip size="small" color="info" variant="outlined" label="未選擇" />
              )}
              {selectedDeck && (
                <Tooltip title="清除">
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleClear()
                    }}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          </CardContent>
        </CardActionArea>
      </Card>

      {/* Dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}
        >
          選擇或新增牌組
          <IconButton size="small" onClick={() => setOpen(false)}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent
          dividers
          sx={{ display: 'flex', flexDirection: 'column', height: 540, overflow: 'hidden' }}
        >
          {loadError && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {loadError}
            </Alert>
          )}

          {/* 職業 Tabs */}
          <Tabs
            value={classes.findIndex((c) => c.id === activeClass)}
            onChange={(_, idx: number) => setActiveClass(classes[idx].id as ClassId)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ mb: 0.5 }}
          >
            {classes.map((c) => (
              <Tab
                key={c.id}
                label={
                  <Stack direction="row" alignItems="center" gap={0.5}>
                    <span>{c.label}</span>
                    {defaultDecks[c.id as ClassId] ? (
                      <StarIcon htmlColor={c.color} fontSize="small" />
                    ) : null}
                  </Stack>
                }
              />
            ))}
          </Tabs>

          {/* 分類 Tabs */}
          <Tabs
            value={Math.max(
              0,
              categories.findIndex((cat) => cat.id === activeCategoryId)
            )}
            onChange={(_, idx: number) => setActiveCategoryId(categories[idx]?.id ?? null)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ mb: 0.5 }}
          >
            {categories.map((cat) => {
              const count = categoryCounts[cat.id] ?? 0
              return <Tab key={cat.id} label={`${getCategoryLabel(cat.name)}（${count}）`} />
            })}
          </Tabs>

          {/* 搜尋 */}
          <TextField
            placeholder="搜尋牌組"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }}
            sx={{ mb: 1 }}
          />

          {/* 清單：固定三欄、卡片等高 */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 2,
              maxHeight: 280,
              overflowY: 'auto',
              pr: 1
            }}
          >
            {filtered.map((d) => {
              const isSelected = d.id === selectedId
              const isDefaultForClass = defaultDecks[activeClass] === d.id
              const clazz = classes.find((c) => c.id === d.classId)!
              return (
                <Card
                  key={d.id}
                  variant="outlined"
                  sx={{
                    p: 1.25,
                    height: 104,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    borderRadius: 2,
                    boxShadow: isSelected ? 4 : 1,
                    borderColor: isSelected ? 'success.main' : 'divider',
                    '&:hover': { boxShadow: 6 },
                    position: 'relative',
                    backgroundColor: `${clazz.bgColor}22`,
                    cursor: 'pointer'
                  }}
                  onClick={() => handleChoose(d)}
                >
                  {/* 右上角：預設/編輯/刪除 */}
                  <Stack
                    direction="row"
                    spacing={0.5}
                    sx={{ position: 'absolute', top: 4, right: 4 }}
                  >
                    <Tooltip title={isDefaultForClass ? '預設牌組' : '設為預設'}>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSetDefaultOnly(d)
                        }}
                      >
                        {isDefaultForClass ? (
                          <StarIcon htmlColor={clazz.color} fontSize="small" />
                        ) : (
                          <StarBorderIcon fontSize="small" />
                        )}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="編輯">
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditing(d)
                          setEditName(d.name)
                          setEditCategoryId(d.categoryId ?? null)
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="刪除">
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleting(d)
                        }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>

                  <ListItemText
                    primary={
                      //   <Tooltip title={d.name}>
                      <Typography variant="body2" fontWeight={600} noWrap>
                        {displayName(d.name)}
                      </Typography>
                      //   {/* </Tooltip> */}
                    }
                    secondary={
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {clazz.label} ·{' '}
                        {getCategoryLabel(
                          categories.find((c) => c.id === d.categoryId)?.name ?? '-'
                        )}
                      </Typography>
                    }
                    sx={{ pr: 1.5 }}
                  />

                  <Stack direction="row" justifyContent="flex-end">
                    {isSelected && (
                      <Chip icon={<CheckIcon />} size="small" color="success" label="已選擇" />
                    )}
                  </Stack>
                </Card>
              )
            })}
          </Box>

          {/* 新增 */}
          {allowCreate && (
            <>
              <Divider sx={{ my: 1 }} />
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  新增牌組
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems="stretch">
                  <TextField
                    placeholder="輸入新牌組名稱（最多 8 字）"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    slotProps={{ input: { inputProps: { maxLength: 8 } } }}
                    helperText={`${newName.length}/8`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void handleCreate()
                      }
                    }}
                    fullWidth
                  />
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => void handleCreate()}
                    disabled={creating || !activeCategoryId}
                  >
                    新增
                  </Button>
                </Stack>
              </Box>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 編輯對話框 */}
      <Dialog open={!!editing} onClose={() => setEditing(null)} maxWidth="xs" fullWidth>
        <DialogTitle>編輯牌組</DialogTitle>
        <DialogContent sx={{ mt: 4 }}>
          <TextField
            fullWidth
            autoFocus
            label="牌組名稱（最多 8 字）"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            slotProps={{ input: { inputProps: { maxLength: 8 } } }}
            helperText={`${editName.length}/8`}
            sx={{ mb: 2 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleEditSave()
              }
            }}
          />

          <FormControl fullWidth>
            <InputLabel>分類（Category）</InputLabel>
            <Select
              value={editCategoryId ?? ''}
              label="分類（Category）"
              onChange={(e) => setEditCategoryId(e.target.value ? String(e.target.value) : null)}
            >
              {categories.map((cat) => (
                <MenuItem key={cat.id} value={cat.id}>
                  {getCategoryLabel(cat.name)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>取消</Button>
          <Button onClick={() => void handleEditSave()} variant="contained">
            儲存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 刪除對話框 */}
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} maxWidth="xs" fullWidth>
        <DialogTitle>刪除牌組</DialogTitle>
        <DialogContent>確定要刪除牌組「{deleting?.name}」嗎？此動作無法復原。</DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>取消</Button>
          <Button color="error" variant="contained" onClick={() => void handleDelete()}>
            刪除
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export default DeckSelector
