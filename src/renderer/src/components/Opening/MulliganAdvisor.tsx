/**
 * 換牌建議 - "against this opponent, should I keep this card?", from the
 * user's own matches.
 *
 * Three regions, top to bottom: the question (opponent and turn order, with
 * the size of the match set it selects), the one sentence that says what the
 * numbers are and are not, and the table with its drill-down.
 *
 * # The question is the header, not a filter
 *
 * The 起手 page's filters live in a toolbar because they narrow a fixed
 * question. Here the opponent IS the question - the plan's title is 「對上某
 * 職業該留哪幾張」 - so the class picker sits in its own panel, taller than
 * the toolbar controls, with the turn order beside it and the match set it
 * selects printed on the right. Changing it should feel like asking again,
 * and the table re-rendering under a stable header is what makes it feel so.
 *
 * # The sentence
 *
 * The plan's 七 is unusually direct: at this scale the honest claim is "a
 * shrunk estimate with a control group", not a causal effect, and that belongs
 * in interface copy more than in the formula. The 起手 page put its equivalent
 * behind an ⓘ. This page does not, because the failure mode is different: a
 * reader who misreads 「發到 vs 沒發到」 as an opening-hand win rate is wrong
 * about a clean number; a reader who takes 「留 vs 換」 as proof that keeping
 * a card wins is wrong about a confounded one, and will change how they play.
 * One line, always visible, in secondary text so it frames the table rather
 * than shouting over it. The three things that can never be fixed (五) are
 * behind the title's ⓘ with the rest of the reasoning.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Box, Paper, Skeleton, Stack, Typography } from '@mui/material'

import type { MulliganResult } from '@shared/openingStats'
import { ClassSelect, type ClassChoiceId } from '@renderer/components/Common/filters/ClassSelect'
import InfoHint from '@renderer/components/Common/InfoHint'
import SegmentedControl from '@renderer/components/Common/SegmentedControl'

import MulliganDrilldownDrawer from './MulliganDrilldownDrawer'
import MulliganTable from './MulliganTable'
import {
  mulliganUnrankedBoundary,
  pinsOf,
  questionLabel,
  sortMulliganRows,
  toMulliganRows,
  type MulliganRow
} from './mulliganState'
import {
  DEFAULT_OPENING_SORT,
  nextOpeningSort,
  type OpeningFilters,
  type OpeningSort,
  type PlayOrderChoice
} from './openingFilterState'
import { fmtRate, NUMERIC } from './openingFormat'

const QUESTION_CONTROL_HEIGHT = 40

const ORDER_OPTIONS: { id: PlayOrderChoice; label: string }[] = [
  { id: 'first', label: '先攻' },
  { id: 'second', label: '後攻' },
  { id: 'all', label: '不分' }
]

/**
 * The one sentence. It names what is compared (your kept hands against your
 * swapped ones), what that describes (your decisions and their outcomes) and
 * what it cannot show (what the other choice would have done).
 */
const HONEST_LINE =
  '這裡比的是你自己留下這張時、和你自己換掉它時的戰績——它描述你的決定與結果，證明不了另一種選擇會怎樣。'

/**
 * The title's ⓘ: the reasoning the sentence compresses, and the three things
 * the plan's 五 says can never be fixed and must be on the page.
 */
function TitleHint(): React.JSX.Element {
  return (
    <Box data-testid="mulligan-explainer" sx={{ maxWidth: 380, '& > * + *': { mt: 0.75 } }}>
      <Typography variant="caption" component="div" sx={{ lineHeight: 1.6 }}>
        <Box component="span" sx={{ fontWeight: 800 }}>
          留不留是你決定的，所以「留 vs 換」不是公平的比較。
        </Box>
        你在其餘三張順的時候才敢留貴的，於是「留下時勝率高」反映的常是其餘三張。這頁的做法是只在其餘三張費用差不多的手牌之間比（「其餘三張相近」），再把三段合起來；樣本不夠時往外放寬，並在「比較範圍」欄寫明。
      </Typography>
      <Typography variant="caption" component="div" sx={{ lineHeight: 1.6 }}>
        <Box component="span" sx={{ fontWeight: 800 }}>
          只有一個玩家，所以技術不會混進來。
        </Box>
        留的是你、換的也是你，這是本機資料相對於任何雲端統計的結構優勢。它換不到的是樣本量。
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary" sx={{ lineHeight: 1.6 }}>
        <Box component="span" sx={{ fontWeight: 800 }}>
          三件修不掉的事：
        </Box>
        辨識漏掉的手牌（異畫、閃卡）不是隨機少掉的，所以每個數字都算在缺了一角的資料上；分層只看其餘三張的費用，看不到「有某張才留另一張」這種組合；而數字說的是你的紀錄，不是正確答案——再多場也只是把一個有偏的估計的區間變窄。
      </Typography>
    </Box>
  )
}

