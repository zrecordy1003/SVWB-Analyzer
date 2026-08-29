// src/renderer/components/SearchBar/SearchBar.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  Drawer,
  IconButton,
  Paper,
  Switch,
  Typography
} from '@mui/material'
import TuneIcon from '@mui/icons-material/Tune'
import CloseIcon from '@mui/icons-material/Close'
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined'

import type { GameMode } from '@shared/domain'
import type { RangeKey } from '@shared/types'
import { classes } from '@renderer/map/classMap'
import { ModeSelect } from '@renderer/components/Common/filters/ModeSelect'
import { AdvancedFilterBar } from '@renderer/components/Common/filters/AdvancedFilterBar'
import {
  ClassEditor,
  CrRangeEditor,
  DeckEditor,
  RangeEditor,
  NoteEditor,
  TagEditor,
  type NoteFilter
} from '@renderer/components/Common/filters/FilterEditors'
import { CR_MAX_BOUND, CR_MIN_BOUND } from '@renderer/components/Common/filters/crBounds'
import {
  MATCH_FILTER_ICONS,
  MATCH_FILTER_LABELS,
  clearAllMatchFilters,
  clearMatchFilter,
  enableMatchFilter,
  matchAdvancedChips,
  type MatchFilterKey
} from '../filterChips'

// ==== 外部提供資料型別（與 hook 對齊）====
export type DeckLite = {
  id: number
  name: string
  classId: string | number | null
  deckCategoryId: string | null
  categoryName?: string | null
  categorySort?: number | null
}
export type TagLite = { id: number; name: string }

type ClassType = (typeof classes)[number]

// 備註三態：定義跟著編輯器走，兩邊不會各有一份
export type { NoteFilter }

// Filters
export type Filters = {
  my: ClassType[]
  oppo: ClassType[]
  mode: GameMode | null
  rangeKey: RangeKey
  startDate: Date | null
  endDate: Date | null
  decks: DeckLite[]
  tags: TagLite[]
  note: NoteFilter
  crEnabled: boolean
  crMin: number | null
  crMax: number | null
}
export type OnFiltersChange = (patch: Partial<Filters>) => void

/** 工作列上的控制項一律同高；32 配 40 看起來像沒對齊的 bug。 */
const TOOLBAR_CONTROL_HEIGHT = 36

/** 時間範圍：五顆按鈕加上自訂日期，寬度固定才不會把模式擠到下一行。 */
const RANGE_CONTROL_WIDTH = 372

/* ---------- persistence (settings only) ---------- */
const SETTINGS_KEY = 'matchList.filters'
type PersistShape = {
  myIds: string[]
  oppoIds: string[]
  mode: GameMode | null
  rangeKey: RangeKey
  startDate: string | null
  endDate: string | null
  deckIds: number[]
  tagIds: number[]
  note: NoteFilter
  crEnabled: boolean
  crMin: number | null
  crMax: number | null
}

async function settingsGet<T>(key: string): Promise<T | undefined> {
  return window.settings?.get<T>(key)
}
async function settingsSet<T>(key: string, val: T): Promise<void> {
  await window.settings?.set(key, val)
}

function inflateClasses(ids: string[]): ClassType[] {
  const idSet = new Set(ids)
  return classes.filter((c) => idSet.has(String(c.id)))
}
function deflateClasses(objs: ClassType[]): string[] {
  return objs.map((c) => String(c.id))
}

type Props = {
  filters: Filters
  onFiltersChange: OnFiltersChange
  deckOptions: DeckLite[] // ★ 由 hook 提供（已補好 categoryName/sort）
  tagOptions: TagLite[]
  refreshDecks: () => void
  refreshTags: () => void
  /** Delay restoration until reference data is available, then release the first list query. */
  initializationReady: boolean
  onInitialized: () => void
}

