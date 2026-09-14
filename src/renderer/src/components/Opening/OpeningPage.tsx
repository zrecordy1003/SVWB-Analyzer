/**
 * 起手 - opening-hand statistics over the user's own matches.
 *
 * Two regions, top to bottom: the hand-level summary (coverage, swap counts,
 * curve) and the card table with its drill-down. The order is the order of
 * trust: the summary needs only that hands were read, the table additionally
 * needs decks and sample sizes.
 *
 * # Where the explanation went
 *
 * The first pass printed a fixed paragraph between the two regions - why
 * "dealt vs not dealt" is a fair comparison and why the page refuses to print
 * a kept-hand win rate. The user's direction was unambiguous: a good page is
 * understood at a glance, and anything that needs a sentence goes behind a
 * hover. So the paragraph is now the ⓘ beside the table's title, on the app's
 * shared `InfoHint`. The cost is real and worth naming: a reader who never
 * hovers may read the comparison column as the "opening-hand win rate" every
 * other tool prints. Two things soften it - the column is labelled 發到 vs
 * 沒發到, not 勝率, and its own header ⓘ repeats the one-line version.
 *
 * Layout and chrome follow 卡片 / 牌組戰績 - same toolbar, same heights, same
 * chip mechanics, the filter components imported verbatim - because a third
 * page that looked a few percent different would read as a different app.
 *
 * # 示範資料
 *
 * The toolbar has a switch that swaps the real result for a hand-written one
 * (`demoData.ts`). It exists because the page has far more states than a young
 * account will show, and the empty ones have to be judged too. It defaults to
 * off, it is labelled in the warning colour on the switch AND with a banner
 * across the content, and it is not persisted: nobody should come back
 * tomorrow to a page of numbers that were never theirs.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  FormControl,
  FormControlLabel,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Stack,
  Switch,
  Typography
} from '@mui/material'
import DateRangeOutlinedIcon from '@mui/icons-material/DateRangeOutlined'
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
import type { SvgIconComponent } from '@mui/icons-material'

import { classes, modes } from '@renderer/map/classMap'
import { ModeSelect } from '@renderer/components/Common/filters/ModeSelect'
import { ClassSelect } from '@renderer/components/Common/filters/ClassSelect'
import InfoHint from '@renderer/components/Common/InfoHint'
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
import {
  CARDS_ADVANCED_LABELS,
  cardsAdvancedChips,
  clearAllCardsAdvanced,
  clearCardsAdvanced,
  enableCardsAdvanced,
  type CardsAdvancedKey,
  type CardsVocabulary
} from '@renderer/components/Cards/cardsFilterState'
import { useDecksTags } from '../../hooks/useDecksTags'

import OpeningSummaryPanel from './OpeningSummaryPanel'
import OpeningTable from './OpeningTable'
import OpeningDrilldownDrawer from './OpeningDrilldownDrawer'
import { DEMO_VARIANTS, type DemoVariantKey } from './demoData'
import {
  DEFAULT_OPENING_SORT,
  buildOpeningQuery,
  defaultOpeningFilters,
  diffOpeningPersistPatch,
  hydrateOpeningFilters,
  nextOpeningSort,
  sortOpeningRows,
  toOpeningRows,
  unrankedBoundary,
  type OpeningFilters,
  type OpeningRow,
  type OpeningSort
} from './openingFilterState'
import { NUMERIC } from './openingFormat'
import { useOpeningStats } from './useOpeningStats'

const TOOLBAR_CONTROL_HEIGHT = 36
const QUERY_DEBOUNCE_MS = 180
const PERSIST_DEBOUNCE_MS = 400

const CLASS_ORDER = classes.map((c) => String(c.id))

const VOCABULARY: CardsVocabulary = {
  classIds: CLASS_ORDER,
  modeIds: modes.map((m) => String(m.id))
}

const ADVANCED_ICONS: Record<CardsAdvancedKey, SvgIconComponent> = {
  range: DateRangeOutlinedIcon,
  decks: StyleOutlinedIcon
}

/**
 * The sentences that make the table trustworthy, as the table title's ⓘ.
 *
 * Formatted rather than one run-on caption: the two bold lead-ins are the two
 * halves of the argument, and the last line is the coverage fact the table's
 * n's depend on. It takes the counts so the denominators are the live ones.
 */
