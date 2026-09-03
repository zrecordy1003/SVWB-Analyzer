/**
 * The deck builder: card pool on the left, deck on the right.
 *
 * Laid out the way the official Deck Portal lays it out, on purpose - anyone
 * who builds decks already has the muscle memory, and a different arrangement
 * would only make them look for things.
 *
 * Two rules come from the portal's own data rather than from us: the per-card
 * copy limit is `deckEnabledNum` (so a card whose limit changes needs no code
 * change here), and the pool is fetched one class at a time because the
 * endpoint refuses to answer for all of them at once.
 *
 * The pool comes from disk, never from the network: `cards:pool` reads what is
 * cached and reports whether that slice was ever fetched. Filling it is somebody
 * else's job - the startup bootstrap does it in the background, and the refresh
 * button re-does one slice on demand - so this component never has to decide
 * whether spending 560KB of the user's connection is appropriate.
 */
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  IconButton,
  InputAdornment,
  InputBase,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import SearchIcon from '@mui/icons-material/Search'
import RefreshIcon from '@mui/icons-material/Refresh'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import {
  cardImageUrl,
  CLASS_NAME_TO_ID,
  DECK_NAME_MAX_LEN,
  suggestDeckName,
  type PoolCard,
  type StoredDeckCard
} from '@shared/deckImport'
import type { ClassName } from '@shared/domain'
import { classesMap } from '@renderer/map/classMap'
import { ClassSelect } from '@renderer/components/Common/filters/ClassSelect'
import CardTooltip from '@renderer/components/DeckCards/CardTooltip'
import ManaCurve from '@renderer/components/DeckCards/ManaCurve'
import { cardTextToPlain } from '@shared/cardText'
import {
  BAR_SX,
  CANVAS_BG,
  CARD_CELL_SX,
  HAIRLINE_BOTTOM,
  HAIRLINE_RIGHT,
  PANEL_SX
} from '@renderer/components/Common/surfaces'
import { SegmentedControl } from '@renderer/components/Common/SegmentedControl'
import { CategorySelect } from '@renderer/components/Common/filters/CategorySelect'
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded'
import { ThemeProvider, createTheme, useTheme } from '@mui/material/styles'
import React from 'react'

/** A full deck is 40 cards; the portal enforces the same number. */
const DECK_SIZE = 40

/**
 * 牌組名稱欄。
 *
 * 和它右邊的分類、左邊的職業一樣是一顆軟填充藥丸，不是 MUI 預設那個 outlined
 * ＋浮動 label 的表單欄位——見 `CONTROL_SX` 的註解。名稱上限只有 8 個字，所以
 * 字數就寫在框裡右側；滿了才變色，打字的時候不必一直盯著它。
 */
function DeckNameField({
  value,
  onChange,
  placeholder,
  height = 40,
  width = 190
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  height?: number
  width?: number
}): React.JSX.Element {
  const full = value.length >= DECK_NAME_MAX_LEN
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        height,
        width,
        px: 1.5,
        borderRadius: 2,
        bgcolor: 'action.hover',
        border: '1px solid',
        borderColor: 'divider',
        transition: 'background-color .15s, border-color .15s',
        '&:hover': { bgcolor: 'action.selected', borderColor: 'text.disabled' },
        '&:focus-within': { borderColor: 'primary.main', bgcolor: 'action.selected' }
      }}
    >
      <DriveFileRenameOutlineRoundedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
      <InputBase
        fullWidth
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputProps={{ maxLength: DECK_NAME_MAX_LEN, 'aria-label': '牌組名稱' }}
        sx={{ fontSize: 14, fontWeight: 700 }}
      />
      <Typography
        variant="caption"
        sx={{
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
          color: full ? 'warning.main' : 'rgba(255,255,255,0.32)'
        }}
      >
        {value.length}/{DECK_NAME_MAX_LEN}
      </Typography>
    </Box>
  )
}

