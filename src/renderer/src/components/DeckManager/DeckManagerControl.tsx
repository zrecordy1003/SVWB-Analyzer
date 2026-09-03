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
  InputBase,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  Menu,
  MenuItem,
  Paper
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import AppDialog, { DANGER_ACCENT } from '@renderer/components/Common/AppDialog'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
import DeleteIcon from '@mui/icons-material/Delete'
import SearchIcon from '@mui/icons-material/Search'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import AddDeckFlow from '@renderer/components/DeckBuilder/AddDeckFlow'
import DeckBuilder from '@renderer/components/DeckBuilder/DeckBuilder'
import DeckContentsDrawer from '@renderer/components/DeckCards/DeckContentsDrawer'
import DeckVersionsDialog from '@renderer/components/DeckCards/DeckVersionsDialog'
import type { CorrectVersionRequest } from '@renderer/components/DeckCards/DeckVersionsPanel'
import { groupDeckFamilies, type DeckFamily } from '@renderer/components/DeckCards/deckVersions'
import { classes, classesMap } from '@renderer/map/classMap'
import { cardImageUrl } from '@shared/deckImport'
import { PANEL_SX } from '@renderer/components/Common/surfaces'
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
  /** 代表卡的橫幅（main 的 `pickHeroCard`）。沒有卡表的牌組是 null。 */
  heroBannerHash: string | null
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
  heroBannerHash: string | null
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
 * 牌組卡的代表卡圖。
 *
 * 這一格以前只有職業底色，於是同職業的六副牌長得一模一樣，要靠讀名字才分得
 * 出來——而名字被切到 12 個字。卡圖是這副牌自己的東西，掃過去就認得出是哪一副。
 *
 * 圖是底層，上面壓一層由左而右變透明的遮罩：文字那半邊維持該有的對比，右半邊
 * 讓圖真的看得見。沒有卡表（沒有 hash）或圖抓不到，就退回原本的職業底色——所以
 * 失敗要記在 state 裡，這也是它獨立成一個元件的原因。
 */
const DeckCardArt: React.FC<{ hash: string | null }> = ({ hash }) => {
  const [failed, setFailed] = useState(false)
  const src = cardImageUrl('list', hash)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) return null
  return (
    <>
      <Box
        component="img"
        src={src}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        sx={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          // 靠右切。`list` 是 800x160 的橫幅，左半邊是遊戲拿來壓卡名的白色
          // 漸層，人物固定在右側；卡片只有 2:1 出頭，置中裁等於把那片白底
          // 留在畫面上、人物切掉一半。靠右也剛好和遮罩同向：左邊最暗的地方
          // 是文字，右邊最透的地方是人物。
          objectPosition: 'right center',
          zIndex: 0,
          pointerEvents: 'none'
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          background:
            'linear-gradient(95deg, rgba(16,20,29,0.95) 0%, rgba(16,20,29,0.88) 42%, rgba(16,20,29,0.5) 72%, rgba(16,20,29,0.24) 100%)'
        }}
      />
    </>
  )
}

/**
 * 這一頁的兩個疊層。
 *
 * 牌組管理自己的抽屜是 1500、編輯面板 1510（都是行內寫死的既有值），所以從這裡
 * 開出來的東西要再高一階。建構器是 fullScreen 的 Dialog，預設只有 1300——不抬高
 * 就會整片開在抽屜後面。
 */