function TableHint({
  withDeck,
  preComplete
}: {
  withDeck: number
  preComplete: number
}): React.JSX.Element {
  return (
    <Box data-testid="opening-explainer" sx={{ maxWidth: 360, '& > * + *': { mt: 0.75 } }}>
      <Typography variant="caption" component="div" sx={{ lineHeight: 1.6 }}>
        <Box component="span" sx={{ fontWeight: 800 }}>
          起手四張是隨機發到的。
        </Box>
        有沒有發到某張卡，和對手、先後手、你那天的狀態都無關，所以「發到 vs
        沒發到」的勝率差是公平的比較 - 它量的是這張卡在起手時對這副牌的價值。
      </Typography>
      <Typography variant="caption" component="div" sx={{ lineHeight: 1.6 }}>
        <Box component="span" sx={{ fontWeight: 800 }}>
          換牌後留下的是你選的。
        </Box>
        留下來的勝率量的是你的判斷，不是這張卡，所以這頁沒有「留下時的勝率」-
        別家工具印成「起手勝率」的就是那個數字。
      </Typography>
      <Typography
        variant="caption"
        component="div"
        color="text.secondary"
        sx={{ ...NUMERIC, lineHeight: 1.6 }}
      >
        發到率和對照需要牌組，只算 {withDeck} 場有掛牌組的對局；保留率不需要，{preComplete}{' '}
        場四張全辨識的都算。
      </Typography>
    </Box>
  )
}