/**
 * 一張卡在牌組裡的張數：`−  2  +`。
 *
 * 這裡原本是「×2」加一顆只會減的按鈕，加牌只能回左邊的卡池點——但使用者調張數
 * 的時候看的是右邊這份清單，手邊卻只有一半的操作。兩顆按鈕夾著數字是這件事最
 * 直接的說法，`×` 也就不必再寫：一顆 `+` 和一顆 `−` 已經說明中間那個數字是
 * 幾張了。
 *
 * `+` 在到達這張卡的張數上限、或牌組滿 40 張時停用；`−` 永遠可按（能看到這一
 * 列就表示至少有一張）。
 */
function CountStepper({
  count,
  canAdd,
  onAdd,
  onRemove,
  onBanner
}: {
  count: number
  canAdd: boolean
  onAdd: () => void
  onRemove: () => void
  /** 這一列有卡圖當底：整組要自己變暗，不能靠背景色。 */
  onBanner: boolean
}): React.JSX.Element {
  const buttonSx = {
    width: 20,
    height: 20,
    borderRadius: 1,
    fontSize: 15,
    fontWeight: 900,
    lineHeight: 1,
    color: onBanner ? '#fff' : 'text.secondary',
    transition: 'background-color .12s, color .12s',
    '&:hover': {
      bgcolor: onBanner ? 'rgba(255,255,255,0.22)' : 'action.selected',
      color: 'text.primary'
    },
    '&.Mui-disabled': { opacity: 0.32 }
  } as const

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.25}
      sx={{
        flexShrink: 0,
        p: '2px',
        borderRadius: 1.5,
        bgcolor: onBanner ? 'rgba(0,0,0,0.62)' : 'action.hover',
        border: '1px solid',
        borderColor: onBanner ? 'rgba(255,255,255,0.16)' : 'divider'
      }}
    >
      <ButtonBase onClick={onRemove} aria-label="減少一張" sx={buttonSx}>
        −
      </ButtonBase>
      <Box
        sx={{
          minWidth: 16,
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          color: onBanner ? '#fff' : 'text.primary',
          textShadow: onBanner ? '0 1px 3px rgba(0,0,0,.95)' : undefined
        }}
      >
        {count}
      </Box>
      <ButtonBase onClick={onAdd} disabled={!canAdd} aria-label="增加一張" sx={buttonSx}>
        ＋
      </ButtonBase>
    </Stack>
  )
}
/** Fallback when the portal did not say. Three is the game's general rule. */
const DEFAULT_COPY_LIMIT = 3

const FORMATS = [
  { id: '1', label: '指定系列' },
  { id: '2', label: '無限制' }
]

const COST_BUCKETS = [0, 1, 2, 3, 4, 5, 6, 7] as const

type Category = { id: string; name: string }

/**
 * 「修正卡表」模式：存檔直接改寫 `deckId` 那一版，不建立新版本。`versionLabel`
 * 只給橫幅用（建構器自己不知道它是第幾版）。
 */
export type DeckCorrection = { versionLabel: string }

