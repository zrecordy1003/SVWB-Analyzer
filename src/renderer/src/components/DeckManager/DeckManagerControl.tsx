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
import AppDialog, { DANGER_ACCENT } from '@renderer/components/Common/AppDialog'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import DeckBuilder from '@renderer/components/DeckBuilder/DeckBuilder'
import NewDeckDrawer from '@renderer/components/DeckBuilder/NewDeckDrawer'
import DeckVersionsDialog from '@renderer/components/DeckCards/DeckVersionsDialog'
import type { CorrectVersionRequest } from '@renderer/components/DeckCards/DeckVersionsPanel'
import { groupDeckFamilies, type DeckFamily } from '@renderer/components/DeckCards/deckVersions'
import { classes, classesMap } from '@renderer/map/classMap'
import type { ClassName } from '@shared/domain'
import { useDecksTags, type DeckLite } from '@renderer/hooks/useDecksTags'

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
type DbDeck = {
  id: number
  name: string
  class: ClassName
  categoryId: string | null
  isDefault?: boolean
  familyId?: number | null
  archivedAt?: string | number | Date | null
  createdAt?: string | number | Date
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
  /** 版本（docs/deck-versioning-plan.md）：這張卡片代表一個家族的當前版本。 */
  familyId: number
  versionCount: number
  currentVersion: number
}

