// src/renderer/components/matches/DeckSelector.tsx
import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardActionArea,
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
  InputLabel,
  FormControlLabel,
  Switch,
  Paper
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import { classes, classesMap } from '@renderer/map/classMap'
import type { ClassName } from '@prisma/client'

/** BattleState 介面（來自事件） */
interface BattleState {
  inBattle: boolean
  ownClass: string | null
  enemyClass: string | null
  playOrder: string | null
}

/** 後端回傳 */
type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string }
type Res<T> = Ok<T> | Err

/** DB 型別 */
type DbDeckCategory = { id: string; name: string; sort?: number }
type DbDeck = {
  id: number
  name: string
  class: ClassName
  categoryId: string | null
  isDefault?: boolean
}

/** UI 型別 */
type ClassId = ClassName
type DeckCategory = { id: string; name: string }
type Deck = {
  id: number
  name: string
  classId: ClassId
  categoryId: string | null
  isDefault: boolean
}

/** 分類顯示對應（可自訂字樣） */
const CATEGORY_LABEL_MAP: Record<string, string> = {
  aggro: '快攻',
  midrange: '中速',
  control: '控制'
}
const getCategoryLabel = (name: string) => CATEGORY_LABEL_MAP[name] ?? name

/** 名稱長度限制（統一 8 字） */
const NAME_LIMIT = 8
const displayName = (s: string) => (s.length > 12 ? s.slice(0, 12) + '…' : s)

/** 「全部」分類的虛擬 id */
const ALL_CAT = '__ALL__'
const lastCatKey = (cls: ClassId) => `deck:lastCat:${cls}`

type DeckSelectorProps = {
  label?: string
  width?: number | string
  allowCreate?: boolean
}