const SearchBar = ({
  filters,
  onFiltersChange,
  deckOptions,
  tagOptions,
  refreshDecks,
  refreshTags,
  initializationReady,
  onInitialized
}: Props): React.JSX.Element => {
  // 職業排序：用 classes.map 動態產生
  const CLASS_ORDER = useMemo(() => classes.map((c) => String(c.id)), [])
  const classOrderIndex = useMemo(() => {
    const map = new Map<string, number>()
    CLASS_ORDER.forEach((id, idx) => map.set(id, idx))
    return map
  }, [CLASS_ORDER])

  const {
    my,
    oppo,
    mode,
    rangeKey,
    startDate,
    endDate,
    decks,
    tags,
    note,
    crEnabled,
    crMin,
    crMax
  } = filters

  const [advancedOpen, setAdvancedOpen] = useState(false)
  const loadedRef = useRef(false)
  const initializationStartedRef = useRef(false)

  // safety values
  const decksSafe = useMemo<DeckLite[]>(() => (Array.isArray(decks) ? decks : []), [decks])
  const tagsSafe = useMemo<TagLite[]>(() => (Array.isArray(tags) ? tags : []), [tags])
  const noteSafe: NoteFilter =
    note === 'with' || note === 'without' || note === 'any' ? note : 'any'
  const crEnabledSafe = !!crEnabled
  const crMinSafe = typeof crMin === 'number' ? crMin : 1650
  const crMaxSafe = typeof crMax === 'number' ? crMax : 1850

  /* ---------- 初始還原 ---------- */
  useEffect(() => {
    if (!initializationReady || initializationStartedRef.current) return
    initializationStartedRef.current = true
    ;(async () => {
      const saved = await settingsGet<PersistShape>(SETTINGS_KEY)
      if (saved) {
        const s = saved.startDate ? new Date(saved.startDate) : null
        const e = saved.endDate ? new Date(saved.endDate) : null

        const deckIdSet = new Set(saved.deckIds ?? [])
        const tagIdSet = new Set(saved.tagIds ?? [])
        const restoredDecks = deckOptions.filter((d) => deckIdSet.has(d.id))
        const restoredTags = tagOptions.filter((t) => tagIdSet.has(t.id))

        onFiltersChange({
          my: inflateClasses(saved.myIds || []),
          oppo: inflateClasses(saved.oppoIds || []),
          mode: saved.mode ?? null,
          rangeKey: saved.rangeKey,
          startDate: s,
          endDate: e,
          decks: restoredDecks,
          tags: restoredTags,
          note: saved.note ?? 'any',
          crEnabled: saved.crEnabled ?? false,
          crMin: typeof saved.crMin === 'number' ? saved.crMin : Math.max(1650, CR_MIN_BOUND),
          crMax: typeof saved.crMax === 'number' ? saved.crMax : Math.min(1850, CR_MAX_BOUND)
        })
      } else {
        onFiltersChange({
          rangeKey: 'today',
          startDate: null,
          endDate: null,
          decks: [],
          tags: [],
          note: 'any',
          crEnabled: false,
          crMin: Math.max(1650, CR_MIN_BOUND),
          crMax: Math.min(1850, CR_MAX_BOUND)
        })
      }
      loadedRef.current = true
      onInitialized()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializationReady])

  /* ---------- 任一設定變更就保存 ---------- */
  useEffect(() => {
    if (!loadedRef.current) return
    const payload: PersistShape = {
      rangeKey,
      myIds: deflateClasses(my),
      oppoIds: deflateClasses(oppo),
      mode,
      startDate: startDate ? startDate.toISOString() : null,
      endDate: endDate ? endDate.toISOString() : null,
      deckIds: decksSafe.map((d) => d.id),
      tagIds: tagsSafe.map((t) => t.id),
      note: noteSafe,
      crEnabled: crEnabledSafe,
      crMin: crMinSafe,
      crMax: crMaxSafe
    }
    settingsSet(SETTINGS_KEY, payload).catch(() => {})
  }, [
    rangeKey,
    my,
    oppo,
    mode,
    startDate,
    endDate,
    decksSafe,
    tagsSafe,
    noteSafe,
    crEnabledSafe,
    crMinSafe,
    crMaxSafe
  ])

  // 我方已選職業集合
  const selectedMy = useMemo(() => new Set(my.map((c) => String(c.id))), [my])

  // 依分類排序 + 依職業過濾 + 職業順序
  const deckOptionsSortedFiltered = useMemo(() => {
    const filtered =
      selectedMy.size === 0
        ? deckOptions
        : deckOptions.filter((d) => d.classId != null && selectedMy.has(String(d.classId)))

    const arr = [...filtered]
    arr.sort((a, b) => {
      const as = a.categorySort ?? 9999
      const bs = b.categorySort ?? 9999
      if (as !== bs) return as - bs

      const an = (a.categoryName ?? '').localeCompare(b.categoryName ?? '')
      if (an !== 0) return an

      const ai = classOrderIndex.get(String(a.classId)) ?? 9999
      const bi = classOrderIndex.get(String(b.classId)) ?? 9999
      if (ai !== bi) return ai - bi

      return a.name.localeCompare(b.name)
    })
    return arr
  }, [deckOptions, selectedMy, classOrderIndex])

  /**
   * 編輯器回傳的是 id，但 filters 存的是整個物件（卡片與 chip 要直接顯示名稱）。
   * 查表用的是完整的 deckOptions 而不是依職業過濾後的清單 - 否則改一次我方職業
   * 就會把選好、只是暫時不在清單上的牌組默默清掉。
   */
  const decksFromIds = (ids: number[]): DeckLite[] => {
    const byId = new Map(deckOptions.map((d) => [d.id, d]))
    return ids.map((id) => byId.get(id)).filter((d): d is DeckLite => !!d)
  }
  const tagsFromIds = (ids: number[]): TagLite[] => {
    const byId = new Map(tagOptions.map((t) => [t.id, t]))
    return ids.map((id) => byId.get(id)).filter((t): t is TagLite => !!t)
  }

  /**
   * 一條條件一個編輯器，兩個地方共用：抽屜裡疊起來，以及工作列的 chip 點開的
   * popover。同一個元件，所以兩個介面不會各自漂移。
   */
  const renderEditor = (key: MatchFilterKey, autoFocus = false): React.ReactNode => {
    switch (key) {
      case 'my':
        return (
          <ClassEditor
            label="我方職業"
            value={my}
            onChange={(next) => onFiltersChange({ my: next })}
            autoFocus={autoFocus}
          />
        )
      case 'oppo':
        return (
          <ClassEditor
            label="對方職業"
            value={oppo}
            onChange={(next) => onFiltersChange({ oppo: next })}
            autoFocus={autoFocus}
          />
        )
      case 'decks':
        return (
          <DeckEditor
            options={deckOptionsSortedFiltered}
            value={decksSafe}
            onOpen={refreshDecks}
            onChange={(ids) => onFiltersChange({ decks: decksFromIds(ids) })}
            autoFocus={autoFocus}
          />
        )
      case 'tags':
        return (
          <TagEditor
            options={tagOptions}
            value={tagsSafe}
            onOpen={refreshTags}
            onChange={(ids) => onFiltersChange({ tags: tagsFromIds(ids) })}
            autoFocus={autoFocus}
          />
        )
      case 'note':
        return <NoteEditor value={noteSafe} onChange={(next) => onFiltersChange({ note: next })} />
      case 'cr':
        // 改範圍本身就是套用它。
        return (
          <CrRangeEditor
            min={crMinSafe}
            max={crMaxSafe}
            onCommit={(min, max) => onFiltersChange({ crEnabled: true, crMin: min, crMax: max })}
          />
        )
    }
  }

  const advancedChips = useMemo(() => matchAdvancedChips(filters), [filters])

  /** 還沒有 chip 的條件 - ＋ 還能提供的那幾條。 */
  const addableKeys = useMemo<MatchFilterKey[]>(() => {
    const active = new Set(advancedChips.map((chip) => chip.key))
    return (Object.keys(MATCH_FILTER_LABELS) as MatchFilterKey[]).filter((key) => !active.has(key))
  }, [advancedChips])

  return (
    <Box sx={{ mb: 1.5 }}>
      {/* 工作列：一眼看得完的兩件事 - 看哪一段時間、哪一個模式。
          其餘條件都收進抽屜，但生效中的會以 chip 回到這裡，
          否則抽屜關上以後就沒有任何東西說明資料被縮小過。 */}
      <Paper
        variant="outlined"
        sx={{ borderRadius: 2, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}
      >
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          {/* 時間範圍：清單的主軸，一次點擊就到。自訂日期用的是抽屜與 popover
              裡同一個編輯器，所以「自訂」在哪裡點開都長一樣。 */}
          <Box
            sx={{
              width: RANGE_CONTROL_WIDTH,
              maxWidth: '100%',
              '& .MuiToggleButton-root': { height: TOOLBAR_CONTROL_HEIGHT, py: 0 }
            }}
          >
            <RangeEditor
              rangeKey={rangeKey}
              startDate={startDate}
              endDate={endDate}
              onChange={onFiltersChange}
            />
          </Box>

          <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />

          {/* 模式：一個月不見得動一次，所以收成一個下拉。 */}
          <ModeSelect
            value={mode ?? 'all'}
            onChange={(next) => onFiltersChange({ mode: next === 'all' ? null : next })}
            height={TOOLBAR_CONTROL_HEIGHT}
          />

          <Box sx={{ flex: 1, minWidth: 8 }} />

          <Badge badgeContent={advancedChips.length} color="primary">
            <Button
              size="small"
              variant={advancedChips.length ? 'contained' : 'outlined'}
              startIcon={<TuneIcon />}
              onClick={() => setAdvancedOpen(true)}
              sx={{ height: TOOLBAR_CONTROL_HEIGHT, whiteSpace: 'nowrap' }}
            >
              進階篩選
            </Button>
          </Badge>
        </Box>

        {/* 進階條件列與分析器共用同一個元件，chip、＋ 選單與就地編輯的
            popover 都在裡面。 */}
        <AdvancedFilterBar
          chips={advancedChips}
          addableKeys={addableKeys}
          labels={MATCH_FILTER_LABELS}
          icons={MATCH_FILTER_ICONS}
          renderEditor={(key, autoFocus) => renderEditor(key, autoFocus)}
          onEnable={(key) => onFiltersChange(enableMatchFilter(key))}
          onRemove={(key) => onFiltersChange(clearMatchFilter(key))}
          onClearAll={() => onFiltersChange(clearAllMatchFilters())}
          editorWidth={(key) => (key === 'decks' ? 380 : 340)}
        />
      </Paper>

      {/* 進階篩選抽屜。條件即時生效，沒有「套用」按鈕 - 查詢本來就有 debounce，
          多一顆按鈕只會多一種「以為改了其實沒按到」的狀態。 */}
      <Drawer
        anchor="right"
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        slotProps={{
          paper: {
            sx: {
              width: 440,
              maxWidth: 'calc(100vw - 32px)',
              borderTopLeftRadius: 16,
              borderBottomLeftRadius: 16
            }
          }
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Box
            sx={{
              px: 3,
              pt: 3,
              pb: 2,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 2
            }}
          >
            <Box>
              <Typography variant="h6" component="h2" fontWeight={700}>
                進階篩選
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                職業、牌組、標籤、備註與 CR
              </Typography>
            </Box>
            <IconButton
              size="small"
              onClick={() => setAdvancedOpen(false)}
              aria-label="關閉進階篩選"
            >
              <CloseIcon />
            </IconButton>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              px: 3,
              py: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 2.5
            }}
          >
            {(['my', 'oppo', 'decks', 'tags', 'note'] as const).map((key) => {
              const Icon = MATCH_FILTER_ICONS[key]
              return (
                <Box key={key}>
                  <Box display="flex" alignItems="center" gap={0.75} sx={{ mb: 1 }}>
                    <Icon fontSize="small" />
                    <Typography variant="subtitle2" fontWeight={700}>
                      {MATCH_FILTER_LABELS[key]}
                    </Typography>
                  </Box>
                  {renderEditor(key)}
                </Box>
              )
            })}

            {/* CR 自己帶開關：和其他條件不同，它關著的時候也還是有一組範圍，
                所以是開關而不是內容在決定查詢帶不帶它。 */}
            <Box
              sx={{
                border: '1px solid',
                borderColor: crEnabledSafe ? 'primary.main' : 'divider',
                borderRadius: 2,
                bgcolor: 'background.paper',
                overflow: 'hidden',
                transition: 'border-color .2s'
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 2,
                  py: 1,
                  cursor: 'pointer',
                  userSelect: 'none'
                }}
                onClick={() => onFiltersChange({ crEnabled: !crEnabledSafe })}
              >
                <MilitaryTechOutlinedIcon fontSize="small" />
                <Typography sx={{ fontWeight: 600 }}>CR 篩選</Typography>
                {crEnabledSafe && (
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    label={`${crMinSafe} – ${crMaxSafe}`}
                  />
                )}
                <Box flex={1} />
                <Switch
                  size="small"
                  checked={crEnabledSafe}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(_, checked) => onFiltersChange({ crEnabled: checked })}
                />
              </Box>

              <Collapse in={crEnabledSafe}>
                <Box sx={{ px: 2, pb: 2 }}>{renderEditor('cr')}</Box>
              </Collapse>
            </Box>
          </Box>

          <Box sx={{ borderTop: 1, borderColor: 'divider', px: 3, py: 2 }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" gap={1}>
              <Button
                size="small"
                disabled={advancedChips.length === 0}
                onClick={() => onFiltersChange(clearAllMatchFilters())}
              >
                清除全部條件
              </Button>
              <Button variant="contained" size="small" onClick={() => setAdvancedOpen(false)}>
                完成
              </Button>
            </Box>
          </Box>
        </Box>
      </Drawer>
    </Box>
  )
}

export default SearchBar