/** 一個版本列，給 `groupDeckFamilies` 與版本對話框用的形狀。 */
type VersionDeck = {
  id: number
  name: string
  classId: ClassId
  categoryId: string | null
  isDefault: boolean
  familyId: number | null
  archivedAt: number | null
  createdAt: number
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

/**
 * 這一頁的兩個疊層。
 *
 * 牌組管理自己的抽屜是 1500、編輯面板 1510（都是行內寫死的既有值），所以從這裡
 * 開出來的東西要再高一階。建構器是 fullScreen 的 Dialog，預設只有 1300——不抬高
 * 就會整片開在抽屜後面。
 */
const NEW_DECK_DRAWER_Z = 1520
const DECK_BUILDER_Z = 1530

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

  /**
   * 牌組/分類資料來自 `useDecksTags` 共用的 module-level cache，而不是這個
   * 元件自己的一份 state：這個抽屜常駐在 App 頂層不會 unmount，過去自己維護
   * 一份 `decks` state 只在自己的新增/編輯流程後 reload，導致牌組戰績那邊
   * 新增的牌組完全不會反映到這裡。改吃共用 cache 之後，main process 既有的
   * `reference-data:changed` 廣播會讓所有訂閱者（含這裡）自動同步，而且多個
   * 訂閱者共用同一次 IPC 查詢，不會各自重打一份。
   */
  const {
    allDeckVersions,
    allCategories,
    reload: reloadDecks,
    error: decksLoadError,
    setDefaultOptimistic
  } = useDecksTags()

  const categories: DeckCategory[] = useMemo(
    () => allCategories.map((c) => ({ id: c.id, name: c.name })),
    [allCategories]
  )

  /** 全部版本，依家族分好。清單上的卡片是各家族的當前版本；版本對話框看這個。 */
  const families: DeckFamily<VersionDeck>[] = useMemo(() => {
    const versions: VersionDeck[] = allDeckVersions
      .filter((d): d is DeckLite & { classId: ClassId } => d.classId != null)
      .map((d) => ({
        id: d.id,
        name: d.name,
        classId: d.classId,
        categoryId: d.deckCategoryId,
        isDefault: d.isDefault,
        familyId: d.familyId,
        archivedAt: d.archivedAt,
        createdAt: d.createdAt
      }))
    return groupDeckFamilies(versions)
  }, [allDeckVersions])

  // 這一頁不顯示封存的牌組：它管的是「現在打哪副牌、哪副是預設」，退役的牌
  // 組去牌組戰績那邊開「顯示已封存」看。
  const decks: Deck[] = useMemo(
    () =>
      families
        .filter((family) => !family.archived)
        .map((family) => ({
          id: family.current.id,
          name: family.current.name,
          classId: family.current.classId,
          categoryId: family.current.categoryId,
          isDefault: family.current.isDefault,
          familyId: family.familyId,
          versionCount: family.versions.length,
          currentVersion:
            family.versions.find((v) => v.deck.id === family.current.id)?.number ??
            family.versions.length
        })),
    [families]
  )

  const loadError = decksLoadError
    ? ((decksLoadError as any)?.message ?? String(decksLoadError))
    : null

  /** 開著版本對話框的家族。 */
  const [versionsFamilyId, setVersionsFamilyId] = useState<number | null>(null)
  /** 剛匯入/建立、還在等它出現在共用 cache 裡的那副牌——見 `handleDeckArrived`。 */
  const [pendingFocusDeckId, setPendingFocusDeckId] = useState<number | null>(null)

  // Tabs 狀態：一律從「全部」開始，避免預設牌組或上次瀏覽狀態改變使用者視野。
  const [activeClass, setActiveClass] = useState<ClassId>('witch')
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(ALL_CAT)

  /**
   * 新增牌組的兩道門，和牌組戰績、對局紀錄用的是同一個元件。
   *
   * 這裡本來有自己一份「名稱 + 分類 + 設為預設」的建立表單，於是 app 裡有三個
   * 長得不一樣的「新增牌組」，而這一份還是唯一連不到匯入與建構器的那個。名稱、
   * 分類與預設沒有消失——建好之後這一頁的編輯面板就在旁邊，那本來就是它的工作。
   */
  const [isNewDeckDrawerOpen, setIsNewDeckDrawerOpen] = useState(false)
  const [isBuilderOpen, setIsBuilderOpen] = useState(false)
  /** 從版本對話框點「修正卡表…」進來的那一版；建構器以修正模式開它。 */
  const [correcting, setCorrecting] = useState<CorrectVersionRequest | null>(null)
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
  // 這副牌（含歷代版本）底下有幾場對局。null = 還在問。打過的牌組刪掉後戰績
  // 要留（主行程把它標成已刪除而不是移除），確認框的文字得先知道這個數字才講得對。
  const [deleteImpact, setDeleteImpact] = useState<{ matches: number; versions: number } | null>(
    null
  )

  useEffect(() => {
    if (!deleting) {
      setDeleteImpact(null)
      return
    }
    let mounted = true
    void window.electron.ipcRenderer
      .invoke('decks:deleteImpact', { id: deleting.id })
      .then((res: Res<{ matches: number; versions: number }>) => {
        if (mounted && res.ok) setDeleteImpact(res.data)
      })
      .catch(() => {
        /* 問不到就退回一般文字，不擋刪除。 */
      })
    return () => {
      mounted = false
    }
  }, [deleting])

  // 設定預設時的忙碌 deckId（避免連點）
  const [defaultBusyId, setDefaultBusyId] = useState<number | null>(null)

  const versionsFamily = useMemo(
    () => families.find((f) => f.familyId === versionsFamilyId) ?? null,
    [families, versionsFamilyId]
  )

  // 版本對話框開著的家族被刪到整副牌組消失時，對話框沒有東西可以再顯示。
  useEffect(() => {
    if (versionsFamilyId !== null && !families.some((f) => f.familyId === versionsFamilyId)) {
      setVersionsFamilyId(null)
    }
  }, [families, versionsFamilyId])

  // 剛匯入/建立的牌組要等它出現在共用 cache 裡才找得到——`reloadDecks()` 是
  // force fetch，不等 debounce，但終究還是一次 IPC 往返，不是同步的。
  useEffect(() => {
    if (pendingFocusDeckId == null) return
    const arrived = decks.find((d) => d.id === pendingFocusDeckId)
    if (!arrived) return
    setActiveClass(arrived.classId)
    setActiveCategoryId(arrived.categoryId ?? ALL_CAT)
    setPendingFocusDeckId(null)
    setError(null)
  }, [pendingFocusDeckId, decks])

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

  /**
   * 設為該職業預設（交易 API，唯一性由後端保證）。
   *
   * 這是唯一還做樂觀更新的寫入：點下去要立刻看到星號換人，不等 IPC 往返。
   * `setDefaultOptimistic` 寫的是共用 cache，所以任何其他訂閱者（例如同時
   * 開著的牌組戰績頁）也會馬上看到同一個結果，而不是只有這個抽屜自己超前。
   * 失敗就強制重讀，把樂觀寫入蓋回真實狀態。
   */
  const setDefaultForClass = async (deck: Deck) => {
    try {
      setDefaultBusyId(deck.id)
      setDefaultOptimistic(deck.id, deck.classId)
      const res = (await window.electron.ipcRenderer.invoke('decks:setDefaultForClass', {
        deckId: deck.id
      })) as Res<DbDeck>
      if (!res.ok) throw new Error(res.error)
    } catch (err: any) {
      setError(err?.message ?? '設定預設失敗')
      void reloadDecks()
    } finally {
      setDefaultBusyId(null)
    }
  }

  // 切換職業時回到全部分類，讓使用者先看到該職業的完整牌組清單。
  const handleChangeClassTab = (_: unknown, idx: number) => {
    const cls = classes[idx].id as ClassId
    setActiveClass(cls)
    setActiveCategoryId(ALL_CAT)
  }

  /**
   * 新增的門帶回一個 deckId 之後：強制重讀共用 cache，並把畫面帶到那一副牌
   * 所在的分類。
   *
   * 匯進來的牌組會被自動命名、也不會是預設——那些是「建好之後」的事，而這一頁的
   * 編輯面板就在旁邊。把視野移到它身上，就是告訴使用者「它在這裡，要改就從這裡改」。
   *
   * `reloadDecks()` 只保證發起 force fetch，不保證這個元件下一次 render 就看
   * 得到它——那筆更新要等 hook 的 snapshot 換過一輪。所以這裡記下
   * `pendingFocusDeckId`，交給旁邊那個 effect 在 `decks` 真的更新後再對焦。
   */
  const handleDeckArrived = async (deckId: number): Promise<void> => {
    setPendingFocusDeckId(deckId)
    try {
      await reloadDecks()
    } catch (err: any) {
      setError(err?.message ?? '讀取牌組失敗')
    }
  }

  // 這個面板現在只做編輯。新增走的是 `NewDeckDrawer`，和其他兩個入口同一個。
  const isDeckPanelOpen = !!editing
  const isDeckPanelBusy = savingEdit
  const panelClass = editing?.classId ?? activeClass
  const closeDeckPanel = () => {
    if (isDeckPanelBusy) return
    setEditing(null)
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

      // main 端寫入成功後已經廣播過 `reference-data:changed`；這裡再強制
      // reload 一次是為了不等 debounce，讓抽屜立刻看到自己剛存的結果。
      await reloadDecks()
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
      })) as Res<{ success: true; deleted: number; archived: number }>

      if (!res.ok) throw new Error(res.error)
      await reloadDecks()
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
            <Stack direction="row" alignItems="center" spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
              {/* 這一塊講的是「目前是哪個職業」，徽章擺在最前面正是它要回答的問題。 */}
              <ClassIcon id={activeClass} size={30} />
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  variant="caption"
                  fontSize="11px"
                  sx={{ opacity: 0.6, lineHeight: 1.3 }}
                  noWrap
                >
                  {label}
                </Typography>
                <Typography
                  variant="body2"
                  fontSize="15px"
                  fontWeight={600}
                  sx={{ color: classesMap[activeClass]?.color, lineHeight: 1.3 }}
                  noWrap
                >
                  {defaultDeckOfActive?.name ?? '未設定'}
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

            {/* `error` 過去只畫在編輯面板裡，於是「設為預設」失敗是無聲的——那顆
                操作根本不會開那個面板。現在新增的門也寫這個 state，所以它得有一個
                在主畫面看得到的位置。 */}
            {error && !isDeckPanelOpen && (
              <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
                {error}
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
                {/* 這條提示條的底色已經是目前職業的顏色，徽章把它說成一件
                    看得出來的事，而不必先讀完那句話才知道講的是哪個職業。 */}
                <ClassIcon id={activeClass} size={20} />
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
                    <Stack direction="row" alignItems="center" gap={0.75}>
                      {/* 八個分頁的差別就是職業，所以徽章擺在名字前面：掃這一排
                          時圖形比一行字先被認出來。18px 而不是清單的 20px -
                          分頁的字比較小，徽章跟著小一號才不會把分頁撐高。 */}
                      <ClassIcon id={c.id} size={18} />
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
                    onClick={() => setIsNewDeckDrawerOpen(true)}
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
                      data-testid={`deck-manager-card-${d.familyId}`}
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
                        <Stack
                          direction="row"
                          alignItems="center"
                          spacing={0.75}
                          sx={{ minWidth: 0, pr: 1 }}
                        >
                          <Typography variant="subtitle2" fontWeight={700} noWrap>
                            {displayName(d.name)}
                          </Typography>
                          {/* fork 過才掛版本號：一副只有 v1 的牌，「v1」沒講出任何事。 */}
                          {d.versionCount > 1 && (
                            <Chip
                              size="small"
                              label={`v${d.currentVersion}`}
                              data-testid="deck-manager-version-badge"
                              sx={{
                                height: 18,
                                fontSize: 10.5,
                                fontWeight: 800,
                                flexShrink: 0,
                                bgcolor: 'rgba(122,162,247,0.16)'
                              }}
                            />
                          )}
                        </Stack>

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
                          <Tooltip title={`版本歷史（${d.versionCount}）`}>
                            <IconButton
                              size="small"
                              data-testid={`deck-manager-versions-${d.familyId}`}
                              aria-label="版本歷史"
                              onClick={(e) => {
                                e.stopPropagation()
                                setVersionsFamilyId(d.familyId)
                              }}
                            >
                              <HistoryRoundedIcon fontSize="small" />
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
                  編輯牌組
                </Typography>
                <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 0.75 }}>
                  <ClassIcon id={panelClass} size={18} />
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
                <TextField
                  fullWidth
                  autoFocus
                  label="牌組名稱"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={isDeckPanelBusy}
                  slotProps={{ input: { inputProps: { maxLength: NAME_LIMIT } } }}
                  helperText={`${editName.length}/${NAME_LIMIT}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleEditSave()
                    }
                  }}
                />
              </Box>

              <Box>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                  牌組分類
                </Typography>
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
                  checked={editSetDefault}
                  onChange={(event) => setEditSetDefault(event.target.checked)}
                  disabled={isDeckPanelBusy}
                  inputProps={{ 'aria-label': '設為預設牌組' }}
                />
              </Box>
            </Stack>
          </Box>

          <Box sx={{ borderTop: 1, borderColor: 'divider', px: 3, py: 2.5 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
              <Button
                color="error"
                onClick={() => {
                  if (!editing) return
                  setDeleting(editing)
                  setEditing(null)
                }}
                disabled={isDeckPanelBusy}
              >
                刪除牌組
              </Button>
              <Stack direction="row" spacing={1}>
                <Button onClick={closeDeckPanel} disabled={isDeckPanelBusy}>
                  取消
                </Button>
                <Button
                  onClick={() => void handleEditSave()}
                  variant="contained"
                  disabled={isDeckPanelBusy || !editName.trim()}
                >
                  {isDeckPanelBusy ? '儲存中…' : '儲存變更'}
                </Button>
              </Stack>
            </Stack>
          </Box>
        </Box>
      </Drawer>

      {/* 刪除對話框 */}
      <AppDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        busy={deletingBusy}
        maxWidth="xs"
        title="刪除牌組？"
        icon={<DeleteIcon fontSize="small" />}
        accent={DANGER_ACCENT}
        // Opened from the manager drawer, which would otherwise paint over it.
        zIndex={1520}
        actions={
          <>
            <Button
              onClick={() => setDeleting(null)}
              disabled={deletingBusy}
              sx={{ textTransform: 'none' }}
            >
              取消
            </Button>
            <Button
              color="error"
              variant="contained"
              disableElevation
              onClick={() => void handleDelete()}
              disabled={deletingBusy}
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
            >
              {deletingBusy ? '刪除中…' : '刪除牌組'}
            </Button>
          </>
        }
      >
        <Typography variant="body2" color="text.secondary">
          {deleteImpact && deleteImpact.matches > 0
            ? `即將刪除「${deleting?.name}」。它有 ${deleteImpact.matches} 場對局，刪除後戰績會保留，只是牌組不再出現在清單與挑選選單。`
            : deleteImpact
              ? `即將刪除「${deleting?.name}」。這副牌組還沒打過，會直接移除，無法復原。`
              : `即將刪除「${deleting?.name}」。已經打過的對局與戰績會保留。`}
        </Typography>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 2 }}>
          <InfoOutlinedIcon fontSize="small" color="action" />
          <Typography variant="caption" color="text.secondary">
            若它是預設牌組，刪除後請為該職業重新指定一副牌組。
          </Typography>
        </Stack>
      </AppDialog>

      {/* 版本歷史：一副牌的歷代卡表、各版本的場次與勝率、版本間的差異，以及
          「刪除此版本」。和牌組戰績展開列裡的是同一個面板。 */}
      <DeckVersionsDialog
        open={versionsFamily !== null}
        family={versionsFamily}
        zIndex={1520}
        onClose={() => setVersionsFamilyId(null)}
        onChanged={() => void reloadDecks()}
        onCorrect={(request) => setCorrecting(request)}
      />

      {/* 修正某一版的卡表：建構器開在版本對話框之上，存檔直接改寫那一版。 */}
      {correcting && (
        <DeckBuilder
          open
          deckId={correcting.deckId}
          correction={{ versionLabel: correcting.versionLabel }}
          categories={categories}
          zIndex={DECK_BUILDER_Z}
          onClose={() => setCorrecting(null)}
          onSaved={() => void reloadDecks()}
        />
      )}

      {/* 新增牌組：和牌組戰績、對局紀錄同一個元件、同一份內容。這一頁的抽屜自己
          在 1500，所以要疊得比它高。 */}
      <NewDeckDrawer
        open={isNewDeckDrawerOpen}
        klass={activeClass}
        zIndex={NEW_DECK_DRAWER_Z}
        onClose={() => setIsNewDeckDrawerOpen(false)}
        onOpenDeck={(deckId) => void handleDeckArrived(deckId)}
        onBuildManually={() => setIsBuilderOpen(true)}
      />

      {/* 手動建立帶著目前這個職業分頁的職業進去——這一頁的每一個畫面都已經是
          「某一個職業的牌組」，到了建構器再問一次職業就是把已經回答過的問題
          再問一遍。 */}
      {isBuilderOpen && (
        <DeckBuilder
          open
          categories={categories}
          initialClass={activeClass}
          zIndex={DECK_BUILDER_Z}
          onClose={() => setIsBuilderOpen(false)}
          onSaved={() => void reloadDecks()}
        />
      )}
    </>
  )
}

export default DeckManagerControl