const DeckSelector: React.FC<DeckSelectorProps> = ({
  label = '管理預設牌組',
  width = 320,
  allowCreate = true
}) => {
  // Dialog
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
  const [newCategoryId, setNewCategoryId] = useState<string | ''>('') // 建立時可選分類
  const [newClass, setNewClass] = useState<ClassId>('witch')
  const [newSetDefault, setNewSetDefault] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 編輯
  const [editing, setEditing] = useState<Deck | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null)

  // 刪除
  const [deleting, setDeleting] = useState<Deck | null>(null)

  // 設定預設時的忙碌 deckId（避免連點）
  const [defaultBusyId, setDefaultBusyId] = useState<number | null>(null)

  // 初始化：載入分類與牌組
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        setLoadError(null)
        const [catRes, deckRes] = (await Promise.all([
          window.electron.ipcRenderer.invoke('deckCategories:all'),
          window.electron.ipcRenderer.invoke('decks:all')
        ])) as [Res<DbDeckCategory[]>, Res<DbDeck[]>]

        if (!mounted) return
        if (!catRes.ok) throw new Error(catRes.error)
        if (!deckRes.ok) throw new Error(deckRes.error)

        const cats: DeckCategory[] = catRes.data.map((c) => ({ id: c.id, name: c.name }))
        const ds: Deck[] = deckRes.data.map((d) => ({
          id: d.id,
          name: d.name,
          classId: d.class,
          categoryId: d.categoryId,
          isDefault: !!d.isDefault
        }))

        setCategories(cats)
        setDecks(ds)

        // 初始分類：若當前職業已有預設 → 切到預設所在分類；否則 last；否則第一個；最後 ALL
        const initClass: ClassId = 'witch'
        const defaultDeck = ds.find((x) => x.classId === initClass && x.isDefault)
        const last = localStorage.getItem(lastCatKey(initClass))
        setActiveClass(initClass)
        setNewClass(initClass)
        if (defaultDeck?.categoryId) setActiveCategoryId(defaultDeck.categoryId)
        else if (last && cats.some((c) => c.id === last)) setActiveCategoryId(last)
        else if (cats[0]) setActiveCategoryId(cats[0].id)
        else setActiveCategoryId(ALL_CAT)
        setNewCategoryId(cats[0]?.id ?? '')
      } catch (err: any) {
        setLoadError(err?.message ?? '載入失敗（Failed to load）')
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  /** 以 classes 陣列動態產生各職業的預設牌組 id map */
  const classIds = useMemo(() => classes.map((c) => c.id as ClassId), [])
  const defaultIdByClass = useMemo(() => {
    const base = Object.fromEntries(classIds.map((id) => [id, null])) as Record<
      ClassId,
      number | null
    >
    for (const d of decks) if (d.isDefault) base[d.classId] = d.id
    return base
  }, [decks, classIds])

  const defaultDeckOfActive = useMemo(() => {
    const id = defaultIdByClass[activeClass]
    return id ? (decks.find((d) => d.id === id) ?? null) : null
  }, [defaultIdByClass, activeClass, decks])

  // 戰鬥聯動：自動切職業，僅提示該職業預設（不做臨時選取）
  useEffect(() => {
    const handler = (_e: unknown, msg: BattleState) => {
      if (msg.inBattle && msg.ownClass) {
        const cls = msg.ownClass as ClassId
        setActiveClass(cls)
        setNewClass(cls)
        const defId = defaultIdByClass[cls]
        if (defId) {
          const d = decks.find((x) => x.id === defId)
          if (d?.categoryId) setActiveCategoryId(d.categoryId)
        }
      }
    }
    const unsubscribe = window.electron?.ipcRenderer.on?.('battle:status', handler)
    return () => {
      unsubscribe()
    }
  }, [decks, defaultIdByClass])

  // 當前職業下，各分類的數量
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

  // 清單：當前職業 + 當前分類（或 ALL）+ 搜尋
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let base = decks.filter((d) => d.classId === activeClass)
    if (activeCategoryId && activeCategoryId !== ALL_CAT) {
      base = base.filter((d) => d.categoryId === activeCategoryId)
    }
    if (q) base = base.filter((d) => d.name.toLowerCase().includes(q))
    return base
  }, [decks, activeClass, activeCategoryId, query])

  /** 設為該職業預設（交易 API，唯一性由後端保證） */
  const setDefaultForClass = async (deck: Deck) => {
    try {
      setDefaultBusyId(deck.id)
      const res = (await window.electron.ipcRenderer.invoke('decks:setDefaultForClass', {
        deckId: deck.id
      })) as Res<DbDeck>
      if (!res.ok) throw new Error(res.error)
      setDecks((prev) =>
        prev.map((d) => (d.classId !== deck.classId ? d : { ...d, isDefault: d.id === deck.id }))
      )
    } catch (err: any) {
      setError(err?.message ?? '設定預設失敗')
    } finally {
      setDefaultBusyId(null)
    }
  }

  // 切換職業 tab 時，新增區的職業也跟著改，沒有預設時自動勾選
  const handleChangeClassTab = (_: unknown, idx: number) => {
    const cls = classes[idx].id as ClassId
    setActiveClass(cls)
    setNewClass(cls)
    const defId = defaultIdByClass[cls]
    const defDeck = defId ? decks.find((d) => d.id === defId) : null
    const last = localStorage.getItem(lastCatKey(cls))
    if (defDeck?.categoryId) setActiveCategoryId(defDeck.categoryId)
    else if (last && categories.some((c) => c.id === last)) setActiveCategoryId(last)
    else if (categories[0]) setActiveCategoryId(categories[0].id)
    else setActiveCategoryId(ALL_CAT)
  }

  // 沒有預設時，建立畫面預設打勾（看 newClass）
  useEffect(() => {
    setNewSetDefault(defaultIdByClass[newClass] == null)
  }, [newClass, defaultIdByClass])

  const handleCreate = async () => {
    const catId = newCategoryId || activeCategoryId || ''
    if (!catId || catId === ALL_CAT) return setError('請選擇分類')
    const name = newName.trim()
    if (!name) return setError('需要名稱')
    if (name.length > NAME_LIMIT) return setError(`名稱最多 ${NAME_LIMIT} 字`)

    const dup = decks.some(
      (d) =>
        d.classId === newClass &&
        d.categoryId === catId &&
        d.name.toLowerCase() === name.toLowerCase()
    )
    if (dup) return setError('名稱已存在')

    try {
      setCreating(true)
      const res = (await window.electron.ipcRenderer.invoke('decks:create', {
        name,
        class: newClass,
        categoryId: catId,
        isDefault: newSetDefault
      })) as Res<DbDeck>

      if (!res.ok) throw new Error(res.error)

      const createdDb = res.data
      const created: Deck = {
        id: createdDb.id,
        name: createdDb.name,
        classId: createdDb.class,
        categoryId: createdDb.categoryId,
        isDefault: !!createdDb.isDefault
      }

      setDecks((prev) => {
        if (created.isDefault) {
          return prev
            .map((d) => (d.classId === created.classId ? { ...d, isDefault: false } : d))
            .concat(created)
        }
        return [created, ...prev]
      })

      // 建好後：若職業不同，切到該職業；同時切到它的分類，方便立刻看到
      if (newClass !== activeClass) setActiveClass(newClass)
      localStorage.setItem(lastCatKey(created.classId), created.categoryId ?? '')
      setActiveCategoryId(created.categoryId)
      setNewCategoryId(created.categoryId ?? '')
      setNewName('')
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? '建立失敗')
    } finally {
      setCreating(false)
    }
  }

  // 編輯（rename / move category）
  const handleEditSave = async () => {
    if (!editing) return
    const newTrim = editName.trim()
    if (!newTrim) return
    if (newTrim.length > NAME_LIMIT) return setError(`名稱最多 ${NAME_LIMIT} 字`)

    try {
      const res = (await window.electron.ipcRenderer.invoke('decks:update', {
        id: editing.id,
        name: newTrim,
        categoryId: editCategoryId
      })) as Res<DbDeck>

      if (!res.ok) throw new Error(res.error)

      const updatedDb = res.data
      const updated: Deck = {
        id: updatedDb.id,
        name: updatedDb.name,
        classId: updatedDb.class,
        categoryId: updatedDb.categoryId,
        isDefault: !!updatedDb.isDefault
      }

      setDecks((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
      setEditing(null)
    } catch (err: any) {
      setError(err?.message ?? '更新失敗')
    }
  }

  // 刪除
  const handleDelete = async () => {
    if (!deleting) return
    try {
      const res = (await window.electron.ipcRenderer.invoke('decks:delete', {
        id: deleting.id
      })) as Res<{ success: true }>

      if (!res.ok) throw new Error(res.error)
      setDecks((prev) => prev.filter((d) => d.id !== deleting.id))
      setDeleting(null)
    } catch (err: any) {
      setError(err?.message ?? '刪除失敗')
    }
  }

  // 存下每個職業的最後分類
  useEffect(() => {
    if (!activeCategoryId || activeCategoryId === ALL_CAT) return
    localStorage.setItem(lastCatKey(activeClass), activeCategoryId)
  }, [activeClass, activeCategoryId])

  return (
    <>
      {/* 主卡片（僅開啟管理對話框） */}
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
            <Stack direction="row" alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="overline" sx={{ opacity: 0.8 }} noWrap>
                  {label}
                </Typography>
                <br />
                <Typography
                  variant="caption"
                  fontSize={'14px'}
                  sx={{ color: classesMap[activeClass]?.color }}
                >
                  {`${classesMap[activeClass]?.label}  `}
                </Typography>
                －
                <Typography
                  variant="caption"
                  fontSize={'14px'}
                  sx={{ color: classesMap[activeClass]?.color, opacity: 0.9 }}
                >
                  {' '}
                  {defaultDeckOfActive?.name ?? ' 未設定'}
                </Typography>
              </Box>
            </Stack>
            <Chip
              size="small"
              color={defaultDeckOfActive ? 'success' : 'warning'}
              variant="outlined"
              label={defaultDeckOfActive ? '已有預設' : '未設定'}
            />
          </CardContent>
        </CardActionArea>
      </Card>

      {/* Dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}
        >
          預設牌組管理
          <IconButton size="small" onClick={() => setOpen(false)}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent
          dividers
          sx={{ display: 'flex', flexDirection: 'column', height: 600, overflow: 'hidden', gap: 1 }}
        >
          {loadError && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {loadError}
            </Alert>
          )}

          {/* 頂部：本職業預設提示條 */}
          <Paper
            sx={{
              p: 1,
              bgcolor: classesMap[activeClass].bgColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <StarIcon sx={{ color: classesMap[activeClass].color }} fontSize="small" />
              <Typography variant="body2">
                {defaultDeckOfActive
                  ? `目前 ${classesMap[activeClass]?.label} 的預設牌組：${defaultDeckOfActive.name}`
                  : `目前 ${classesMap[activeClass]?.label} 尚未設定預設牌組`}
              </Typography>
            </Stack>
          </Paper>

          {/* 職業 Tabs */}
          <Tabs
            value={classes.findIndex((c) => c.id === activeClass)}
            onChange={handleChangeClassTab}
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
                    {defaultIdByClass[c.id as ClassId] ? (
                      <StarIcon htmlColor={c.color} fontSize="small" />
                    ) : null}
                  </Stack>
                }
              />
            ))}
          </Tabs>

          <Box display={'flex'} alignItems={'center'} justifyContent={'space-between'}>
            {/* 分類 Tabs（含「全部」） */}
            <Tabs
              value={
                activeCategoryId === ALL_CAT
                  ? 0
                  : Math.max(1, 1 + categories.findIndex((cat) => cat.id === activeCategoryId))
              }
              onChange={(_, idx: number) => {
                if (idx === 0) setActiveCategoryId(ALL_CAT)
                else setActiveCategoryId(categories[idx - 1]?.id ?? ALL_CAT)
              }}
              variant="scrollable"
              scrollButtons="auto"
              sx={{ mb: 0.5 }}
            >
              <Tab label="全部" />
              {categories.map((cat) => {
                const count = categoryCounts[cat.id] ?? 0
                return <Tab key={cat.id} label={`${getCategoryLabel(cat.name)}（${count}）`} />
              })}
            </Tabs>

            {/* 搜尋 */}
            <TextField
              size="small"
              placeholder="搜尋牌組（名稱）"
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
          </Box>

          {/* 清單：固定三欄、卡片等高；點卡片＝設為預設 */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 2,
              maxHeight: 300,
              minHeight: 200,
              overflowY: 'auto',
              pr: 1
            }}
          >
            {filtered.length === 0 ? (
              <Paper
                sx={{
                  gridColumn: '1 / -1',
                  pt: 8,
                  textAlign: 'center',
                  color: 'text.secondary',
                  bgcolor: classesMap[activeClass].bgColor
                }}
              >
                <Typography variant="body2" sx={{ mb: 1 }}>
                  這裡還沒有牌組，試著新增一組吧！
                </Typography>
                {allowCreate && (
                  <Button
                    startIcon={<AddIcon />}
                    onClick={() => {
                      const fallback = categories[0]?.id ?? ''
                      const pick =
                        activeCategoryId && activeCategoryId !== ALL_CAT
                          ? activeCategoryId
                          : fallback
                      setNewCategoryId(pick)
                      ;(
                        document.getElementById('deck-create-name-input') as HTMLInputElement | null
                      )?.focus()
                    }}
                  >
                    新增牌組
                  </Button>
                )}
              </Paper>
            ) : (
              filtered.map((d) => {
                const clazz = classes.find((c) => c.id === d.classId)!
                const isDefault = !!d.isDefault
                return (
                  <Card
                    key={d.id}
                    variant="outlined"
                    sx={{
                      p: 1.25,
                      height: 110,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      borderRadius: 2,
                      boxShadow: isDefault ? 6 : 1,
                      borderColor: isDefault ? 'success.main' : 'divider',
                      '&:hover': { boxShadow: 6 },
                      position: 'relative',
                      backgroundColor: `${clazz.bgColor}22`,
                      cursor: 'pointer'
                    }}
                    onClick={() => void setDefaultForClass(d)}
                  >
                    {/* 整張卡片可點：設為預設 */}
                    <CardActionArea
                      sx={{ position: 'absolute', inset: 0, borderRadius: 2 }}
                      disabled={defaultBusyId === d.id}
                    />

                    {/* 右上角：星星僅作狀態指示（不可點），避免誤導 */}
                    <Stack
                      direction="row"
                      spacing={0.5}
                      sx={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}
                    >
                      <Tooltip title={isDefault ? '預設牌組' : '點卡片可設為預設'}>
                        <span>
                          <IconButton
                            size="small"
                            disableRipple
                            sx={{ pointerEvents: 'none' }} // 不可點擊，整卡片才是操作點
                            aria-hidden
                          >
                            {isDefault ? (
                              <StarIcon htmlColor={clazz.color} fontSize="small" />
                            ) : (
                              <StarBorderIcon fontSize="small" />
                            )}
                          </IconButton>
                        </span>
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
                        <Typography variant="body2" fontWeight={600} noWrap>
                          {displayName(d.name)}
                        </Typography>
                      }
                      secondary={
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {clazz.label} ·{' '}
                          {getCategoryLabel(
                            categories.find((c) => c.id === d.categoryId)?.name ?? '-'
                          )}
                        </Typography>
                      }
                      sx={{ pr: 1.5, zIndex: 0 }}
                    />

                    <Stack direction="row" justifyContent="flex-end" sx={{ zIndex: 0 }}>
                      {isDefault && <Chip size="small" color="success" label="預設" />}
                    </Stack>
                  </Card>
                )
              })
            )}
          </Box>

          {/* 新增區：可選職業 + 分類 + 一鍵設為預設 */}
          {allowCreate && (
            <>
              <Divider sx={{ my: 1 }} />
              <Paper sx={{ p: 1.5, bgcolor: '#4b4848' }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  新增牌組
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems="stretch">
                  <TextField
                    id="deck-create-name-input"
                    placeholder={`輸入新牌組名稱（最多 ${NAME_LIMIT} 字）`}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    error={!!error}
                    helperText={error ? error : `${newName.length}/${NAME_LIMIT}`}
                    slotProps={{ input: { inputProps: { maxLength: NAME_LIMIT } } }}
                    sx={{ width: 250 }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void handleCreate()
                      }
                    }}
                  />

                  {/* 職業 */}
                  <FormControl sx={{ minWidth: 120 }}>
                    <InputLabel>職業</InputLabel>
                    <Select
                      label="職業"
                      value={newClass}
                      onChange={(e) => setNewClass(e.target.value as ClassId)}
                    >
                      {classes.map((c) => (
                        <MenuItem key={c.id} value={c.id}>
                          {c.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>

                  {/* 分類 */}
                  <FormControl sx={{ minWidth: 120 }}>
                    <InputLabel>分類</InputLabel>
                    <Select
                      label="分類"
                      value={
                        newCategoryId ||
                        (activeCategoryId === ALL_CAT ? '' : activeCategoryId) ||
                        ''
                      }
                      onChange={(e) => setNewCategoryId(String(e.target.value))}
                    >
                      {categories.map((cat) => (
                        <MenuItem key={cat.id} value={cat.id}>
                          {getCategoryLabel(cat.name)}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>

                  <FormControlLabel
                    sx={{ pb: 3, mx: 0.5 }}
                    control={
                      <Switch
                        checked={newSetDefault}
                        onChange={(e) => setNewSetDefault(e.target.checked)}
                      />
                    }
                    label="設為預設"
                  />

                  <Button
                    variant="contained"
                    size="small"
                    sx={{ height: '50px' }}
                    startIcon={<AddIcon />}
                    onClick={() => void handleCreate()}
                    disabled={creating || !newCategoryId}
                  >
                    建立
                  </Button>
                </Stack>
              </Paper>
            </>
          )}
        </DialogContent>

        <DialogActions>
          <Button onClick={() => setOpen(false)}>關閉</Button>
        </DialogActions>
      </Dialog>

      {/* 編輯對話框 */}
      <Dialog open={!!editing} onClose={() => setEditing(null)} maxWidth="xs" fullWidth>
        <DialogTitle>編輯牌組</DialogTitle>
        <DialogContent sx={{ mt: 4 }}>
          <TextField
            fullWidth
            autoFocus
            label={`牌組名稱（最多 ${NAME_LIMIT} 字）`}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            slotProps={{ input: { inputProps: { maxLength: NAME_LIMIT } } }}
            helperText={`${editName.length}/${NAME_LIMIT}`}
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
