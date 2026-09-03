/**
 * One family's versions as a timeline, newest first.
 *
 * Shared by 牌組戰績 (expanded under a deck's row) and 牌組管理 (in a dialog
 * off a deck's card), so a version looks and behaves the same in both.
 *
 * A row answers three questions, left to right, and nothing else:
 *
 * 1. WHICH version, and WHEN it was played - the version chip and, under it,
 *    the span of its games (`9/1 – 9/2`). Not its createdAt: a version's
 *    creation time says when it was saved, and the user wants to know when they
 *    were sitting there playing it.
 * 2. WHAT changed against the version before it - the card diff, inline, as a
 *    row of chips. docs/card-stats-research.md concluded that within one family
 *    the only card-level fact with any signal is exactly this: which cards were
 *    swapped between versions. So the diff is the row's centre, not a button.
 * 3. HOW it did - games and win rate on a bar drawn to one shared scale, with
 *    the change against the previous version beside it. The match count is
 *    always on screen (plan 3.5): thirty games before a two-card swap and
 *    thirty after are noise as far as the win rate goes, and the count is what
 *    lets the user judge that.
 *
 * Actions live behind one `⋯` menu per row. Two icon buttons per row made the
 * panel read as a settings list; the numbers are the point, not the buttons.
 */
import {
  alpha,
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded'
import DeleteIcon from '@mui/icons-material/Delete'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import MoreHorizRoundedIcon from '@mui/icons-material/MoreHorizRounded'
import StarIcon from '@mui/icons-material/Star'
import { cardImageUrl, type StoredDeckCard } from '@shared/deckImport'
import { formatWithInterval, LOW_SAMPLE_THRESHOLD } from '@renderer/components/Analyzer/confidence'
import AppDialog, { DANGER_ACCENT } from '@renderer/components/Common/AppDialog'
import {
  DROPDOWN_ITEM_SX,
  DROPDOWN_PAPER_SX
} from '@renderer/components/Common/filters/dropdownSurface'
import React from 'react'

import DeckVersionDiffDialog, { type DiffEndpoint } from './DeckVersionDiffDialog'
import { invokeIpc } from '@renderer/ipc'
import {
  diffChips,
  diffDeckCards,
  formatDelta,
  formatPlayedSpan,
  isEmptyDiff,
  previousVersion,
  summarizeDiffChips,
  versionLabel,
  winRateDelta,
  type DeckFamily,
  type DeckVersion,
  type DiffChip,
  type VersionLike
} from './deckVersions'

export type VersionDeckLike = VersionLike & {
  name: string
  createdAt: Date | string | number
  isDefault?: boolean
}

export type VersionStat = {
  total: number
  wins: number
  winRate: number
  /** Epoch ms of the version's earliest / latest game in range; optional for callers that do not have them. */
  firstPlayedAt?: number | null
  lastPlayedAt?: number | null
}

type Res<T> = { ok: true; data: T } | { ok: false; error: string }
type VersionImpact = { matches: number; versions: number; isLastActive: boolean }

/** 一句話，兩件事：版本層級的數字為什麼不能盡信，以及它跟著誰的篩選走。收在 ⓘ 裡。 */
export const VERSION_STATS_CAVEAT = '版本的場次很少時，勝率差多半是雜訊；這裡的數字跟隨上方的篩選。'

/** 版本列 `⋯` 選單裡「修正卡表…」要通知呼叫端的東西。 */
export type CorrectVersionRequest = { deckId: number; versionLabel: string }

/* ------------------------------------------------------------- geometry */

/** 時間線那一欄：節點置中在這個寬度裡，豎線畫在它正中央。 */
const TIMELINE_COL = 20
const NODE_SIZE = 10
/** 版本 chip 與期間那一欄。要放得下「2025/12/30 – 1/2」。 */
const LABEL_COL = 116
/** 長條、勝率、差值三樣並排，底下一行場次。 */
const STATS_COL = 184
const BAR_WIDTH = 64
const MENU_COL = 32
/** chip 左側的橫幅縮圖：20 高、4:1 的圖只取右側有角色的那一段。 */
const THUMB_HEIGHT = 20
const THUMB_WIDTH = 44

async function readCards(deckId: number): Promise<StoredDeckCard[]> {
  const res = await invokeIpc('decks:cards', { deckId })
  if (!res?.ok) throw new Error(res?.error ?? '讀取卡表失敗')
  return res.data as StoredDeckCard[]
}

/* -------------------------------------------------------------- chips */

const CHIP_TONE: Record<DiffChip<StoredDeckCard>['kind'], 'success' | 'error' | 'warning'> = {
  added: 'success',
  removed: 'error',
  changed: 'warning'
}
const CHIP_SIGN: Record<DiffChip<StoredDeckCard>['kind'], string> = {
  added: '+',
  removed: '−',
  changed: ''
}

/**
 * One card change. The banner thumbnail follows `DeckCardList`'s rules: only
 * when card images are on, and a picture that fails to load simply goes away -
 * the name is always there, so nothing is lost with it.
 */
function ChangeChip({
  chip,
  showImages,
  onClick
}: {
  chip: DiffChip<StoredDeckCard>
  showImages: boolean
  onClick: () => void
}): React.JSX.Element {
  const [failed, setFailed] = React.useState(false)
  const src = showImages ? cardImageUrl('list', chip.card.bannerHash) : null
  const tone = CHIP_TONE[chip.kind]

  return (
    <ButtonBase
      onClick={onClick}
      data-testid={`deck-version-change-${chip.kind}-${chip.card.cardId}`}
      sx={(theme) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.6,
        height: 24,
        pl: src && !failed ? 0 : 0.75,
        pr: 0.9,
        borderRadius: 1,
        overflow: 'hidden',
        // 不會比它所在的那一欄寬：對話框寬度下一欄只有一百多像素，chip 要縮
        // 進去（卡名省略），不能溢出去壓到右邊的數字。
        maxWidth: 'min(220px, 100%)',
        border: '1px solid',
        borderColor: alpha(theme.palette[tone].main, 0.45),
        bgcolor: alpha(theme.palette[tone].main, 0.1),
        color: theme.palette[tone].light,
        fontSize: 12,
        fontWeight: 700,
        transition: 'background-color .14s, border-color .14s',
        '&:hover': {
          bgcolor: alpha(theme.palette[tone].main, 0.18),
          borderColor: alpha(theme.palette[tone].main, 0.7)
        }
      })}
    >
      {src && !failed && (
        <Box
          component="img"
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          sx={{
            width: THUMB_WIDTH,
            height: THUMB_HEIGHT + 2,
            objectFit: 'cover',
            // 橫幅左半是留給卡名的空白，角色在右邊——和 DeckRow 的卡圖同一個取法。
            objectPosition: '85% center',
            flexShrink: 0,
            mr: 0.25
          }}
        />
      )}
      {CHIP_SIGN[chip.kind] && (
        <Box component="span" sx={{ fontWeight: 900, flexShrink: 0 }}>
          {CHIP_SIGN[chip.kind]}
        </Box>
      )}
      <Box
        component="span"
        title={chip.card.name}
        sx={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'text.primary',
          minWidth: 0
        }}
      >
        {chip.card.name}
      </Box>
      <Box
        component="span"
        sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, opacity: 0.95 }}
      >
        {chip.label}
      </Box>
    </ButtonBase>
  )
}

