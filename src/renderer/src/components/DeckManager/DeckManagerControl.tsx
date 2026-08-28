// Entry control and manager for the user's deck library.
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
  Drawer,
  IconButton,
  InputAdornment,
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
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { classes, classesMap } from '@renderer/map/classMap'
import type { ClassName } from '@shared/domain'

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

type DeckManagerControlProps = {
  label?: string
  width?: number | string
  allowCreate?: boolean
}

const DeckManagerControl: React.FC<DeckManagerControlProps> = ({
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
  const [isCreatePanelOpen, setIsCreatePanelOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 編輯
  const [editing, setEditing] = useState<Deck | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null)
  const [editSetDefault, setEditSetDefault] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)

  // 刪除
  const [deleting, setDeleting] = useState<Deck | null>(null)
  const [deletingBusy, setDeletingBusy] = useState(false)

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

        // 初始分類一律顯示全部，避免預設牌組或上次瀏覽狀態改變使用者視野。
        const initClass: ClassId = 'witch'
        setActiveClass(initClass)
        setNewClass(initClass)
        setActiveCategoryId(ALL_CAT)
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
        setActiveCategoryId(ALL_CAT)
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

  // 切換職業時回到全部分類，讓使用者先看到該職業的完整牌組清單。
  const handleChangeClassTab = (_: unknown, idx: number) => {
    const cls = classes[idx].id as ClassId
    setActiveClass(cls)
    setNewClass(cls)
    setActiveCategoryId(ALL_CAT)
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
      setActiveCategoryId(created.categoryId)
      setNewCategoryId(created.categoryId ?? '')
      setNewName('')
      setError(null)
      setIsCreatePanelOpen(false)
    } catch (err: any) {
      setError(err?.message ?? '建立失敗')
    } finally {
      setCreating(false)
    }
  }

  const openCreatePanel = () => {
    const initialCategoryId =
      activeCategoryId && activeCategoryId !== ALL_CAT
        ? activeCategoryId
        : (categories[0]?.id ?? '')
    setNewClass(activeClass)
    setNewCategoryId(initialCategoryId)
    setNewName('')
    setNewSetDefault(defaultIdByClass[activeClass] == null)
    setError(null)
    setIsCreatePanelOpen(true)
  }

  const isDeckPanelOpen = !!editing || isCreatePanelOpen
  const isDeckPanelBusy = savingEdit || creating
  const panelClass = editing?.classId ?? newClass
  const closeDeckPanel = () => {
    if (isDeckPanelBusy) return
    setEditing(null)
    setIsCreatePanelOpen(false)
  }

  // 編輯（rename / move category）
  const handleEditSave = async () => {
    if (!editing) return
    const newTrim = editName.trim()
    if (!newTrim) return setError('需要名稱')
    if (newTrim.length > NAME_LIMIT) return setError(`名稱最多 ${NAME_LIMIT} 字`)

    const dup = decks.some(
      (deck) =>
        deck.id !== editing.id &&
        deck.classId === editing.classId &&
        deck.categoryId === editCategoryId &&
        deck.name.toLowerCase() === newTrim.toLowerCase()
    )
    if (dup) return setError('名稱已存在')

    try {
      setSavingEdit(true)
      const res = (await window.electron.ipcRenderer.invoke('decks:update', {
        id: editing.id,
        name: newTrim,
        categoryId: editCategoryId,
        isDefault: editSetDefault
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

      setDecks((prev) =>
        prev.map((deck) => {
          if (deck.id === updated.id) return updated
          if (updated.isDefault && deck.classId === updated.classId) {
            return { ...deck, isDefault: false }
          }
          return deck
        })
      )
      setEditing(null)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? '更新失敗')
    } finally {
      setSavingEdit(false)
    }
  }

  // 刪除
  const handleDelete = async () => {
    if (!deleting) return
    try {
      setDeletingBusy(true)
      const res = (await window.electron.ipcRenderer.invoke('decks:delete', {
        id: deleting.id
      })) as Res<{ success: true }>

      if (!res.ok) throw new Error(res.error)
      setDecks((prev) => prev.filter((d) => d.id !== deleting.id))
      setDeleting(null)
    } catch (err: any) {
      setError(err?.message ?? '刪除失敗')
    } finally {
      setDeletingBusy(false)
    }
  }

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

      {/* 牌組管理工作區 */}
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        style={{ zIndex: 1500 }}
        sx={{
          '& .MuiDrawer-paper': {
            bgcolor: '#1b1e24',
            backgroundImage: 'none'
          },
          '& .MuiBackdrop-root': { bgcolor: 'rgba(7, 9, 13, 0.46)' }
        }}
        PaperProps={{
          sx: {
            width: 'min(960px, calc(100vw - 112px))',
            minWidth: 720,
            borderTopLeftRadius: 16,
            borderBottomLeftRadius: 16,
            overflow: 'hidden'
          }
        }}
      >
        <Box sx={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              px: 3,
              py: 2
            }}
          >
            <Box>
              <Typography variant="h6" component="h2" fontWeight={700}>
                牌組管理
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                管理各職業牌組，並指定對局時自動帶入的預設牌組。
              </Typography>
            </Box>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label="關閉牌組管理">
              <CloseIcon />
            </IconButton>
          </Box>

          <Box
            sx={{
              display: 'flex',
              flex: 1,
              flexDirection: 'column',
              overflow: 'hidden',
              gap: 1,
              borderTop: 1,
              borderColor: 'divider',
              px: 3,
              py: 2
            }}
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
                <StarIcon color="warning" fontSize="small" />
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
                        <StarIcon color="warning" fontSize="small" />
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
              {allowCreate && (
                <Card
                  variant="outlined"
                  sx={{
                    height: 132,
                    borderRadius: 2,
                    borderStyle: 'dashed',
                    borderColor: 'divider',
                    bgcolor: 'action.hover',
                    '&:hover': { borderColor: 'primary.main', bgcolor: 'action.selected' }
                  }}
                >
                  <CardActionArea
                    onClick={openCreatePanel}
                    sx={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 0.75 }}
                  >
                    <AddIcon color="primary" />
                    <Typography variant="body2" fontWeight={700}>
                      新增牌組
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      建立{classesMap[activeClass].label}牌組
                    </Typography>
                  </CardActionArea>
                </Card>
              )}
              {filtered.length > 0 &&
                filtered.map((d) => {
                  const clazz = classes.find((c) => c.id === d.classId)!
                  const isDefault = !!d.isDefault
                  return (
                    <Card
                      key={d.id}
                      variant="outlined"
                      sx={{
                        p: 1.5,
                        height: 132,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        borderRadius: 2,
                        boxShadow: isDefault ? 4 : 0,
                        borderColor: isDefault ? 'success.main' : 'divider',
                        '&:hover': {
                          boxShadow: 4,
                          borderColor: isDefault ? 'success.main' : 'primary.main'
                        },
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

                      <Stack
                        direction="row"
                        alignItems="flex-start"
                        justifyContent="space-between"
                        gap={1}
                      >
                        <Typography variant="subtitle2" fontWeight={700} noWrap sx={{ pr: 1 }}>
                          {displayName(d.name)}
                        </Typography>

                        {/* 卡片操作獨立於整卡設定預設的行為 */}
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ zIndex: 1, mt: -0.75, mr: -0.75 }}
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
                                  <StarIcon color="warning" fontSize="small" />
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
                                setEditSetDefault(d.isDefault)
                                setError(null)
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
                      </Stack>

                      <Stack direction="row" spacing={0.75} sx={{ zIndex: 0, mt: 0.5 }}>
                        <Chip
                          size="small"
                          label={clazz.label}
                          sx={{
                            height: 22,
                            color: clazz.color,
                            bgcolor: `${clazz.color}1f`,
                            fontWeight: 600
                          }}
                        />
                        <Chip
                          size="small"
                          variant="outlined"
                          label={getCategoryLabel(
                            categories.find((category) => category.id === d.categoryId)?.name ??
                              '未分類'
                          )}
                          sx={{ height: 22, fontWeight: 600 }}
                        />
                      </Stack>

                      <Stack
                        direction="row"
                        alignItems="center"
                        spacing={0.5}
                        sx={{ zIndex: 0, mt: 'auto' }}
                      >
                        {isDefault ? (
                          <>
                            <StarIcon color="warning" sx={{ fontSize: 16 }} />
                            <Typography variant="caption" color="text.secondary" fontWeight={700}>
                              預設牌組
                            </Typography>
                          </>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            點一下卡片設為預設
                          </Typography>
                        )}
                      </Stack>
                    </Card>
                  )
                })}
            </Box>
          </Box>

          <Box sx={{ borderTop: 1, borderColor: 'divider', px: 3, py: 1.5 }}>
            <Button onClick={() => setOpen(false)}>關閉</Button>
          </Box>
        </Box>
      </Drawer>

      {/* 編輯工作面板：保留牌組清單作為操作脈絡 */}
      <Drawer
        anchor="right"
        open={isDeckPanelOpen}
        onClose={closeDeckPanel}
        style={{ zIndex: 1510 }}
        PaperProps={{
          sx: {
            width: 440,
            maxWidth: 'calc(100vw - 32px)',
            borderTopLeftRadius: 16,
            borderBottomLeftRadius: 16,
            boxShadow: 24,
            overflow: 'hidden',
            bgcolor: '#20242c',
            backgroundImage: 'none'
          }
        }}
      >
        <Box sx={{ display: 'flex', height: '100%', flexDirection: 'column' }}>
          <Box sx={{ px: 3, pt: 3, pb: 2.5 }}>
            <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2}>
              <Box>
                <Typography variant="h6" component="h2" fontWeight={700}>
                  {editing ? '編輯牌組' : '新增牌組'}
                </Typography>
                <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 0.75 }}>
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: classesMap[panelClass].color
                    }}
                  />
                  <Typography variant="body2" color="text.secondary">
                    {classesMap[panelClass].label}牌組
                  </Typography>
                </Stack>
              </Box>
              <IconButton
                size="small"
                onClick={closeDeckPanel}
                disabled={isDeckPanelBusy}
                aria-label="關閉編輯牌組"
              >
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
                {isCreatePanelOpen && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    這副牌組會建立在目前選取的「{classesMap[newClass].label}」職業下。
                  </Typography>
                )}
                <TextField
                  fullWidth
                  autoFocus
                  label="牌組名稱"
                  value={editing ? editName : newName}
                  onChange={(e) =>
                    editing ? setEditName(e.target.value) : setNewName(e.target.value)
                  }
                  disabled={isDeckPanelBusy}
                  slotProps={{ input: { inputProps: { maxLength: NAME_LIMIT } } }}
                  helperText={`${(editing ? editName : newName).length}/${NAME_LIMIT}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void (editing ? handleEditSave() : handleCreate())
                    }
                  }}
                />
              </Box>

              <Box>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                  牌組分類
                </Typography>
                {isCreatePanelOpen ? (
                  <Box
                    role="group"
                    aria-label="選擇牌組分類"
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                      gap: 1
                    }}
                  >
                    {categories.map((category) => {
                      const selected = newCategoryId === category.id
                      return (
                        <Button
                          key={category.id}
                          variant={selected ? 'contained' : 'outlined'}
                          color={selected ? 'primary' : 'inherit'}
                          onClick={() => setNewCategoryId(category.id)}
                          disabled={isDeckPanelBusy}
                          sx={{ minHeight: 48, fontWeight: selected ? 700 : 500 }}
                        >
                          {getCategoryLabel(category.name)}
                        </Button>
                      )
                    })}
                  </Box>
                ) : (
                  <FormControl fullWidth disabled={isDeckPanelBusy}>
                    <InputLabel>選擇分類</InputLabel>
                    <Select
                      value={editCategoryId ?? ''}
                      label="選擇分類"
                      onChange={(e) =>
                        setEditCategoryId(e.target.value ? String(e.target.value) : null)
                      }
                    >
                      {categories.map((cat) => (
                        <MenuItem key={cat.id} value={cat.id}>
                          {getCategoryLabel(cat.name)}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}
              </Box>

              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                  px: 2,
                  py: 1.5,
                  borderRadius: 2,
                  bgcolor: 'action.hover'
                }}
              >
                <Box>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <StarIcon fontSize="small" color="warning" />
                    <Typography variant="subtitle2" fontWeight={700}>
                      設為預設牌組
                    </Typography>
                  </Stack>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.5 }}
                  >
                    對局偵測到此職業時，會自動帶入這副牌組。
                  </Typography>
                </Box>
                <Switch
                  checked={editing ? editSetDefault : newSetDefault}
                  onChange={(event) =>
                    editing
                      ? setEditSetDefault(event.target.checked)
                      : setNewSetDefault(event.target.checked)
                  }
                  disabled={isDeckPanelBusy}
                  inputProps={{ 'aria-label': '設為預設牌組' }}
                />
              </Box>
            </Stack>
          </Box>

          <Box sx={{ borderTop: 1, borderColor: 'divider', px: 3, py: 2.5 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
              {editing ? (
                <Button
                  color="error"
                  onClick={() => {
                    setDeleting(editing)
                    setEditing(null)
                  }}
                  disabled={isDeckPanelBusy}
                >
                  刪除牌組
                </Button>
              ) : (
                <Box />
              )}
              <Stack direction="row" spacing={1}>
                <Button onClick={closeDeckPanel} disabled={isDeckPanelBusy}>
                  取消
                </Button>
                <Button
                  onClick={() => void (editing ? handleEditSave() : handleCreate())}
                  variant="contained"
                  disabled={isDeckPanelBusy || (!editing && (!newName.trim() || !newCategoryId))}
                >
                  {isDeckPanelBusy ? '儲存中…' : editing ? '儲存變更' : '建立牌組'}
                </Button>
              </Stack>
            </Stack>
          </Box>
        </Box>
      </Drawer>

      {/* 刪除對話框 */}
      <Dialog
        open={!!deleting}
        onClose={() => !deletingBusy && setDeleting(null)}
        maxWidth="xs"
        fullWidth
        style={{ zIndex: 1520 }}
        PaperProps={{ sx: { borderRadius: 3 } }}
      >
        <DialogTitle sx={{ px: 3, pt: 2.5, pb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <DeleteIcon color="error" />
            <Typography variant="h6" component="div" fontWeight={700}>
              刪除牌組？
            </Typography>
          </Stack>
        </DialogTitle>
        <DialogContent sx={{ px: 3, py: 1 }}>
          <Typography variant="body2" color="text.secondary">
            即將刪除「{deleting?.name}」。這不會移除既有對局紀錄，但此操作無法復原。
          </Typography>
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 2 }}>
            <InfoOutlinedIcon fontSize="small" color="action" />
            <Typography variant="caption" color="text.secondary">
              若它是預設牌組，刪除後請為該職業重新指定一副牌組。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2.5 }}>
          <Button onClick={() => setDeleting(null)} disabled={deletingBusy}>
            取消
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDelete()}
            disabled={deletingBusy}
          >
            {deletingBusy ? '刪除中…' : '刪除牌組'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export default DeckManagerControl