const NEW_DECK_DRAWER_Z = 1520
const DECK_BUILDER_Z = 1530
/** 卡表抽屜，以及它自己開出去的建構器／代碼對話框（`zIndex + 10`）。 */
const DECK_CONTENTS_Z = 1540

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
        heroBannerHash: d.heroBannerHash,
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
          heroBannerHash: family.current.heroBannerHash,
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

  /** 新增牌組：整條路（問法 → 建構器）都在 `AddDeckFlow` 裡，和牌組戰績同一份。 */
  const [isAddingDeck, setIsAddingDeck] = useState(false)
  /** 從版本對話框點「修正卡表…」進來的那一版；建構器以修正模式開它。 */
  const [correcting, setCorrecting] = useState<CorrectVersionRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * 就地改名：正在改的那副牌，和輸入框裡的字。
   *
   * 這裡本來是一整個「編輯牌組」抽屜——名稱、分類、設為預設、刪除四件事各一格。
   * 那四件事現在全部就在卡片上：名字後面這支筆、分類 chip、整卡點一下設預設、
   * 右上角的垃圾桶。改一個名字要開一個 440px 的面板，是把最小的那件事做成了
   * 最大的那個動作。
   */
  const [renaming, setRenaming] = useState<Deck | null>(null)
  const [renameText, setRenameText] = useState('')
  const [savingRename, setSavingRename] = useState(false)

  /** 從這一頁開出去的牌組內容（卡表）抽屜，和牌組戰績同一個元件。 */
  const [inspecting, setInspecting] = useState<{ id: number; name: string } | null>(null)

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

  // 就地改分類：卡片上那顆 chip 開的選單，和寫入中的 deckId。
  const [categoryMenu, setCategoryMenu] = useState<{
    anchorEl: HTMLElement
    deck: Deck
  } | null>(null)
  const [categoryBusyId, setCategoryBusyId] = useState<number | null>(null)

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

  /** 一副牌現在的分類物件；沒有分類就是 null。 */
  const categoryOf = (deck: Pick<Deck, 'categoryId'>): DeckCategory | null =>
    categories.find((category) => category.id === deck.categoryId) ?? null

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

  /**
   * 卡片上的分類 chip 直接改分類。
   *
   * 走的是編輯面板同一支 `decks:update`，所以同職業同分類的重名檢查、以及
   * 「分類是整個家族的屬性」都由 main 照舊執行——這裡只是少開一個面板，不是
   * 另一條寫入路徑。沒有樂觀更新：搬分類可能被重名擋下來，先畫成功再收回
   * 比等 20ms 更難看。
   */
  const setCategoryFor = async (deck: Deck, categoryId: string | null) => {
    setCategoryMenu(null)
    if ((deck.categoryId ?? null) === categoryId) return
    try {
      setCategoryBusyId(deck.id)
      const res = (await window.electron.ipcRenderer.invoke('decks:update', {
        id: deck.id,
        categoryId
      })) as Res<DbDeck>
      if (!res.ok)
        throw new Error(res.error === 'DUPLICATE_NAME' ? '該分類下已有同名牌組' : res.error)
      await reloadDecks()
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? '變更分類失敗')
    } finally {
      setCategoryBusyId(null)
    }
  }

  // 切換職業時回到全部分類，讓使用者先看到該職業的完整牌組清單。
  const handleChangeClassTab = (_: unknown, idx: number) => {
    const cls = classes[idx].id as ClassId
    setActiveClass(cls)
    setActiveCategoryId(ALL_CAT)
  }

  /**
   * 新增的路交回一個 deckId 之後：強制重讀共用 cache，並把畫面帶到那一副牌
   * 所在的分類。
   *
   * 命名、分類、卡表都已經在建構器裡問過了（見 `AddDeckFlow`）。這裡要做的只
   * 剩一件事：關掉建構器之後，讓使用者看得到那副牌被放到哪裡去了。
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

  const startRename = (deck: Deck) => {
    setRenaming(deck)
    setRenameText(deck.name)
    setError(null)
  }

  /**
   * 存下就地改的名字。
   *
   * 空白或沒改就當作取消——輸入框失焦也會走到這裡，而「點到旁邊」是離開一個
   * 就地編輯最自然的方式，不該因此跳出一則錯誤。
   */
  const commitRename = async () => {
    if (!renaming) return
    const next = renameText.trim()
    if (!next || next === renaming.name) return setRenaming(null)
    if (next.length > NAME_LIMIT) return setError(`名稱最多 ${NAME_LIMIT} 字`)

    const dup = decks.some(
      (deck) =>
        deck.id !== renaming.id &&
        deck.classId === renaming.classId &&
        deck.categoryId === renaming.categoryId &&
        deck.name.toLowerCase() === next.toLowerCase()
    )
    if (dup) {
      setError('名稱已存在')
      return setRenaming(null)
    }

    try {
      setSavingRename(true)
      const res = (await window.electron.ipcRenderer.invoke('decks:update', {
        id: renaming.id,
        name: next
      })) as Res<DbDeck>
      if (!res.ok) throw new Error(res.error)

      // main 端寫入成功後已經廣播過 `reference-data:changed`；這裡再強制
      // reload 一次是為了不等 debounce，讓抽屜立刻看到自己剛存的結果。
      await reloadDecks()
      setRenaming(null)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? '更新失敗')
      setRenaming(null)
    } finally {
      setSavingRename(false)
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

            {/* 這一頁所有的寫入——設為預設、改名、改分類、新增——都寫這個
                state，而它們全都發生在這個畫面上，所以錯誤也畫在這裡。 */}
            {error && (
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
                    onClick={() => setIsAddingDeck(true)}
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
                        overflow: 'hidden',
                        backgroundColor: `${clazz.bgColor}22`,
                        cursor: 'pointer'
                      }}
                      onClick={() => setInspecting({ id: d.id, name: d.name })}
                    >
                      <DeckCardArt hash={d.heroBannerHash} />

                      {/* 整張卡片可點：展開牌組資訊（卡表／編輯）。設為預設改到
                          星星圖示上，兩件事不再共用同一個點擊區。 */}
                      <CardActionArea
                        sx={{ position: 'absolute', inset: 0, borderRadius: 2, zIndex: 0 }}
                      />

                      <Stack
                        direction="row"
                        alignItems="flex-start"
                        justifyContent="space-between"
                        gap={1}
                        sx={{ position: 'relative', zIndex: 1 }}
                      >
                        <Stack
                          direction="row"
                          alignItems="center"
                          spacing={0.5}
                          // 這一叢在兩種狀態下佔一樣寬，所以進編輯模式時版面
                          // 一個像素都不動：靜止時是 `noWrap` 的標題自己截斷，
                          // 編輯時是輸入框把同一塊空間吃滿。
                          sx={{ flex: 1, minWidth: 0, pr: 0.5 }}
                          // 改名的輸入框和它的筆都活在整卡「設為預設」的點擊區
                          // 裡面，所以這一叢自己吞掉點擊：在名字上打字不該順便
                          // 把這副牌設成預設。
                          onClick={(e) => e.stopPropagation()}
                        >
                          {renaming?.id === d.id ? (
                            <InputBase
                              autoFocus
                              value={renameText}
                              disabled={savingRename}
                              onChange={(e) => setRenameText(e.target.value)}
                              onBlur={() => void commitRename()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  void commitRename()
                                }
                                if (e.key === 'Escape') {
                                  e.preventDefault()
                                  setRenaming(null)
                                }
                              }}
                              inputProps={{ maxLength: NAME_LIMIT, 'aria-label': '牌組名稱' }}
                              // 字級、字重、行高都和它取代的那行標題一模一樣，
                              // 外框拿掉只留下一條底線——就是 hover 時已經看到的
                              // 那一條。點下去畫面上唯一變的是多了一個游標，而
                              // 不是原地長出一個輸入框。
                              sx={{
                                flex: 1,
                                minWidth: 0,
                                p: 0,
                                fontSize: 14,
                                fontWeight: 700,
                                // 和靜止時的名字同一個行高，那條線才會停在原地。
                                lineHeight: 1.25,
                                color: 'text.primary',
                                '& .MuiInputBase-input': {
                                  p: 0,
                                  height: 'auto',
                                  borderBottom: '1px solid',
                                  borderColor: 'primary.main'
                                }
                              }}
                            />
                          ) : (
                            /* 名字和筆是同一個按鈕：使用者要點的是「這個名字」，
                               而那支 14px 的筆本來是整張卡上最難命中的目標。
                               底線永遠畫著、只是透明的，hover 才上色——這樣滑過去
                               不會把下面那排 chip 推掉一個像素。

                               沒有 tooltip：底線和筆已經在說「這裡可以點」，而
                               現在整個名字都是熱區，一塊浮出來的說明只會蓋住底下
                               的分類。 */
                            <Box
                              role="button"
                              tabIndex={0}
                              data-testid={`deck-manager-rename-${d.familyId}`}
                              aria-label={`重新命名 ${d.name}`}
                              onClick={() => startRename(d)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault()
                                  startRename(d)
                                }
                              }}
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.25,
                                minWidth: 0,
                                cursor: 'text',
                                // 底線畫成 border 而不是 text-decoration：
                                // `noWrap` 為了做 ellipsis 帶著 `overflow:
                                // hidden`，那會把偏移出去的 underline 裁掉——
                                // 計算樣式明明是白的，畫面上什麼都沒有。border
                                // 畫在邊框盒上，不受 overflow 影響，而且和編輯
                                // 狀態那條線是同一種東西、同一個位置：點下去
                                // 只是它換了個顏色。
                                '& .deck-name': {
                                  // 行高收到貼著字，底線才會像超連結那樣就在字
                                  // 下面，而不是掉在 subtitle2 那個 1.57 行框的
                                  // 底部、離字四五個像素。這一列的高度是右邊那
                                  // 排 icon 按鈕撐出來的，所以收行高不動版面。
                                  lineHeight: 1.25,
                                  borderBottom: '1px solid transparent',
                                  transition: 'border-color .15s'
                                },
                                '&:hover .deck-name, &:focus-visible .deck-name': {
                                  borderColor: 'rgba(255,255,255,0.5)'
                                },
                                '&:hover .deck-pencil, &:focus-visible .deck-pencil': {
                                  color: 'primary.light'
                                }
                              }}
                            >
                              <Typography
                                className="deck-name"
                                variant="subtitle2"
                                fontWeight={700}
                                noWrap
                              >
                                {displayName(d.name)}
                              </Typography>
                              <EditIcon
                                className="deck-pencil"
                                sx={{
                                  fontSize: 13,
                                  flexShrink: 0,
                                  color: 'text.disabled',
                                  transition: 'color .15s'
                                }}
                              />
                            </Box>
                          )}
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
                          <Tooltip title={isDefault ? '預設牌組' : '設為預設'}>
                            <span>
                              <IconButton
                                size="small"
                                data-testid={`deck-manager-setdefault-${d.familyId}`}
                                aria-label={isDefault ? '預設牌組' : '設為預設'}
                                disabled={defaultBusyId === d.id}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void setDefaultForClass(d)
                                }}
                              >
                                {isDefault ? (
                                  <StarIcon color="warning" fontSize="small" />
                                ) : (
                                  <StarBorderIcon fontSize="small" />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                          {/* 卡表。開的是牌組戰績點一副牌時開的同一個抽屜，
                              「看卡表 → 編輯牌組 → 建構器」整條路都一樣，所以
                              這裡不自己再做一遍，只是多一個入口。 */}
                          <Tooltip title="牌組內容與編輯">
                            <IconButton
                              size="small"
                              data-testid={`deck-manager-contents-${d.familyId}`}
                              aria-label="牌組內容與編輯"
                              onClick={(e) => {
                                e.stopPropagation()
                                setInspecting({ id: d.id, name: d.name })
                              }}
                            >
                              <StyleOutlinedIcon fontSize="small" />
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

                      <Stack
                        direction="row"
                        alignItems="center"
                        justifyContent="space-between"
                        // `mr: -0.75` matches the top icon row's own offset, so
                        // 版本歷史 lands on the same right edge as 刪除 above it
                        // instead of sitting a button-padding's width short of it.
                        sx={{ position: 'relative', zIndex: 1, mt: 0.5, mr: -0.75 }}
                      >
                        {/* 分類是就地可改的：點它直接挑，不必為了搬一副牌的分類
                            走一趟編輯面板。未分類畫得比有分類的淡——它不是一個
                            分類的名字，是「還沒分」，不該和真的分類一樣重。 */}
                        <Chip
                          size="small"
                          variant="outlined"
                          clickable
                          data-testid={`deck-manager-category-${d.familyId}`}
                          aria-label={categoryOf(d) ? '變更分類' : '設定分類'}
                          disabled={categoryBusyId === d.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            setCategoryMenu({ anchorEl: e.currentTarget, deck: d })
                          }}
                          label={categoryOf(d) ? getCategoryLabel(categoryOf(d)!.name) : '未分類'}
                          sx={{
                            height: 22,
                            fontWeight: 600,
                            ...(categoryOf(d)
                              ? {}
                              : {
                                  color: 'rgba(255,255,255,0.42)',
                                  borderColor: 'rgba(255,255,255,0.14)',
                                  fontWeight: 500
                                }),
                            '&:hover': { borderColor: 'primary.main', color: 'text.primary' }
                          }}
                        />
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

      {/* 分類選單。zIndex 要壓過牌組管理抽屜的 1500——MUI 的 Popover 吃的是主題
          的 modal 層（1300），開在抽屜「後面」就等於整個選單看不見。 */}
      <Menu
        anchorEl={categoryMenu?.anchorEl ?? null}
        open={!!categoryMenu}
        onClose={() => setCategoryMenu(null)}
        sx={{ zIndex: 1600 }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { minWidth: 168, ...PANEL_SX, backgroundColor: '#242832' } } }}
      >
        {categoryMenu &&
          categories.map((cat) => (
            <MenuItem
              key={cat.id}
              selected={categoryMenu.deck.categoryId === cat.id}
              onClick={() => void setCategoryFor(categoryMenu.deck, cat.id)}
            >
              {getCategoryLabel(cat.name)}
            </MenuItem>
          ))}
        {categoryMenu && (
          <MenuItem
            selected={categoryMenu.deck.categoryId == null}
            onClick={() => void setCategoryFor(categoryMenu.deck, null)}
            sx={{ color: 'text.secondary' }}
          >
            未分類
          </MenuItem>
        )}
      </Menu>

      {/* 牌組內容（卡表）。和牌組戰績點一副牌時開的是同一個抽屜、同一條
          「編輯牌組 → 建構器」的路，只是入口在這一頁的卡片上。要抬到牌組管理
          抽屜（1500）之上，不然會開在它後面。 */}
      <DeckContentsDrawer
        open={inspecting !== null}
        deckId={inspecting?.id ?? null}
        deckName={inspecting?.name ?? ''}
        categories={allCategories}
        zIndex={DECK_CONTENTS_Z}
        onClose={() => setInspecting(null)}
        onSaved={() => void reloadDecks()}
      />

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

      {/* 新增牌組：整條路和牌組戰績是同一個元件，所以兩頁不可能再走偏。職業帶
          目前這個分頁的——這一頁的每一個畫面都已經是「某一個職業的牌組」，到了
          建構器再問一次就是把答過的問題再問一遍。這一頁的抽屜自己在 1500。 */}
      <AddDeckFlow
        open={isAddingDeck}
        klass={activeClass}
        categories={categories}
        zIndex={NEW_DECK_DRAWER_Z}
        onClose={() => setIsAddingDeck(false)}
        onSaved={(deckId) => void handleDeckArrived(deckId)}
      />
    </>
  )
}

export default DeckManagerControl