export default function OpeningPage(): React.JSX.Element {
  const [filters, setFilters] = useState<OpeningFilters>(defaultOpeningFilters)
  const [sort, setSort] = useState<OpeningSort>(DEFAULT_OPENING_SORT)
  const [showArchivedDecks, setShowArchivedDecks] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** Off by default and never persisted; see the file header. */
  const [demo, setDemo] = useState(false)
  const [demoVariant, setDemoVariant] = useState<DemoVariantKey>('full')

  const { allDeckVersions, loading: decksLoading, refreshDecks } = useDecksTags()

  const settingsLoadedRef = useRef(false)
  const persistedRef = useRef<OpeningFilters | null>(null)
  const prevClassRef = useRef<OpeningFilters['myClass'] | null>(null)
  const prunedRef = useRef(false)

  const patchFilters = useCallback((patch: Partial<OpeningFilters>): void => {
    setFilters((prev) => ({ ...prev, ...patch }))
  }, [])

  /* ---------- 還原設定 ---------- */
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const raw = await window.settings.getAll().catch(() => null)
      if (!mounted) return
      const hydrated = hydrateOpeningFilters(raw, VOCABULARY)
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
      const patch = diffOpeningPersistPatch(persistedRef.current, filters)
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

  useEffect(() => {
    if (prunedRef.current || !settingsLoadedRef.current || !allDeckVersions?.length) return
    prunedRef.current = true
    setFilters((prev) => {
      const decks = pruneDeckSelection(prev.decks, deckFamilies)
      return sameDeckSelection(decks, prev.decks) ? prev : { ...prev, decks }
    })
  }, [allDeckVersions, deckFamilies])

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
  const [debounced, setDebounced] = useState(filters)
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(filters), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [filters])
  const query = useMemo(() => {
    if (!settingsLoadedRef.current) return null
    if (decksLoading && !isEmptyDeckSelection(debounced.decks)) return null
    return buildOpeningQuery(debounced, deckFamilies)
  }, [debounced, deckFamilies, decksLoading])
  const live = useOpeningStats(query)

  // The swap is here and nowhere else: everything below reads `data` and does
  // not know whether it is real.
  const demoResult = useMemo(
    () => DEMO_VARIANTS.find((v) => v.key === demoVariant)?.result ?? DEMO_VARIANTS[0].result,
    [demoVariant]
  )
  const data = demo ? demoResult : live.data
  const loading = demo ? false : live.loading
  const error = demo ? null : live.error

  const allRows = useMemo(() => toOpeningRows(data), [data])
  const rows = useMemo(() => sortOpeningRows(allRows, sort), [allRows, sort])
  const unrankedFrom = useMemo(() => unrankedBoundary(rows, sort), [rows, sort])

  const lastSelectedRef = useRef<OpeningRow | null>(null)
  const selectedRow = useMemo(() => {
    const found = selectedKey ? allRows.find((r) => r.key === selectedKey) : undefined
    if (found) lastSelectedRef.current = found
    return found ?? lastSelectedRef.current
  }, [allRows, selectedKey])

  const openRow = useCallback((row: OpeningRow): void => {
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
    if (data.summary.matches === 0) {
      return '這個範圍內沒有讀到任何起手。只有 1.3.5 之後、看得到換牌畫面的對局才會進來。'
    }
    if (allRows.length === 0) {
      return `${data.summary.matches} 場讀到換牌畫面，還沒有一張卡被認出來。卡圖索引在背景建，建完會自動補上。`
    }
    return ''
  })()

  const summary = data?.summary ?? null

  return (
    <Box
      data-testid="opening-page"
      sx={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1.5, pb: 4 }}
    >
      {/* 工作列：和 卡片 / 牌組戰績 同一套。右邊是示範資料的開關，它不是篩選條件，
          所以隔著空白擺到另一邊，而且用警告色 - 它開著的時候畫面上不能有一個數字
          讓人誤以為是自己的。 */}
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

          <Stack direction="row" alignItems="center" spacing={1} data-testid="opening-demo">
            {demo && (
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <Select
                  value={demoVariant}
                  onChange={(event) => setDemoVariant(event.target.value as DemoVariantKey)}
                  inputProps={{ 'aria-label': '示範資料的情境' }}
                  sx={{ height: TOOLBAR_CONTROL_HEIGHT, fontSize: 13 }}
                >
                  {DEMO_VARIANTS.map((v) => (
                    <MenuItem key={v.key} value={v.key} sx={{ fontSize: 13 }}>
                      {v.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  color="warning"
                  checked={demo}
                  onChange={(event) => setDemo(event.target.checked)}
                  inputProps={{ 'aria-label': '顯示示範資料' }}
                />
              }
              label={
                <Chip
                  icon={<ScienceOutlinedIcon sx={{ fontSize: 15 }} />}
                  label="示範資料"
                  size="small"
                  color="warning"
                  variant={demo ? 'filled' : 'outlined'}
                  sx={{ height: 24, fontWeight: 700, cursor: 'pointer' }}
                />
              }
              sx={{ ml: 0.5, mr: 0 }}
            />
          </Stack>
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

      {demo && (
        <Alert
          severity="warning"
          icon={<ScienceOutlinedIcon fontSize="inherit" />}
          data-testid="opening-demo-banner"
          sx={{ borderRadius: 2, py: 0.5 }}
        >
          <Box component="span" sx={{ fontWeight: 800 }}>
            這一頁顯示的是示範資料，不是你的紀錄。
          </Box>{' '}
          篩選對它無效；關掉右上角的開關就回到真的。
        </Alert>
      )}

      {error && (
        <Alert severity="warning" sx={{ borderRadius: 2 }}>
          {error}
        </Alert>
      )}

      {/* ---------- A. 手牌總覽 ---------- */}
      <Paper variant="outlined" sx={{ borderRadius: 2, p: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1.5 }}>
          手牌總覽
        </Typography>
        <OpeningSummaryPanel summary={summary} loading={loading} />
      </Paper>

      {/* ---------- B. 卡片表 ---------- */}
      <Paper elevation={0} sx={{ position: 'relative', borderRadius: 2, overflow: 'hidden' }}>
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
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={800}>
              卡片
            </Typography>
            {summary !== null && (
              <InfoHint
                label="這張表在比什麼"
                title={<TableHint withDeck={summary.withDeck} preComplete={summary.preComplete} />}
              />
            )}
          </Stack>
          {summary === null ? (
            <Skeleton variant="text" width={60} sx={{ ml: 'auto' }} />
          ) : (
            <Typography
              variant="caption"
              data-testid="opening-table-count"
              sx={{ ...NUMERIC, ml: 'auto', color: 'text.secondary' }}
            >
              <Box component="span" sx={{ fontWeight: 800, color: 'text.primary' }}>
                {allRows.length}
              </Box>{' '}
              種卡
            </Typography>
          )}
        </Box>

        <OpeningTable
          rows={rows}
          sort={sort}
          onSort={(key) => setSort((prev) => nextOpeningSort(prev, key))}
          unrankedFrom={unrankedFrom}
          showImages={live.showImages}
          selectedKey={drawerOpen ? selectedKey : null}
          onSelect={openRow}
          loading={loading || data === null}
          emptyText={emptyText}
        />
      </Paper>

      <OpeningDrilldownDrawer
        row={selectedRow}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        baseQuery={query}
        demo={demo}
      />
    </Box>
  )
}
