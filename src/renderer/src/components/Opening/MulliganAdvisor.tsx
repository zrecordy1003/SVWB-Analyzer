/**
 * 換牌建議 - "against this opponent, what do I want in my opening hand?", from
 * the user's own matches.
 *
 * One control and two columns. The control is the opponent class; the columns
 * are 先攻 on the left and 後攻 on the right, each recommending which cards to
 * keep and which to throw back against that opponent on that turn order.
 *
 * # Why the turn order is a column and not a selector
 *
 * The first version had a three-way segmented control (先攻 / 後攻 / 不分) next
 * to the class picker and a single table under both. The owner's redirection
 * was that the question a player brings to this page is 「對上龍族」, full
 * stop - they do not choose a turn order, the coin does, and they want both
 * answers in front of them before the coin lands. So the turn order became the
 * layout. Two queries instead of one (the handler takes ~7ms; the resource
 * caches per payload) and the 「不分」 option is gone: a pooled answer is what
 * the handler falls back to on its own when one order is thin, and the basis
 * mark says so on the row, which is a better place for it than a selector
 * nobody would know when to use.
 *
 * # The sentence
 *
 * The plan's 七 is unusually direct: at this scale the honest claim is "a
 * shrunk estimate with a control group", not a causal effect, and that belongs
 * in interface copy more than in the formula. The 起手 page put its equivalent
 * behind an ⓘ. This page does not, because the failure mode is different and
 * now sharper: a reader who takes 「建議留」 as proof that keeping a card wins
 * is wrong about a confounded comparison, and will change how they play. One
 * line, always visible, in secondary text so it frames the columns rather
 * than shouting over them. The three things that can never be fixed (五) are
 * behind the ⓘ with the rest of the reasoning.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Box, Paper, Typography } from '@mui/material'

import type { KeepAdvice, MulliganResult } from '@shared/openingStats'
import { ClassSelect, type ClassChoiceId } from '@renderer/components/Common/filters/ClassSelect'
import InfoHint from '@renderer/components/Common/InfoHint'

import MulliganColumn from './MulliganColumn'
import MulliganDrilldownDrawer from './MulliganDrilldownDrawer'
import { pinsOf, type ColumnOrder, type Pins } from './mulliganState'

const QUESTION_CONTROL_HEIGHT = 40

/**
 * The one sentence. It names what is compared (your kept hands against your
 * swapped ones), what that describes (your decisions and their outcomes) and
 * what it cannot show (what the other choice would have done).
 */
const HONEST_LINE =
  '這裡比的是你自己留下這張時、和你自己換掉它時的戰績——它描述你的決定與結果，證明不了另一種選擇會怎樣。'

/**
 * The ⓘ: the reasoning the sentence compresses, and the three things the
 * plan's 五 says can never be fixed and must be on the page.
 */
function TitleHint(): React.JSX.Element {
  return (
    <Box data-testid="mulligan-explainer" sx={{ maxWidth: 380, '& > * + *': { mt: 0.75 } }}>
      <Typography variant="caption" component="div" sx={{ lineHeight: 1.6 }}>
        <Box component="span" sx={{ fontWeight: 800 }}>
          留不留是你決定的，所以「留 vs 換」不是公平的比較。
        </Box>
        你在其餘三張順的時候才敢留貴的，於是「留下時勝率高」反映的常是其餘三張。這頁的做法是只在其餘三張費用差不多的手牌之間比（「其餘三張相近」），再把三段合起來；樣本不夠時往外放寬，並在卡片旁邊標記。
      </Typography>
      <Typography variant="caption" component="div" sx={{ lineHeight: 1.6 }}>
        <Box component="span" sx={{ fontWeight: 800 }}>
          只有整個區間都在零的同一側才給建議。
        </Box>
        「建議留」是比印一個數字更強的主張，所以門檻只升不降：算得出差值但區間跨過零的卡，這頁不給方向，只算進「還不能給建議」那一行。
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

/** The card open in the drawer, with the column it was opened from - the drawer's labels need both. */
type Selection = { advice: KeepAdvice; order: ColumnOrder }

export default function MulliganAdvisor({
  oppoClass,
  onOppoClass,
  first,
  second,
  loading,
  showImages
}: {
  oppoClass: ClassChoiceId
  onOppoClass: (next: ClassChoiceId) => void
  first: MulliganResult | null
  second: MulliganResult | null
  loading: boolean
  showImages: boolean
}): React.JSX.Element {
  const [selected, setSelected] = useState<Selection | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const pins = useMemo<Record<ColumnOrder, Pins>>(
    () => ({ first: pinsOf(oppoClass, 'first'), second: pinsOf(oppoClass, 'second') }),
    [oppoClass]
  )

  // When the data refreshes under an open drawer, follow the same card into the
  // new result so the drawer shows the live numbers; when the card is gone,
  // keep the last one mounted so the drawer can slide out over something.
  const lastRef = useRef<Selection | null>(null)
  const current = useMemo(() => {
    if (!selected) return lastRef.current
    const source = selected.order === 'first' ? first : second
    const found = source?.cards.find((c) => c.cardId === selected.advice.cardId)
    const next = found ? { advice: found, order: selected.order } : selected
    lastRef.current = next
    return next
  }, [selected, first, second])

  const openFrom = useCallback(
    (order: ColumnOrder) => (advice: KeepAdvice) => {
      setSelected({ advice, order })
      setDrawerOpen(true)
    },
    []
  )
  const openFirst = useMemo(() => openFrom('first'), [openFrom])
  const openSecond = useMemo(() => openFrom('second'), [openFrom])

  const selectedIn = (order: ColumnOrder): number | null =>
    drawerOpen && selected?.order === order ? selected.advice.cardId : null

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
            對上
          </Typography>
          <ClassSelect<ClassChoiceId>
            allowAll
            value={oppoClass}
            onChange={onOppoClass}
            height={QUESTION_CONTROL_HEIGHT}
          />
          <InfoHint label="這一頁在比什麼" title={<TitleHint />} />
        </Box>
        <Typography
          variant="caption"
          data-testid="mulligan-honest-line"
          sx={{ color: 'text.secondary', lineHeight: 1.6 }}
        >
          {HONEST_LINE}
        </Typography>
      </Paper>

      {/* ---------- 兩欄 ---------- */}
      {/* Equal columns from the md breakpoint (900px) up, stacked below. Grid rather than flex so
          the two headings sit on one line at any width the columns share. */}
      <Box
        data-testid="mulligan-columns"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 1.5,
          alignItems: 'start'
        }}
      >
        <MulliganColumn
          order="first"
          pins={pins.first}
          data={first}
          loading={loading}
          showImages={showImages}
          selectedId={selectedIn('first')}
          onSelect={openFirst}
        />
        <MulliganColumn
          order="second"
          pins={pins.second}
          data={second}
          loading={loading}
          showImages={showImages}
          selectedId={selectedIn('second')}
          onSelect={openSecond}
        />
      </Box>

      <MulliganDrilldownDrawer
        advice={current?.advice ?? null}
        pins={current ? pins[current.order] : pins.first}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  )
}