export default function DeckBuilder({
  open,
  categories,
  /** Set to edit an existing deck; omit to build a new one. */
  deckId = null,
  correction = null,
  initialClass,
  zIndex,
  onClose,
  onSaved
}: {
  open: boolean
  categories: Category[]
  deckId?: number | null
  /**
   * 由版本列的「修正卡表…」開啟時帶進來。平常存檔不出現任何版本字眼——一副
   * 打過的牌改了就是新版本，使用者不必知道；這條是給「輸入錯了」的逃生門
   * （plan 3.2），頂部一條橫幅講清楚存檔會做什麼。
   */
  correction?: DeckCorrection | null
  /**
   * 開新牌組時預選的職業。
   *
   * 從牌組管理的某個職業分頁、或對局紀錄的某一側點進來時，職業已經是確定的了，
   * 而讓使用者在建構器裡再選一次不只多一步，還多一個選錯的機會。編輯既有牌組時
   * 這個值不生效——那副牌自己的職業才是對的。
   */
  initialClass?: ClassName
  /**
   * 疊在已經浮著的東西上面時要抬高。
   *
   * 建構器是個 fullScreen 的 Dialog，預設層級 1300；牌組管理的抽屜自己就在 1500，
   * 不抬高的話從那裡點「手動建立」會開在抽屜後面。
   */
  zIndex?: number
  onClose: () => void
  /**
   * 存好之後帶回實際寫入的那一列。編輯一副打過的牌會 fork 出新版本，`id` 就
   * 不再是傳進來的 `deckId`——呼叫端若還盯著舊 id 看，看到的會是舊卡表。
   */
  onSaved: (saved: { id: number }) => void
}) {
  const [className, setClassName] = React.useState<ClassName>(initialClass ?? 'elf')
  const [battleFormat, setBattleFormat] = React.useState('2')
  const classId = CLASS_NAME_TO_ID[className]

  const [pool, setPool] = React.useState<PoolCard[]>([])
  const [syncedAt, setSyncedAt] = React.useState<number | null>(null)
  const [poolLoading, setPoolLoading] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [showImages, setShowImages] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [counts, setCounts] = React.useState<Map<number, number>>(new Map())
  const [deckName, setDeckName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  /** 修正模式的橫幅要講「這一版有 N 場對局」；問 `decks:versionImpact`。null = 還在問。 */
  const [correctionMatches, setCorrectionMatches] = React.useState<number | null>(null)

  const [categoryId, setCategoryId] = React.useState('')

  /**
   * Details for cards that are in the deck but not in the loaded pool.
   *
   * A deck can legitimately contain a card the current pool slice does not:
   * the format was never synced, or the card rotated out. Without this the
   * right-hand list would silently drop those cards and saving would delete
   * them - editing a deck must never lose a card just because we cannot
   * describe it.
   */
  const [loadedDetails, setLoadedDetails] = React.useState<Map<number, PoolCard>>(new Map())

  // The startup bootstrap may still be filling the pool. Offering a "sync"
  // button while that runs would invite a second, redundant fetch of the same
  // data - so show what is happening instead.
  const [bootstrap, setBootstrap] = React.useState<{ done: number; total: number } | null>(null)

  /**
   * The (class, format) the pool is currently showing.
   *
   * Declared here, above both effects that touch it: the loader writes it
   * synchronously before its state updates land, which is what lets the
   * clear-on-change effect below tell a load apart from a user switching class.
   */
  const poolKeyRef = React.useRef<string | null>(null)

  const [query, setQuery] = React.useState('')
  const [costFilter, setCostFilter] = React.useState<number | null>(null)

  const loadPool = React.useCallback(async () => {
    setPoolLoading(true)
    setError(null)
    try {
      const [res, settings] = await Promise.all([
        window.electron.ipcRenderer.invoke('cards:pool', {
          classId,
          battleFormat: Number(battleFormat)
        }),
        window.settings.get('settings')
      ])
      if (!res?.ok) throw new Error(res?.error ?? '讀取卡池失敗')
      setPool(res.data.cards)
      setSyncedAt(res.data.syncedAt)
      setShowImages(Boolean(settings?.cardImages))
    } catch (err: any) {
      setError(err?.message ?? '讀取卡池失敗')
    } finally {
      setPoolLoading(false)
    }
  }, [classId, battleFormat])

  React.useEffect(() => {
    if (open) void loadPool()
  }, [open, loadPool])

  React.useEffect(() => {
    setCorrectionMatches(null)
    if (!open || !correction || deckId == null) return
    let cancelled = false
    void window.electron.ipcRenderer
      .invoke('decks:versionImpact', { id: deckId })
      .then((res: { ok: boolean; data?: { matches: number } }) => {
        if (!cancelled && res?.ok && res.data) setCorrectionMatches(res.data.matches)
      })
      .catch(() => {
        /* 問不到就不講數字，橫幅其餘照常。 */
      })
    return () => {
      cancelled = true
    }
  }, [open, correction, deckId])

  React.useEffect(() => {
    const unsubscribe = window.electron?.ipcRenderer.on(
      'cards:poolBootstrap',
      (_event, ...args) => {
        const progress = args[0] as { done: number; total: number; stopped?: boolean }
        const finished = progress.stopped || progress.done >= progress.total
        setBootstrap(finished ? null : progress)
        // Fill in an already-open builder as slices land, rather than making
        // the user close and reopen it.
        if (finished || progress.done > 0) void loadPool()
      }
    )
    return () => unsubscribe?.()
  }, [loadPool])

  React.useEffect(() => {
    if (!open) {
      poolKeyRef.current = null
      return
    }
    setCounts(new Map())
    setLoadedDetails(new Map())
    setDeckName('')
    setCategoryId('')
    setQuery('')
    setCostFilter(null)

    if (deckId == null) {
      // 新牌組：呼叫端知道職業時就直接帶進來。也在這裡設一次而不是只靠 useState
      // 的初值，因為建構器在有些畫面是常駐掛著的，初值只會生效一次。
      if (initialClass) setClassName(initialClass)
      return
    }
    let cancelled = false

    void (async () => {
      const res = await window.electron.ipcRenderer.invoke('decks:get', { id: deckId })
      if (cancelled) return
      if (!res?.ok) {
        setError(res?.error ?? '讀取牌組失敗')
        return
      }

      const { deck, cards } = res.data as {
        deck: {
          name: string
          class: ClassName
          categoryId: string | null
          battleFormat: number | null
        }
        cards: StoredDeckCard[]
      }

      const nextClassId = CLASS_NAME_TO_ID[deck.class]
      const nextFormat = String(deck.battleFormat ?? 2)
      // Written before the state updates land, so the clear-on-change effect
      // above treats this as a load rather than a user switching class.
      poolKeyRef.current = `${nextClassId}:${nextFormat}`

      setClassName(deck.class)
      setBattleFormat(nextFormat)
      setDeckName(deck.name)
      setCategoryId(deck.categoryId ?? '')
      setCounts(new Map(cards.map((c) => [c.cardId, c.count])))
      setLoadedDetails(
        new Map(
          cards.map((c) => [
            c.cardId,
            { ...c, cardClass: null, tribes: [], deckEnabledNum: null, sortIndex: 0 } as PoolCard
          ])
        )
      )
    })()

    return () => {
      cancelled = true
    }
  }, [open, deckId, initialClass])

  /**
   * Switching class or format changes which cards are legal, so the deck in
   * progress cannot survive it. Clearing is honest; silently keeping illegal
   * cards is not.
   *
   * The ref is what distinguishes a USER changing class from LOADING a deck
   * that happens to be another class - the loader writes the key it is moving
   * to before the state update lands, so this sees no change and keeps the
   * cards it just loaded.
   */
  React.useEffect(() => {
    const key = `${classId}:${battleFormat}`
    if (poolKeyRef.current !== null && poolKeyRef.current !== key) {
      setCounts(new Map())
      setLoadedDetails(new Map())
    }
    poolKeyRef.current = key
  }, [classId, battleFormat])

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      const res = await window.electron.ipcRenderer.invoke('cards:syncPool', {
        classId,
        battleFormat: Number(battleFormat)
      })
      if (!res?.ok) throw new Error(syncErrorMessage(res?.error ?? 'NETWORK'))
      await loadPool()
    } catch (err: any) {
      setError(err?.message ?? '同步卡池失敗')
    } finally {
      setSyncing(false)
    }
  }

  const total = React.useMemo(() => [...counts.values()].reduce((sum, n) => sum + n, 0), [counts])

  const limitFor = (card: PoolCard): number => card.deckEnabledNum ?? DEFAULT_COPY_LIMIT

  const add = (card: PoolCard): void => {
    setCounts((prev) => {
      const current = prev.get(card.cardId) ?? 0
      if (current >= limitFor(card)) return prev
      if (total >= DECK_SIZE) return prev
      const next = new Map(prev)
      next.set(card.cardId, current + 1)
      return next
    })
  }

  const remove = (cardId: number): void => {
    setCounts((prev) => {
      const current = prev.get(cardId) ?? 0
      if (current <= 0) return prev
      const next = new Map(prev)
      if (current === 1) next.delete(cardId)
      else next.set(cardId, current - 1)
      return next
    })
  }

  const filteredPool = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return pool.filter((card) => {
      if (costFilter !== null) {
        // The last bucket is "7 and up", matching how the portal groups its own.
        const matches = costFilter === 7 ? (card.cost ?? 0) >= 7 : card.cost === costFilter
        if (!matches) return false
      }
      if (!needle) return true
      return (
        card.name.toLowerCase().includes(needle) ||
        // Searched against the STRIPPED text: otherwise "color" matches every
        // card in the game and a keyword split by a tag matches none.
        cardTextToPlain(card.skillText).toLowerCase().includes(needle)
      )
    })
  }, [pool, query, costFilter])

  const deckCards = React.useMemo(() => {
    const byId = new Map(pool.map((c) => [c.cardId, c]))
    return [...counts.entries()]
      .map(([cardId, count]) => ({
        // Pool first (freshest), then what the deck was loaded with, and
        // finally a bare id - a card we cannot describe is still in the deck
        // and must survive a save.
        card: byId.get(cardId) ??
          loadedDetails.get(cardId) ?? {
            cardId,
            name: `#${cardId}`,
            cost: null,
            type: null,
            kind: null,
            cardClass: null,
            rarity: null,
            atk: null,
            life: null,
            skillText: null,
            tribes: [],
            deckEnabledNum: null,
            imageHash: null,
            bannerHash: null,
            isToken: false,
            sortIndex: 0
          },
        count
      }))
      .sort((a, b) => (a.card.cost ?? 99) - (b.card.cost ?? 99) || a.card.cardId - b.card.cardId)
  }, [counts, pool, loadedDetails])

  const handleSave = async () => {
    const name = deckName.trim() || suggestDeckName(classesMap[className].label, new Date())
    setSaving(true)
    setError(null)
    try {
      const res = await window.electron.ipcRenderer.invoke('decks:saveLocal', {
        deckId,
        name,
        classId,
        battleFormat: Number(battleFormat),
        categoryId: categoryId || null,
        cards: deckCards.map((row) => ({ cardId: row.card.cardId, count: row.count })),
        // 預設讓主行程決定（打過的牌改了就是新版本）；修正模式是從版本列
        // 明確點進來的，直接改寫那一版（plan 3.2）。
        forceInPlace: correction !== null
      })
      if (!res?.ok) {
        throw new Error(
          res?.error === 'DUPLICATE_NAME'
            ? '同職業、同分類下已經有相同名稱的牌組了。'
            : (res?.error ?? '儲存失敗')
        )
      }
      onSaved({ id: Number(res.data?.id ?? deckId) })
      onClose()
    } catch (err: any) {
      setError(err?.message ?? '儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  const needsSync = syncedAt === null && pool.length === 0 && bootstrap === null

  /**
   * Popovers opened INSIDE a raised builder have to be raised with it.
   *
   * `zIndex` only lifted this dialog. Every `Select`, `Menu` and `Tooltip` in
   * here portals to `<body>` at the theme's own modal layer (1300), so opening
   * the builder from the deck manager (1530) left the 分類 dropdown rendering
   * behind the full-screen dialog: the menu was open, and there was nothing to
   * click. Raising the layer in a nested theme fixes every popover in the
   * subtree at once, including ones added later, instead of threading a
   * `MenuProps` override through each control.
   */
  const outerTheme = useTheme()
  const layeredTheme = React.useMemo(
    () =>
      zIndex === undefined
        ? null
        : createTheme(outerTheme, {
            zIndex: { modal: zIndex, tooltip: zIndex + 10, snackbar: zIndex + 10 }
          }),
    [outerTheme, zIndex]
  )

  const dialog = (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullScreen
      sx={zIndex === undefined ? undefined : { zIndex }}
      slotProps={{ paper: { sx: { background: CANVAS_BG } } }}
    >
      <Stack sx={{ height: '100%' }}>
        {/* Its own layer, pinned: in the header row it wrapped onto a second
            line on a narrow window, which is exactly when a user wants out. */}
        <IconButton
          onClick={onClose}
          disabled={saving}
          aria-label="關閉"
          sx={{
            position: 'absolute',
            top: 10,
            right: 12,
            zIndex: 2,
            bgcolor: 'rgba(255,255,255,0.06)',
            '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' }
          }}
        >
          <CloseIcon />
        </IconButton>

        {/* ---- header ---- */}
        <Stack
          direction="row"
          alignItems="center"
          spacing={2}
          sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: 2, py: 1.5, pr: 8, flexWrap: 'wrap' }}
          useFlexGap
        >
          <SegmentedControl
            options={FORMATS}
            value={battleFormat}
            onChange={setBattleFormat}
            aria-label="對戰形式"
          />

          {/* One dropdown rather than seven chips - same control the toolbars
              use, so picking a class reads the same everywhere.

              Disabled while editing: a deck's class is what its recorded matches
              were played as, so changing it would describe a deck nobody
              played. Same reason `decks:update` refuses to touch class. */}
          <Box
            sx={{
              opacity: deckId == null ? 1 : 0.6,
              pointerEvents: deckId == null ? 'auto' : 'none'
            }}
          >
            <ClassSelect value={className} onChange={setClassName} height={40} />
          </Box>

          <Box sx={{ flex: 1 }} />

          <CategorySelect
            value={categoryId}
            onChange={setCategoryId}
            categories={categories}
            height={40}
          />

          <DeckNameField
            value={deckName}
            onChange={setDeckName}
            placeholder={suggestDeckName(classesMap[className].label, new Date())}
          />

          <Button
            variant="contained"
            onClick={() => void handleSave()}
            disabled={saving || total === 0}
            data-testid="deck-builder-save"
            sx={{ borderRadius: 2, fontWeight: 800, px: 2.5 }}
          >
            {saving ? '儲存中…' : deckId == null ? '儲存牌組' : '儲存變更'}
          </Button>
        </Stack>

        {/* 修正模式的橫幅：淡色、一句話，講存檔會做什麼。平常編輯沒有這條。 */}
        {correction && deckId != null && (
          <Alert
            severity="info"
            icon={<EditOutlinedIcon fontSize="small" />}
            square
            data-testid="deck-builder-correction-banner"
            sx={{ py: 0.5 }}
          >
            正在修正 {correction.versionLabel} 的卡表：存檔會直接改寫這一版，不建立新版本
            {correctionMatches !== null && correctionMatches > 0
              ? `，這一版既有的 ${correctionMatches} 場對局會以新卡表解讀`
              : ''}
            。
          </Alert>
        )}

        {error && (
          <Alert severity="error" square onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* ---- body ---- */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 360px' }
          }}
        >
          {/* pool */}
          <Stack sx={{ ...HAIRLINE_RIGHT, minHeight: 0 }}>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: 2, py: 1.25, flexWrap: 'wrap' }}
              useFlexGap
            >
              <TextField
                size="small"
                placeholder="搜尋卡名或效果"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" />
                      </InputAdornment>
                    )
                  }
                }}
                sx={{ width: 240 }}
              />
              <Stack direction="row" spacing={0.5}>
                {COST_BUCKETS.map((cost) => (
                  <Chip
                    key={cost}
                    size="small"
                    label={cost === 7 ? '7+' : cost}
                    onClick={() => setCostFilter(costFilter === cost ? null : cost)}
                    color={costFilter === cost ? 'primary' : 'default'}
                    variant={costFilter === cost ? 'filled' : 'outlined'}
                    sx={{ minWidth: 34, fontWeight: 700 }}
                  />
                ))}
              </Stack>
              <Box sx={{ flex: 1 }} />
              <Typography variant="caption" color="text.secondary">
                {filteredPool.length} / {pool.length} 張
              </Typography>
              <IconButton
                size="small"
                onClick={() => void handleSync()}
                disabled={syncing || poolLoading}
                aria-label="重新同步卡池"
              >
                {syncing ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </Stack>

            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2, pb: 2 }}>
              {needsSync ? (
                <Stack alignItems="center" spacing={1.5} sx={{ py: 6 }}>
                  <Typography variant="body2" color="text.secondary" textAlign="center">
                    還沒有{classesMap[className].label}的卡池資料。
                    <br />
                    同步會從官方網站取得這個職業的卡片清單（約 0.5 MB）。
                  </Typography>
                  <Button variant="contained" onClick={() => void handleSync()} disabled={syncing}>
                    {syncing ? '同步中…' : '同步卡池'}
                  </Button>
                </Stack>
              ) : bootstrap ? (
                <Stack alignItems="center" spacing={1.5} sx={{ py: 6 }}>
                  <CircularProgress size={24} />
                  <Typography variant="body2" color="text.secondary">
                    正在準備卡片資料…（{bootstrap.done} / {bootstrap.total}）
                  </Typography>
                </Stack>
              ) : poolLoading ? (
                <Stack alignItems="center" sx={{ py: 6 }}>
                  <CircularProgress size={24} />
                </Stack>
              ) : (
                <PoolGrid
                  cards={filteredPool}
                  counts={counts}
                  showImages={showImages}
                  limitFor={limitFor}
                  atDeckLimit={total >= DECK_SIZE}
                  onAdd={add}
                  onRemove={remove}
                />
              )}
            </Box>
          </Stack>

          {/* current deck */}
          <Stack sx={{ minHeight: 0 }}>
            {/* 曲線取代原本那行標題：右欄本來就只有一份卡表，「牌組內容」四個字
                沒有講出任何它沒講的事，而費用分布是這裡唯一看不出來的東西。 */}
            <Box sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: 2, py: 1.5 }}>
              <ManaCurve
                cards={deckCards.map(({ card, count }) => ({ ...card, count }))}
                deckSize={DECK_SIZE}
              />
            </Box>
            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pb: 2 }}>
              {deckCards.length === 0 ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ px: 2, py: 4 }}
                  align="center"
                >
                  從左邊點卡片加入牌組。
                </Typography>
              ) : (
                deckCards.map(({ card, count }) => {
                  // The banner crop (800x160) here, deliberately: the deck is a
                  // list to scan, not a grid to pick from. Full art would make
                  // forty rows unscrollable and cost 4x the bytes for a picture
                  // nobody is choosing by.
                  const banner = showImages ? cardImageUrl('list', card.bannerHash) : null

                  return (
                    <CardTooltip key={card.cardId} card={card}>
                      <Box
                        sx={{
                          position: 'relative',
                          mx: 1,
                          mt: 0.5,
                          borderRadius: 1,
                          overflow: 'hidden',
                          ...PANEL_SX,
                          minHeight: 40
                        }}
                      >
                        {banner && (
                          <Box
                            component="img"
                            src={banner}
                            alt={card.name}
                            loading="lazy"
                            sx={{
                              width: '100%',
                              display: 'block',
                              aspectRatio: '800 / 160',
                              objectFit: 'cover'
                            }}
                          />
                        )}

                        <Stack
                          direction="row"
                          spacing={0.75}
                          alignItems="center"
                          sx={
                            banner
                              ? {
                                  position: 'absolute',
                                  inset: 0,
                                  px: 1,
                                  background:
                                    'linear-gradient(to right, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.35) 55%, rgba(0,0,0,0.7) 100%)'
                                }
                              : { px: 1, py: 1 }
                          }
                        >
                          <Box
                            sx={{
                              minWidth: 20,
                              height: 20,
                              borderRadius: '50%',
                              display: 'grid',
                              placeItems: 'center',
                              fontSize: 12,
                              fontWeight: 800,
                              bgcolor: banner ? 'rgba(0,0,0,0.7)' : 'action.selected',
                              color: banner ? '#fff' : 'text.primary'
                            }}
                          >
                            {card.cost ?? '?'}
                          </Box>
                          <Typography
                            variant="body2"
                            noWrap
                            sx={{
                              flex: 1,
                              fontWeight: 700,
                              color: banner ? '#fff' : 'text.primary',
                              textShadow: banner ? '0 1px 3px rgba(0,0,0,.95)' : undefined
                            }}
                            title={card.name}
                          >
                            {card.name}
                          </Typography>
                          <CountStepper
                            count={count}
                            canAdd={count < limitFor(card) && total < DECK_SIZE}
                            onAdd={() => add(card)}
                            onRemove={() => remove(card.cardId)}
                            onBanner={!!banner}
                          />
                        </Stack>
                      </Box>
                    </CardTooltip>
                  )
                })
              )}
            </Box>
          </Stack>
        </Box>
      </Stack>
    </Dialog>
  )

  return layeredTheme ? <ThemeProvider theme={layeredTheme}>{dialog}</ThemeProvider> : dialog
}