export default function MulliganAdvisor({
  filters,
  onPatch,
  data,
  loading,
  showImages
}: {
  filters: OpeningFilters
  onPatch: (patch: Partial<OpeningFilters>) => void
  data: MulliganResult | null
  loading: boolean
  showImages: boolean
}): React.JSX.Element {
  const [sort, setSort] = useState<OpeningSort>(DEFAULT_OPENING_SORT)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const pins = useMemo(() => pinsOf(filters), [filters])
  const allRows = useMemo(() => toMulliganRows(data), [data])
  const rows = useMemo(() => sortMulliganRows(allRows, sort), [allRows, sort])
  const unrankedFrom = useMemo(() => mulliganUnrankedBoundary(rows, sort), [rows, sort])

  const lastSelectedRef = useRef<MulliganRow | null>(null)
  const selectedRow = useMemo(() => {
    const found = selectedKey ? allRows.find((r) => r.key === selectedKey) : undefined
    if (found) lastSelectedRef.current = found
    return found ?? lastSelectedRef.current
  }, [allRows, selectedKey])

  const openRow = useCallback((row: MulliganRow): void => {
    setSelectedKey(row.key)
    setDrawerOpen(true)
  }, [])

  const emptyText = (() => {
    if (!data) return ''
    if (data.matches === 0) {
      return `${questionLabel(pins)}沒有讀到任何四張全認出的起手。只有 1.3.5 之後、看得到換牌畫面的對局才會進來；${
        pins.oppo || pins.order ? '換個對手或先後手試試。' : '多打幾場再回來。'
      }`
    }
    if (allRows.length === 0) {
      return `${data.matches} 場讀到換牌畫面，還沒有一張卡被認出來。卡圖索引在背景建，建完會自動補上。`
    }
    return ''
  })()

  return (
    <>
      {/* ---------- 問題 ---------- */}
      <Paper
        variant="outlined"
        data-testid="mulligan-question"
        sx={{ borderRadius: 2, px: 2, py: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
          <Typography variant="subtitle1" fontWeight={800} sx={{ whiteSpace: 'nowrap' }}>
            對手
          </Typography>
          <ClassSelect<ClassChoiceId>
            allowAll
            value={filters.oppoClass}
            onChange={(oppoClass) => onPatch({ oppoClass })}
            height={QUESTION_CONTROL_HEIGHT}
          />
          <SegmentedControl
            options={ORDER_OPTIONS}
            value={filters.playOrder}
            onChange={(playOrder) => onPatch({ playOrder })}
            height={QUESTION_CONTROL_HEIGHT}
            minSegmentWidth={64}
            aria-label="先後手"
          />

          <Box sx={{ flex: 1, minWidth: 8 }} />

          {/* The match set the question selects, and its own win rate: the
              baseline every arm below is implicitly read against. */}
          {data === null ? (
            <Skeleton variant="text" width={160} />
          ) : (
            <Typography
              variant="caption"
              data-testid="mulligan-baseline"
              sx={{ ...NUMERIC, color: 'text.secondary', whiteSpace: 'nowrap' }}
            >
              <Box component="span" sx={{ fontWeight: 800, color: 'text.primary' }}>
                {data.matches}
              </Box>{' '}
              場完整起手
              {data.baseline && data.baseline.total > 0 ? ` · 勝率 ${fmtRate(data.baseline)}` : ''}
            </Typography>
          )}
        </Box>

        <Typography
          variant="caption"
          data-testid="mulligan-honest-line"
          sx={{ color: 'text.secondary', lineHeight: 1.6 }}
        >
          {HONEST_LINE}
        </Typography>
      </Paper>

      {/* ---------- 表 ---------- */}
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
              {questionLabel(pins)}
            </Typography>
            <InfoHint label="這張表在比什麼" title={<TitleHint />} />
          </Stack>
          {data === null ? (
            <Skeleton variant="text" width={60} sx={{ ml: 'auto' }} />
          ) : (
            <Typography
              variant="caption"
              data-testid="mulligan-table-count"
              sx={{ ...NUMERIC, ml: 'auto', color: 'text.secondary' }}
            >
              <Box component="span" sx={{ fontWeight: 800, color: 'text.primary' }}>
                {allRows.length}
              </Box>{' '}
              種卡
            </Typography>
          )}
        </Box>

        <MulliganTable
          rows={rows}
          pins={pins}
          sort={sort}
          onSort={(key) => setSort((prev) => nextOpeningSort(prev, key))}
          unrankedFrom={unrankedFrom}
          showImages={showImages}
          selectedKey={drawerOpen ? selectedKey : null}
          onSelect={openRow}
          loading={loading || data === null}
          emptyText={emptyText}
        />
      </Paper>

      <MulliganDrilldownDrawer
        row={selectedRow}
        pins={pins}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  )
}