/* --------------------------------------------------------------- rows */

type CardsCache = ReadonlyMap<number, StoredDeckCard[] | null>

function ChangesCell({
  version,
  prev,
  cards,
  showImages,
  onOpenDiff
}: {
  version: DeckVersion<VersionDeckLike>
  prev: DeckVersion<VersionDeckLike> | null
  cards: CardsCache
  showImages: boolean
  onOpenDiff: () => void
}): React.JSX.Element {
  const mine = cards.get(version.deck.id)

  if (mine === undefined || (prev && cards.get(prev.deck.id) === undefined)) {
    return <Skeleton variant="text" width="60%" sx={{ fontSize: 13 }} />
  }

  if (!prev) {
    return (
      <Typography variant="caption" color="text.secondary" noWrap>
        {mine === null || mine.length === 0
          ? '初始版本 · 沒有卡表'
          : `初始版本 · ${mine.length} 種卡`}
      </Typography>
    )
  }

  const theirs = cards.get(prev.deck.id)
  if (mine === null || theirs === null || !theirs) {
    return (
      <Typography variant="caption" color="text.disabled" noWrap>
        無法讀取卡表，不能比較
      </Typography>
    )
  }

  const diff = diffDeckCards(theirs, mine)
  if (isEmptyDiff(diff)) {
    return (
      <Typography variant="caption" color="text.secondary" noWrap>
        卡表與 {versionLabel(prev.number)} 相同
      </Typography>
    )
  }

  const { shown, hidden } = summarizeDiffChips(diffChips(diff))
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={`與 ${versionLabel(prev.number)} 的卡表差異`}
      onClick={onOpenDiff}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenDiff()
        }
      }}
      data-testid={`deck-version-changes-${version.deck.id}`}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 0.5,
        cursor: 'pointer',
        borderRadius: 1,
        // 整行可點：chip 之間的空隙也算，不然要瞄準。
        mx: -0.5,
        px: 0.5,
        py: 0.25,
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      {shown.map((chip) => (
        <ChangeChip
          key={`${chip.kind}-${chip.card.cardId}`}
          chip={chip}
          showImages={showImages}
          onClick={onOpenDiff}
        />
      ))}
      {hidden > 0 && (
        <Chip
          size="small"
          label={`+${hidden}`}
          variant="outlined"
          sx={{ height: 24, fontSize: 12, fontWeight: 800, color: 'text.secondary' }}
        />
      )}
    </Box>
  )
}

