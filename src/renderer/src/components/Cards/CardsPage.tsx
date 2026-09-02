/**
 * 卡片 - the card-axis lookup over the user's own matches.
 *
 * Not a card ranking. With no draw/play events the only per-card number is the
 * record of the decks that carried it (docs/card-stats-research.md), so this
 * page is built as retrieval and drill-down: which of my decks and versions ran
 * this card, and how did those decks do. Every label says so.
 *
 * Layout follows 牌組戰績: toolbar (class, mode, one switch) with the
 * advanced-condition row under it, a one-line summary, then the table. The
 * same components, the same heights, the same chip mechanics - a third page
 * that looked a few percent different would read as a different app.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  FormControlLabel,
  Paper,
  Skeleton,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import DateRangeOutlinedIcon from '@mui/icons-material/DateRangeOutlined'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
import type { SvgIconComponent } from '@mui/icons-material'

import { CARD_STATS_LOW_SAMPLE } from '@shared/cardStats'
import { classes, modes } from '@renderer/map/classMap'
import { ModeSelect } from '@renderer/components/Common/filters/ModeSelect'
import { ClassSelect } from '@renderer/components/Common/filters/ClassSelect'
import { AdvancedFilterBar } from '@renderer/components/Common/filters/AdvancedFilterBar'
import { DeckEditor, RangeEditor } from '@renderer/components/Common/filters/FilterEditors'
import {
  buildDeckFamilyOptions,
  isEmptyDeckSelection,
  pruneDeckSelection,
  restrictSelectionToClass,
  sameDeckSelection,
  visibleDeckOptions
} from '@renderer/components/Common/filters/deckSelection'
import { groupDeckFamilies } from '@renderer/components/DeckCards/deckVersions'
import { useCardStats } from '@renderer/components/DeckCards/useCardStats'
import { useDecksTags } from '../../hooks/useDecksTags'

import CardsTable from './CardsTable'
import CardDrilldownDrawer from './CardDrilldownDrawer'
import {
  CARDS_ADVANCED_LABELS,
  DEFAULT_CARDS_SORT,
  applyLowSample,
  buildCardsQuery,
  cardsAdvancedChips,
  clearAllCardsAdvanced,
  clearCardsAdvanced,
  defaultCardsFilters,
  diffCardsPersistPatch,
  enableCardsAdvanced,
  hydrateCardsFilters,
  nextSort,
  sortCardRows,
  summarize,
  toCardRows,
  type CardRow,
  type CardsAdvancedKey,
  type CardsFilters,
  type CardsSort,
  type CardsVocabulary
} from './cardsFilterState'

const TOOLBAR_CONTROL_HEIGHT = 36
const QUERY_DEBOUNCE_MS = 180
const PERSIST_DEBOUNCE_MS = 400

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

const CLASS_ORDER = classes.map((c) => String(c.id))

const VOCABULARY: CardsVocabulary = {
  classIds: CLASS_ORDER,
  modeIds: modes.map((m) => String(m.id))
}

const ADVANCED_ICONS: Record<CardsAdvancedKey, SvgIconComponent> = {
  range: DateRangeOutlinedIcon,
  decks: StyleOutlinedIcon
}

export default function CardsPage(): React.JSX.Element {
  const [filters, setFilters] = useState<CardsFilters>(defaultCardsFilters)
  const [sort, setSort] = useState<CardsSort>(DEFAULT_CARDS_SORT)
  const [showArchivedDecks, setShowArchivedDecks] = useState(false)
  /**
   * 樣本不足的卡預設不列（不到 `CARD_STATS_LOW_SAMPLE` 場）。開著時它們灰階
   * 出現。這一頁唯一的開關；不存檔——它是「讓我看一眼」，不是偏好。
   */
  const [showLowSample, setShowLowSample] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const { allDeckVersions, loading: decksLoading, refreshDecks } = useDecksTags()

  /** Write gate: opens once the stored settings have been read. */
  const settingsLoadedRef = useRef(false)
  const persistedRef = useRef<CardsFilters | null>(null)
  const prevClassRef = useRef<CardsFilters['myClass'] | null>(null)
  const prunedRef = useRef(false)

  const patchFilters = useCallback((patch: Partial<CardsFilters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }))
  }, [])

  /* ---------- 還原設定 ---------- */
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const raw = await window.settings.getAll().catch(() => null)
      if (!mounted) return
      const hydrated = hydrateCardsFilters(raw, VOCABULARY)
      persistedRef.current = hydrated
      prevClassRef.current = hydrated.myClass
      settingsLoadedRef.current = true
      setFilters(hydrated)
    })()
    return () => {
      mounted = false
    }
  }, [])

  /* ---------- 持久化 ---------- */
  useEffect(() => {
    if (!settingsLoadedRef.current) return
    const handle = setTimeout(() => {
      const patch = diffCardsPersistPatch(persistedRef.current, filters)
      if (!patch) return
      persistedRef.current = filters
      window.settings.setMany(patch).catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [filters])

  /* ---------- 牌組選項 ---------- */
  const deckFamilies = useMemo(() => groupDeckFamilies(allDeckVersions ?? []), [allDeckVersions])
  const allDeckOptions = useMemo(
    () => buildDeckFamilyOptions(deckFamilies, CLASS_ORDER),
    [deckFamilies]
  )
  const deckOptions = useMemo(
    () =>
      visibleDeckOptions(allDeckOptions, {
        classId: filters.myClass === 'all' ? null : filters.myClass,
        showArchived: showArchivedDecks
      }),
    [allDeckOptions, filters.myClass, showArchivedDecks]
  )

  /** 上次存的牌組若已經不存在就剔掉；舊版存的 id 在這裡對回它的牌組。 */
  useEffect(() => {
    if (prunedRef.current || !settingsLoadedRef.current || !allDeckVersions?.length) return
    prunedRef.current = true
    setFilters((prev) => {
      const decks = pruneDeckSelection(prev.decks, deckFamilies)
      return sameDeckSelection(decks, prev.decks) ? prev : { ...prev, decks }
    })
  }, [allDeckVersions, deckFamilies])

  /* ---------- 切換職業時剔掉不屬於它的已選牌組 ---------- */
  useEffect(() => {
    if (!settingsLoadedRef.current) return
    if (prevClassRef.current !== null && prevClassRef.current !== filters.myClass) {
      const klass = filters.myClass
      setFilters((prev) => {
        if (klass === 'all' || isEmptyDeckSelection(prev.decks)) return prev
        const kept = restrictSelectionToClass(prev.decks, allDeckOptions, klass)
        return sameDeckSelection(kept, prev.decks) ? prev : { ...prev, decks: kept }
      })
    }
    prevClassRef.current = filters.myClass
  }, [allDeckOptions, filters.myClass])

  /* ---------- 查詢 ---------- */
  // Debounced like the analyzer's: a burst of clicks must not fire a query per
  // click. The sample line is applied here in the renderer, so only the
  // query-relevant fields are debounced.
  const [debounced, setDebounced] = useState(filters)
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(filters), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [filters])
  const query = useMemo(() => {
    if (!settingsLoadedRef.current) return null
    // A deck pick resolves against the deck list; before it arrives the pick
    // would resolve to nothing, and nothing means "every deck".
    if (decksLoading && !isEmptyDeckSelection(debounced.decks)) return null
    return buildCardsQuery(debounced, deckFamilies)
  }, [debounced, deckFamilies, decksLoading])
  const { data, loading, error, showImages } = useCardStats(query)

  const allRows = useMemo(() => toCardRows(data), [data])
  const rows = useMemo(
    () => sortCardRows(applyLowSample(allRows, showLowSample), sort),
    [allRows, showLowSample, sort]
  )
  const summary = useMemo(() => summarize(data), [data])
  const hiddenCount = useMemo(() => allRows.filter((row) => row.lowSample).length, [allRows])

  /**
   * The drawer shows the row by key, so a refetch (a match just recorded)
   * updates its numbers in place. When the row leaves the table - the filter
   * changed under it - the drawer keeps the last thing it showed until closed.
   */
  const lastSelectedRef = useRef<CardRow | null>(null)
  const selectedRow = useMemo(() => {
    const live = selectedKey ? allRows.find((r) => r.key === selectedKey) : undefined
    if (live) lastSelectedRef.current = live
    return live ?? lastSelectedRef.current
  }, [allRows, selectedKey])

  const openRow = useCallback((row: CardRow): void => {
    setSelectedKey(row.key)
    setDrawerOpen(true)
  }, [])

  const advancedChips = useMemo(() => cardsAdvancedChips(filters), [filters])
  const addableKeys = useMemo<CardsAdvancedKey[]>(() => {
    const active = new Set(advancedChips.map((chip) => chip.key))
    return (Object.keys(CARDS_ADVANCED_LABELS) as CardsAdvancedKey[]).filter((k) => !active.has(k))
  }, [advancedChips])

  const renderEditor = (key: CardsAdvancedKey, autoFocus: boolean): React.ReactNode => {
    switch (key) {
      case 'range':
        return (
          <RangeEditor
            rangeKey={filters.rangeKey}
            startDate={filters.startDate}
            endDate={filters.endDate}
            onChange={patchFilters}
          />
        )
      case 'decks':
        return (
          <DeckEditor
            options={deckOptions}
            allOptions={allDeckOptions}
            value={filters.decks}
            onOpen={refreshDecks}
            onChange={(decks) => patchFilters({ decks })}
            autoFocus={autoFocus}
            header={
              <Box display="flex" alignItems="center" justifyContent="flex-end" gap={1}>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={showArchivedDecks}
                      onChange={(event) => setShowArchivedDecks(event.target.checked)}
                      inputProps={{ 'aria-label': '顯示已刪除的牌組' }}
                    />
                  }
                  label={
                    <Typography variant="caption" color="text.secondary">
                      顯示已刪除的牌組
                    </Typography>
                  }
                  sx={{ mr: 0 }}
                />
              </Box>
            }
          />
        )
    }
  }

  /* ---------- 空狀態文案 ---------- */
  const emptyText = (() => {
    if (!data) return ''
    if (data.coverage.total === 0) return '這個範圍內沒有對局。放寬時間區間，或清掉牌組條件再看看。'
    if (allRows.length === 0) {
      return '這個範圍內沒有任何一場對局指向有卡表的牌組。用牌組代碼匯入或在建構器裡補上卡表後，之後的對局就會進到這裡。'
    }
    return `每張卡都不到 ${CARD_STATS_LOW_SAMPLE} 場。開啟「顯示樣本不足的卡」就看得到它們。`
  })()

  const coverageTip = summary
    ? `卡片統計涵蓋 ${summary.covered}/${summary.total} 場對局：只有指向可查卡表的對局才算得出來，更早之前被覆寫過的舊卡表已無法追回。這些數字是牌組的成績，不是卡片本身的——沒有抽牌／出牌資料，看不出這張卡在手上時打得怎樣。`
    : ''

  return (
    <Box
      data-testid="cards-page"
      sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.5, pb: 4 }}
    >
      {/* 工作列：看誰的卡、哪個模式；右邊是唯一的開關 - 它不縮小資料，只把
          預設藏起來的那幾列放回來，所以隔著空白擺到另一邊。 */}
      <Paper
        variant="outlined"
        sx={{ borderRadius: 2, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}
      >
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          <ClassSelect
            allowAll
            value={filters.myClass}
            onChange={(myClass) => patchFilters({ myClass })}
            height={TOOLBAR_CONTROL_HEIGHT}
          />
          <ModeSelect
            value={filters.gameMode}
            onChange={(gameMode) => patchFilters({ gameMode })}
            height={TOOLBAR_CONTROL_HEIGHT}
          />

          <Box sx={{ flex: 1, minWidth: 8 }} />

          <Box data-testid="cards-show-low-sample">
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showLowSample}
                  onChange={(event) => setShowLowSample(event.target.checked)}
                  inputProps={{ 'aria-label': '顯示樣本不足的卡' }}
                />
              }
              label={
                <Typography variant="body2" color="text.secondary">
                  顯示樣本不足的卡
                  {hiddenCount > 0 && !showLowSample ? `（${hiddenCount}）` : ''}
                </Typography>
              }
              sx={{ ml: 0.5, mr: 0 }}
            />
          </Box>
        </Box>

        <AdvancedFilterBar
          chips={advancedChips}
          addableKeys={addableKeys}
          labels={CARDS_ADVANCED_LABELS}
          icons={ADVANCED_ICONS}
          renderEditor={renderEditor}
          onEnable={(key) => patchFilters(enableCardsAdvanced(key))}
          onRemove={(key) => patchFilters(clearCardsAdvanced(key))}
          onClearAll={() => patchFilters(clearAllCardsAdvanced())}
          editorWidth={(key) => (key === 'decks' ? 420 : 372)}
        />
      </Paper>

      <Paper elevation={0} sx={{ position: 'relative', borderRadius: 2, overflow: 'hidden' }}>
        {error && (
          <Alert severity="warning" square>
            {error}
          </Alert>
        )}

        {/* 摘要列：兩個數字，涵蓋率與「這是牌組的成績」收進旁邊的 ⓘ。 */}
        <Box
          sx={{
            px: { xs: 2, sm: 2.5 },
            py: 1.5,
            display: 'flex',
            gap: { xs: 1.5, sm: 3 },
            alignItems: 'center',
            flexWrap: 'wrap',
            bgcolor: 'action.hover'
          }}
        >
          {summary === null ? (
            <>
              <Skeleton variant="text" width={90} />
              <Skeleton variant="text" width={120} />
            </>
          ) : (
            <>
              <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Box component="span">
                  <Box component="span" sx={{ ...NUMERIC, fontWeight: 700 }}>
                    {summary.cards}
                  </Box>
                  <Box component="span" color="text.secondary">
                    {' '}
                    種卡 ·{' '}
                  </Box>
                  <Box component="span" sx={{ ...NUMERIC, fontWeight: 700 }}>
                    {summary.families}
                  </Box>
                  <Box component="span" color="text.secondary">
                    {' '}
                    副牌組
                  </Box>
                </Box>
                <Tooltip title={coverageTip} placement="top">
                  <Box
                    component="span"
                    data-testid="cards-coverage"
                    data-covered={summary.covered}
                    data-total={summary.total}
                    aria-label="卡片統計的涵蓋範圍"
                    sx={{ display: 'inline-flex', color: 'text.disabled', cursor: 'help' }}
                  >
                    <InfoOutlinedIcon sx={{ fontSize: 15 }} />
                  </Box>
                </Tooltip>
              </Typography>
            </>
          )}
        </Box>

        <CardsTable
          rows={rows}
          sort={sort}
          onSort={(key) => setSort((prev) => nextSort(prev, key))}
          showImages={showImages}
          showClass={filters.myClass === 'all'}
          selectedKey={drawerOpen ? selectedKey : null}
          onSelect={openRow}
          loading={loading || data === null}
          emptyText={emptyText}
        />
      </Paper>

      <CardDrilldownDrawer
        row={selectedRow}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </Box>
  )
}