function syncErrorMessage(code: string): string {
  if (code === 'NETWORK') return '連不上官方牌組網站，請確認網路連線後再試一次。'
  if (code === 'UNEXPECTED_SHAPE') return '官方網站回傳了無法解析的卡池資料，可能是網站改版了。'
  return code
}

function PoolGrid({
  cards,
  counts,
  showImages,
  limitFor,
  atDeckLimit,
  onAdd,
  onRemove
}: {
  cards: PoolCard[]
  counts: Map<number, number>
  showImages: boolean
  limitFor: (card: PoolCard) => number
  atDeckLimit: boolean
  onAdd: (card: PoolCard) => void
  onRemove: (cardId: number) => void
}) {
  if (cards.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 6 }} align="center">
        沒有符合條件的卡片。
      </Typography>
    )
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 0.75,
        gridTemplateColumns: {
          xs: 'repeat(2, minmax(0, 1fr))',
          md: 'repeat(3, minmax(0, 1fr))',
          xl: 'repeat(4, minmax(0, 1fr))'
        }
      }}
    >
      {cards.map((card) => {
        const count = counts.get(card.cardId) ?? 0
        const maxed = count >= limitFor(card)
        // A card at its own limit, or a full deck, must look unavailable rather
        // than silently swallow the click.
        const disabled = maxed || atDeckLimit
        // Full art (530x687) rather than the banner crop: this is the grid you
        // pick cards out of, so the picture has to be big enough to recognise a
        // card by. The banner belongs on the right, where the deck is a list.
        const src = showImages ? cardImageUrl('card', card.imageHash) : null

        return (
          <CardTooltip key={card.cardId} card={card}>
            <Box
              onClick={() => !disabled && onAdd(card)}
              onContextMenu={(event) => {
                event.preventDefault()
                onRemove(card.cardId)
              }}
              sx={{
                ...CARD_CELL_SX,
                position: 'relative',
                overflow: 'hidden',
                // Selection is NOT carried by the border. A saturated blue
                // outline around full-colour card art fights the art and reads
                // as an error state; the count badge in the corner already says
                // "this one is in the deck" unambiguously. All the frame does
                // is lift the card slightly out of the grid.
                boxShadow:
                  count > 0
                    ? '0 0 0 1px rgba(255,255,255,.22), 0 6px 18px -6px rgba(0,0,0,.75)'
                    : 'none',
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                transition: 'transform .12s, box-shadow .12s, border-color .12s',
                '&:hover': disabled ? undefined : { transform: 'translateY(-2px)' },
                // The art's own proportions, so nothing is cropped or stretched.
                aspectRatio: showImages ? '530 / 687' : undefined,
                px: showImages ? 0 : 1,
                py: showImages ? 0 : 0.75
              }}
            >
              {src ? (
                <Box
                  component="img"
                  src={src}
                  alt={card.name}
                  loading="lazy"
                  // `contain`, not `cover`: the cell matches the art's ratio, and
                  // a card whose face is cropped is a card you cannot identify.
                  sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                />
              ) : (
                // No art: the cost and name are the only thing identifying the
                // card, so they stay. With art they are printed on the picture
                // already and repeating them just covers it.
                <Stack direction="row" alignItems="center" spacing={0.75}>
                  <Box
                    sx={{
                      minWidth: 18,
                      height: 18,
                      borderRadius: '50%',
                      bgcolor: 'rgba(255,255,255,0.1)',
                      fontSize: 11,
                      fontWeight: 800,
                      display: 'grid',
                      placeItems: 'center'
                    }}
                  >
                    {card.cost ?? '?'}
                  </Box>
                  <Typography variant="caption" noWrap sx={{ flex: 1, fontWeight: 700 }}>
                    {card.name}
                  </Typography>
                </Stack>
              )}

              {/* Only the copy count is overlaid. It is the one thing the
                  artwork does not already tell you. */}
              {count > 0 && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    minWidth: 22,
                    height: 22,
                    px: 0.5,
                    borderRadius: 1,
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    fontSize: 12,
                    fontWeight: 900,
                    boxShadow: '0 2px 8px rgba(0,0,0,.6)'
                  }}
                >
                  {count}
                </Box>
              )}
            </Box>
          </CardTooltip>
        )
      })}
    </Box>
  )
}