function StatsCell({
  stat,
  prevStat,
  prevNumber,
  loading
}: {
  stat: VersionStat | undefined
  prevStat: VersionStat | undefined
  prevNumber: number | null
  loading: boolean
}): React.JSX.Element {
  if (loading) {
    return (
      <Stack alignItems="flex-end" spacing={0.25} data-testid="deck-version-record">
        <Skeleton variant="text" width={STATS_COL - 24} />
        <Skeleton variant="text" width={96} sx={{ fontSize: 11 }} />
      </Stack>
    )
  }

  const total = stat?.total ?? 0
  const wins = stat?.wins ?? 0
  const played = total > 0
  const rate = played ? (wins / total) * 100 : 0
  const delta = winRateDelta(stat, prevStat, LOW_SAMPLE_THRESHOLD)

  const deltaTooltip = (): string => {
    if (!delta || prevNumber === null) return ''
    const head = `較 ${versionLabel(prevNumber)} ${formatDelta(delta.delta)} 個百分點`
    const lines = [
      `這一版 ${formatWithInterval(wins, total)}`,
      `${versionLabel(prevNumber)} ${formatWithInterval(prevStat!.wins, prevStat!.total)}`
    ]
    return [delta.lowSample ? `樣本不足（不到 ${LOW_SAMPLE_THRESHOLD} 場）· ${head}` : head]
      .concat(lines)
      .join('\n')
  }

  return (
    <Stack alignItems="flex-end" spacing={0.1} data-testid="deck-version-record">
      <Stack direction="row" alignItems="center" spacing={1}>
        {/* 同一尺度：每一條都是 0–100%，所以版本之間可以直接比長短。 */}
        <Box
          sx={{
            width: BAR_WIDTH,
            height: 6,
            borderRadius: 3,
            bgcolor: 'action.hover',
            overflow: 'hidden',
            flexShrink: 0
          }}
        >
          {played && (
            <Box
              sx={{
                width: `${Math.min(100, rate)}%`,
                height: '100%',
                borderRadius: 3,
                bgcolor: rate >= 50 ? 'success.main' : 'error.main'
              }}
            />
          )}
        </Box>
        <Tooltip title={played ? formatWithInterval(wins, total) : ''} placement="top">
          <Typography
            component="span"
            sx={{
              width: 52,
              textAlign: 'right',
              fontSize: 15,
              fontWeight: 900,
              lineHeight: 1.2,
              fontVariantNumeric: 'tabular-nums',
              color: played ? (rate >= 50 ? 'success.light' : 'error.light') : 'text.disabled'
            }}
          >
            {played ? `${rate.toFixed(1)}%` : '—'}
          </Typography>
        </Tooltip>
        <Tooltip
          title={
            delta ? (
              <Box component="span" sx={{ whiteSpace: 'pre-line' }}>
                {deltaTooltip()}
              </Box>
            ) : (
              ''
            )
          }
          placement="top"
        >
          <Typography
            component="span"
            data-testid="deck-version-delta"
            data-low-sample={delta?.lowSample ? 'true' : undefined}
            sx={{
              width: 40,
              textAlign: 'left',
              fontSize: 11,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              color: delta ? (delta.lowSample ? 'text.disabled' : 'text.secondary') : 'transparent',
              cursor: delta ? 'help' : 'default'
            }}
          >
            {delta ? formatDelta(delta.delta) : '·'}
          </Typography>
        </Tooltip>
      </Stack>
      <Typography
        variant="caption"
        noWrap
        sx={{
          fontVariantNumeric: 'tabular-nums',
          color: played ? 'text.secondary' : 'text.disabled',
          // 對齊到勝率數字的右緣，不算進差值那一欄（差值欄寬 + 間距，單位是 px 不是 spacing）。
          pr: `${40 + 8}px`
        }}
      >
        {played ? `${total} 場 · ${wins}勝${total - wins}敗` : '0 場'}
      </Typography>
    </Stack>
  )
}

/* -------------------------------------------------------------- panel */

export default function DeckVersionsPanel<T extends VersionDeckLike>({
  family,
  stats,
  zIndex,
  onChanged,
  onCorrect
}: {
  family: DeckFamily<T>
  /** Per-version record, keyed by deck id. `null` while loading. */
  stats: Map<number, VersionStat> | null
  zIndex?: number
  /** After a version was deleted (or the family swept), so the caller can reload. */
  onChanged?: () => void
  /**
   * 「修正卡表…」：開建構器改寫這一版的卡表，不建立新版本。呼叫端負責開
   * 建構器（它知道要疊在哪一層上）；沒給的話選單就不列這一項。
   */
  onCorrect?: (request: CorrectVersionRequest) => void
}): React.JSX.Element {
  const [diff, setDiff] = React.useState<{ from: DiffEndpoint; to: DiffEndpoint } | null>(null)
  const [discarding, setDiscarding] = React.useState<DeckVersion<T> | null>(null)
  const [impact, setImpact] = React.useState<VersionImpact | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [menu, setMenu] = React.useState<{ anchor: HTMLElement; version: DeckVersion<T> } | null>(
    null
  )
  /**
   * Card lists by deck id; `null` marks one that failed to load. Fetched when
   * the panel mounts - which is when the family is expanded - and kept while
   * the family reloads, so a discard does not blank every row's diff.
   */
  const [cards, setCards] = React.useState<CardsCache>(() => new Map())
  const [showImages, setShowImages] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void window.settings
      .get('settings')
      .then((settings) => {
        if (!cancelled) setShowImages(Boolean(settings?.cardImages))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void Promise.all(
      family.versions.map(async (version) => {
        const id = version.deck.id
        try {
          return [id, await readCards(id)] as const
        } catch {
          return [id, null] as const
        }
      })
    ).then((entries) => {
      if (cancelled) return
      setCards((prev) => {
        const next = new Map(prev)
        for (const [id, list] of entries) next.set(id, list)
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // `family` is rebuilt on every deck reload; refetching then is what keeps an
    // in-place edit of an unplayed version (same id, new cards) honest.
  }, [family])

  React.useEffect(() => {
    if (!discarding) {
      setImpact(null)
      return
    }
    let mounted = true
    void invokeIpc('decks:versionImpact', { id: discarding.deck.id })
      .then((res: Res<VersionImpact>) => {
        if (mounted && res.ok) setImpact(res.data)
      })
      .catch(() => {
        /* 問不到就退回一般文字，不擋操作。 */
      })
    return () => {
      mounted = false
    }
  }, [discarding])

  const handleDiscard = async (): Promise<void> => {
    if (!discarding) return
    setBusy(true)
    setError(null)
    try {
      const res: Res<unknown> = await invokeIpc('decks:deleteVersion', {
        id: discarding.deck.id
      })
      if (!res.ok) throw new Error(res.error)
      setDiscarding(null)
      onChanged?.()
    } catch (err: any) {
      setError(err?.message ?? '刪除失敗')
    } finally {
      setBusy(false)
    }
  }

  const openDiff = (version: DeckVersion<T>): void => {
    const prev = previousVersion(family, version)
    if (!prev) return
    setDiff({
      from: { id: prev.deck.id, number: prev.number },
      to: { id: version.deck.id, number: version.number }
    })
  }

  const newestFirst = [...family.versions].reverse()
  const dialogZ = zIndex === undefined ? undefined : zIndex + 1
  const menuVersion = menu?.version ?? null
  const menuPrev = menuVersion ? previousVersion(family, menuVersion) : null

  /**
   * 確認框的白話：刪除一律叫刪除。打過的版本刪了戰績還在，只是不再出現；沒打
   * 過的直接移除。是最後一個版本時，等同刪掉整副牌組——講出來。問不到場次
   * （impact 還沒回來）就只講會發生的事，不講數字。
   */
  const discardText = (): string => {
    if (!discarding) return ''
    if (impact === null) return '已經打過的對局與戰績會保留；還沒打過的版本會直接移除。'
    if (impact.isLastActive) {
      const head = `這是「${family.current.name}」最後一個版本，刪除它會刪除整副牌組。`
      return impact.matches > 0
        ? `${head}已經打過的 ${impact.matches} 場對局與戰績會保留，只是牌組不再出現在清單與挑選選單。`
        : `${head}這副牌組還沒打過，會直接移除。`
    }
    return impact.matches > 0
      ? `這個版本有 ${impact.matches} 場對局。刪除後戰績會保留，只是這一版不再出現在清單。`
      : '這個版本還沒打過，會直接移除，無法復原。'
  }

  return (
    <Box data-testid={`deck-versions-panel-${family.familyId}`}>
      {error && (
        <Alert severity="error" sx={{ mb: 1, borderRadius: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* 說明收成右上角一個 ⓘ：數字才是這一區的主角。 */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, mb: -0.5 }}>
        <Tooltip title={VERSION_STATS_CAVEAT} placement="left">
          <Box
            component="span"
            data-testid="deck-versions-caveat"
            aria-label="版本數字怎麼讀"
            sx={{ display: 'inline-flex', color: 'text.disabled', cursor: 'help' }}
          >
            <InfoOutlinedIcon sx={{ fontSize: 15 }} />
          </Box>
        </Tooltip>
      </Box>

      {/* 一條時間線把所有版本串起來。豎線由每一列自己畫上下兩段（第一列不畫
          上段、最後一列不畫下段），所以不管某一列因為 chip 換行長多高，線都會
          剛好穿過它的節點——用一條絕對定位的整條線就得猜每列的高度。 */}
      <Box>
        {newestFirst.map((version, index) => {
          const isFirst = index === 0
          const isLast = index === newestFirst.length - 1
          const isCurrent = version.deck.id === family.current.id && !family.archived
          const prev = previousVersion(family, version)
          const stat = stats?.get(version.deck.id)
          const prevStat = prev ? stats?.get(prev.deck.id) : undefined
          const span = formatPlayedSpan(stat?.firstPlayedAt, stat?.lastPlayedAt)

          return (
            <Box
              key={version.deck.id}
              data-testid={`deck-version-row-${version.deck.id}`}
              data-version={version.number}
              data-current={isCurrent ? 'true' : undefined}
              sx={(theme) => ({
                position: 'relative',
                display: 'grid',
                gridTemplateColumns: `${TIMELINE_COL}px ${LABEL_COL}px minmax(0, 1fr) ${STATS_COL}px ${MENU_COL}px`,
                alignItems: 'center',
                columnGap: 1.5,
                px: 1,
                py: 1,
                borderRadius: 1.5,
                // 目前版本一層淡底色；其餘列不各自框起來，時間線已經把它們串成一組。
                bgcolor: isCurrent ? alpha(theme.palette.primary.main, 0.07) : 'transparent',
                // 刪掉的版本灰階：還在（戰績要看得到），但已經不是選項。
                opacity: version.archived ? 0.6 : 1,
                filter: version.archived ? 'grayscale(0.6)' : 'none',
                transition: 'background-color .14s',
                '&:hover': {
                  bgcolor: isCurrent
                    ? alpha(theme.palette.primary.main, 0.1)
                    : theme.palette.action.hover
                }
              })}
            >
              {/* 節點，以及穿過它的線。線段往上下各多伸出這一列的 py，好接上
                  鄰列的線段；節點自己有底色，蓋住線的中段。 */}
              <Box
                sx={{
                  alignSelf: 'stretch',
                  position: 'relative',
                  display: 'grid',
                  placeItems: 'center',
                  '&::before, &::after': {
                    content: '""',
                    position: 'absolute',
                    left: TIMELINE_COL / 2 - 1,
                    width: 2,
                    bgcolor: 'divider'
                  },
                  '&::before': { top: -8, bottom: '50%', display: isFirst ? 'none' : 'block' },
                  '&::after': { top: '50%', bottom: -8, display: isLast ? 'none' : 'block' }
                }}
              >
                <Box
                  sx={(theme) => ({
                    position: 'relative',
                    width: NODE_SIZE,
                    height: NODE_SIZE,
                    borderRadius: '50%',
                    border: '2px solid',
                    borderColor: isCurrent ? 'primary.main' : 'text.disabled',
                    borderStyle: version.archived ? 'dashed' : 'solid',
                    bgcolor: isCurrent ? 'primary.main' : 'background.paper',
                    boxShadow: isCurrent
                      ? `0 0 0 4px ${alpha(theme.palette.primary.main, 0.2)}`
                      : 'none'
                  })}
                />
              </Box>

              {/* 版本與期間 */}
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={0.6}>
                  <Chip
                    size="small"
                    label={versionLabel(version.number)}
                    color={isCurrent ? 'primary' : 'default'}
                    variant={isCurrent ? 'filled' : 'outlined'}
                    sx={{
                      height: 22,
                      minWidth: 36,
                      fontWeight: 800,
                      fontSize: 12,
                      fontVariantNumeric: 'tabular-nums',
                      ...(isCurrent ? {} : { color: 'text.secondary' })
                    }}
                  />
                  {isCurrent && (
                    <Typography
                      component="span"
                      sx={{ fontSize: 11, fontWeight: 800, color: 'primary.light' }}
                    >
                      目前
                    </Typography>
                  )}
                  {version.deck.isDefault && (
                    <Tooltip title="這個職業的預設牌組">
                      <StarIcon color="warning" sx={{ fontSize: 15 }} />
                    </Tooltip>
                  )}
                  {version.archived && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label="已刪除"
                      data-testid="deck-version-archived"
                      sx={{ height: 18, fontSize: 10, color: 'text.secondary' }}
                    />
                  )}
                </Stack>
                {stats === null ? (
                  <Skeleton variant="text" width={72} sx={{ fontSize: 11 }} />
                ) : (
                  <Typography
                    variant="caption"
                    noWrap
                    title={span}
                    data-testid="deck-version-span"
                    sx={{
                      fontVariantNumeric: 'tabular-nums',
                      color: stat?.total ? 'text.secondary' : 'text.disabled'
                    }}
                  >
                    {span}
                  </Typography>
                )}
              </Stack>

              {/* 相對上一版的變動 */}
              <Box sx={{ minWidth: 0 }}>
                <ChangesCell
                  version={version}
                  prev={prev}
                  cards={cards}
                  showImages={showImages}
                  onOpenDiff={() => openDiff(version)}
                />
              </Box>

              {/* 場次與勝率 */}
              <StatsCell
                stat={stat}
                prevStat={prevStat}
                prevNumber={prev?.number ?? null}
                loading={stats === null}
              />

              {/* 動作 */}
              <IconButton
                size="small"
                aria-label={`${versionLabel(version.number)} 的更多操作`}
                aria-haspopup="menu"
                data-testid={`deck-version-menu-${version.deck.id}`}
                onClick={(event) => setMenu({ anchor: event.currentTarget, version })}
                sx={{ color: 'text.secondary' }}
              >
                <MoreHorizRoundedIcon fontSize="small" />
              </IconButton>
            </Box>
          )
        })}
      </Box>

      <Menu
        open={menu !== null}
        anchorEl={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: DROPDOWN_PAPER_SX } }}
        sx={dialogZ === undefined ? undefined : { zIndex: dialogZ }}
      >
        <MenuItem
          disabled={!menuPrev}
          data-testid={menuVersion ? `deck-version-diff-${menuVersion.deck.id}` : undefined}
          onClick={() => {
            if (menuVersion) openDiff(menuVersion)
            setMenu(null)
          }}
          sx={DROPDOWN_ITEM_SX}
        >
          <ListItemIcon sx={{ minWidth: 0 }}>
            <CompareArrowsRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="查看差異"
            secondary={menuPrev ? `與 ${versionLabel(menuPrev.number)} 比較卡表` : '這是第一個版本'}
            primaryTypographyProps={{ variant: 'body2', fontWeight: 700 }}
            secondaryTypographyProps={{ variant: 'caption' }}
          />
        </MenuItem>
        {onCorrect && (
          <MenuItem
            disabled={!menuVersion || menuVersion.archived}
            data-testid={menuVersion ? `deck-version-correct-${menuVersion.deck.id}` : undefined}
            onClick={() => {
              if (menuVersion) {
                onCorrect({
                  deckId: menuVersion.deck.id,
                  versionLabel: versionLabel(menuVersion.number)
                })
              }
              setMenu(null)
            }}
            sx={DROPDOWN_ITEM_SX}
          >
            <ListItemIcon sx={{ minWidth: 0 }}>
              <EditOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary="修正卡表…"
              secondary="這版卡表輸入錯了？直接改正，不建立新版本"
              primaryTypographyProps={{ variant: 'body2', fontWeight: 700 }}
              secondaryTypographyProps={{ variant: 'caption' }}
            />
          </MenuItem>
        )}
        <MenuItem
          data-testid={menuVersion ? `deck-version-discard-${menuVersion.deck.id}` : undefined}
          onClick={() => {
            if (menuVersion) setDiscarding(menuVersion)
            setMenu(null)
          }}
          sx={{ ...DROPDOWN_ITEM_SX, color: 'error.light' }}
        >
          <ListItemIcon sx={{ minWidth: 0, color: 'inherit' }}>
            <DeleteOutlineRoundedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="刪除此版本"
            primaryTypographyProps={{ variant: 'body2', fontWeight: 700 }}
          />
        </MenuItem>
      </Menu>

      <DeckVersionDiffDialog
        open={diff !== null}
        deckName={family.current.name}
        from={diff?.from ?? null}
        to={diff?.to ?? null}
        zIndex={dialogZ}
        onClose={() => setDiff(null)}
      />

      <AppDialog
        open={discarding !== null}
        onClose={() => !busy && setDiscarding(null)}
        busy={busy}
        maxWidth="xs"
        title={discarding ? `刪除 ${versionLabel(discarding.number)}？` : '刪除此版本？'}
        subtitle={family.current.name}
        icon={<DeleteIcon fontSize="small" />}
        accent={DANGER_ACCENT}
        zIndex={dialogZ}
        actions={
          <>
            <Button
              onClick={() => setDiscarding(null)}
              disabled={busy}
              sx={{ textTransform: 'none' }}
            >
              取消
            </Button>
            <Button
              color="error"
              variant="contained"
              disableElevation
              onClick={() => void handleDiscard()}
              disabled={busy}
              data-testid="deck-version-discard-confirm"
              sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
            >
              {busy ? '刪除中…' : impact?.isLastActive ? '刪除整副牌組' : '刪除此版本'}
            </Button>
          </>
        }
      >
        <Typography variant="body2" color="text.secondary" data-testid="deck-version-discard-text">
          {discardText()}
        </Typography>
      </AppDialog>
    </Box>
  )
}
