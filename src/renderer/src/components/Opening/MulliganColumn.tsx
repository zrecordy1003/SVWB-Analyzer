/**
 * One column of the 換牌建議 view: everything the page can say about one turn
 * order against the chosen opponent.
 *
 * Top to bottom: the heading (先攻 or 後攻, with the match set it stands on),
 * the 建議留 group, the 建議換 group, and one line for everything else. The
 * two groups are card rows; the line is a sentence with a disclosure, because
 * most of a deck lives there and a column of thirty rows that each say "no
 * idea" is a column nobody reads twice.
 *
 * # What a row says, and what it no longer says
 *
 * A row is the card, its cost, its name and ONE number: the effect in points,
 * rounded to the integer. The interval is not on the row. It has not been
 * deleted, it has been promoted - it decides whether the row exists at all
 * (`verdictFor`), which is a stronger use of it than printing it beside a
 * number nobody could act on. The sample size stays as a quiet subtitle,
 * because it is the thing that has repeatedly saved this project from
 * believing itself, and the owner asked to remove the interval, not the n.
 *
 * The basis mark stays too, shrunk to a dot on the two tones that honoured
 * the column and kept with its label on the one that did not. A 建議留 that
 * was computed over both turn orders is answering a different question than
 * the column heading asks, and now that the row gives a verdict instead of a
 * number that matters more, not less.
 *
 * # Saying nothing firm is the common state, and it is not the same as
 * # having nothing to show
 *
 * At one player's sample size most matchups will earn no verdict at all. The
 * first design answered that by replacing the entire list with a paragraph -
 * 「還沒有可以建議的卡」 plus a count and the nearest card. It was accurate and
 * it was the wrong thing to put on screen: a reader who opens this page four
 * times and sees the same paragraph each time concludes the feature does not
 * work, because a page with no cards on it looks like a page with no data
 * behind it.
 *
 * So the column always shows cards, in four tiers, and the tier is the
 * strength of the claim:
 *
 *   建議留 / 建議換   the interval clears zero by `minEffect`, BH-corrected
 *   偏留 / 偏換       a real comparison whose interval still straddles zero
 *   留下比例          too thin to compare; shows what the player DID, not
 *                     what it implies
 *
 * The middle tier is the one that needs defending. Its order is largely noise
 * at one player's n, and a reader who treats its top row as a recommendation
 * is reading noise. Three things are done about that rather than hiding it:
 * the direction is stated weakly (偏, not 建議), every row draws its interval
 * so the crossing of zero is visible rather than described, and the row says
 * how far it is from a verdict. The tier is a waiting room with the door
 * open, not a weaker recommendation.
 */
import {
  Box,
  ButtonBase,
  Collapse,
  Paper,
  Skeleton,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import React, { useMemo, useState } from 'react'

import type { KeepAdvice, KeepVerdict, MulliganResult } from '@shared/openingStats'
import { KEEP_THRESHOLDS } from '@shared/openingStats'
import { cardImageUrl } from '@shared/deckImport'
import { CostBadge } from '@renderer/components/Cards/CardsTable'
import InfoHint from '@renderer/components/Common/InfoHint'
import { playOrders } from '@renderer/map/playOrder'

import { Hint, MissingPill } from './cells'
import { BasisMark } from './MulliganMarks'
import {
  distanceToVerdict,
  groupByVerdict,
  keepRateOf,
  questionLabel,
  type ColumnOrder,
  type Pins
} from './mulliganState'
import { ART_WINDOW_RATIO, artWindowImageSx } from '@renderer/components/Common/cardArtWindow'
import { fmtDelta, fmtPct, fmtRate, NUMERIC } from './openingFormat'

/* ------------------------------------------------------------------- art */

/**
 * The window of a card image that is illustration, as fractions of the four
 * edges. Copied from `MatchList/component/OpeningHandStrip.tsx`, which copied
 * it from `tools/engine/src/fingerprint.rs` (`PORTAL_ART_FRACTION`) and
 * explains why that crop and not a prettier one: it is the crop the engine
 * matches on, so a face that is recognisable here is a face the recogniser
 * saw.
 *
 * The window itself lives in `Common/cardArtWindow.ts`, which is where the
 * third copy of it was hoisted to. It has to move with
 * `fingerprint.rs`'s `PORTAL_ART_FRACTION`, and a constant with that
 * obligation must have exactly one home.
 */

/** Row art height. Width follows the window ratio (≈ 0.889), so ≈ 36px. */
const ART_H = 40
const ART_W = Math.round(ART_H * ART_WINDOW_RATIO)

/**
 * The card's illustration or its stand-ins: the `card` image cropped to the
 * art window, then the `list` banner, then nothing. The same fallback order
 * as the per-match strip and for the same reason - a badly cropped banner
 * still beats an empty box, and an empty box beats a skeleton that reads as
 * "still loading" when nothing is.
 */
function RowArt({ advice }: { advice: KeepAdvice }): React.JSX.Element {
  const sources = useMemo(
    () =>
      [
        { kind: 'art' as const, src: cardImageUrl('card', advice.imageHash) },
        { kind: 'banner' as const, src: cardImageUrl('list', advice.bannerHash) }
      ].filter((s): s is { kind: 'art' | 'banner'; src: string } => s.src != null),
    [advice.imageHash, advice.bannerHash]
  )
  const [attempt, setAttempt] = useState(0)
  const current = sources[attempt]
  const frame = {
    width: ART_W,
    height: ART_H,
    flexShrink: 0,
    borderRadius: 0.75,
    overflow: 'hidden',
    position: 'relative' as const,
    bgcolor: 'action.hover'
  }
  if (!current) return <Box aria-hidden sx={frame} />
  if (current.kind === 'art') {
    return (
      <Box sx={frame}>
        <Box
          component="img"
          src={current.src}
          alt=""
          loading="lazy"
          onError={() => setAttempt((n) => n + 1)}
          sx={artWindowImageSx}
        />
      </Box>
    )
  }
  return (
    <Box
      component="img"
      src={current.src}
      alt=""
      loading="lazy"
      onError={() => setAttempt((n) => n + 1)}
      sx={{ ...frame, objectFit: 'cover', objectPosition: '85% center', display: 'block' }}
    />
  )
}

/* ------------------------------------------------------------------- row */

/** Colour and weight for the two groups that get rows. Toss is present but quieter. */
const GROUP_STYLE: Record<'keep' | 'toss', { colour: string; size: number; title: string }> = {
  keep: { colour: 'success.light', size: 20, title: '建議留' },
  toss: { colour: 'error.light', size: 17, title: '建議換' }
}

/**
 * The clickable shell every row in the column shares, so a verdict row and a
 * row inside the disclosure open the drawer the same way and focus the same
 * way. Selected state is a background, not a border, because the column is
 * narrow and a border would eat into the name.
 */
function RowShell({
  advice,
  selected,
  onSelect,
  verdict,
  dense,
  children
}: {
  advice: KeepAdvice
  selected: boolean
  onSelect: (advice: KeepAdvice) => void
  verdict: KeepVerdict
  dense?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ButtonBase
      data-testid={`mulligan-row-${advice.cardId}`}
      data-verdict={verdict}
      data-basis={advice.basis}
      aria-selected={selected}
      onClick={() => onSelect(advice)}
      sx={{
        display: 'flex',
        width: '100%',
        justifyContent: 'flex-start',
        textAlign: 'left',
        gap: 1.25,
        alignItems: 'center',
        px: 1.5,
        py: dense ? 0.5 : 0.75,
        minHeight: dense ? 36 : 52,
        borderRadius: 1.5,
        bgcolor: selected ? 'action.selected' : 'transparent',
        transition: 'background-color .14s',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
      }}
    >
      {children}
    </ButtonBase>
  )
}

function VerdictRow({
  advice,
  verdict,
  pins,
  showImages,
  selected,
  onSelect
}: {
  advice: KeepAdvice
  verdict: 'keep' | 'toss'
  pins: Pins
  showImages: boolean
  selected: boolean
  onSelect: (advice: KeepAdvice) => void
}): React.JSX.Element {
  const style = GROUP_STYLE[verdict]
  const swapped = advice.dealt - advice.kept
  return (
    <RowShell advice={advice} verdict={verdict} selected={selected} onSelect={onSelect}>
      {showImages && <RowArt advice={advice} />}
      <CostBadge cost={advice.cost} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={700} noWrap title={advice.name}>
          {advice.name}
        </Typography>
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 0.25, minWidth: 0 }}>
          {/* Copies, not matches - the handler's unit. The tooltip says so. */}
          <Tooltip
            title={`換前手牌裡有它 ${advice.dealt} 張：留下 ${advice.kept}、換掉 ${swapped}。算的是張數不是場數。`}
            placement="top"
            disableInteractive
          >
            <Typography
              variant="caption"
              noWrap
              sx={{ ...NUMERIC, color: 'text.disabled', cursor: 'help', minWidth: 0 }}
            >
              留 {advice.kept} · 換 {swapped}
            </Typography>
          </Tooltip>
          <BasisMark advice={advice} pins={pins} size="dot" />
        </Stack>
      </Box>
      <Typography
        component="span"
        data-testid="mulligan-effect"
        sx={{
          ...NUMERIC,
          fontSize: style.size,
          fontWeight: 800,
          lineHeight: 1,
          color: style.colour,
          flexShrink: 0,
          pl: 0.5
        }}
      >
        {fmtDelta(advice.diff, 0)}
      </Typography>
    </RowShell>
  )
}

/**
 * The interval, drawn, on a fixed ±30-point scale with zero in the middle.
 *
 * Only the leaning tier gets one, and that is the whole reason the tier can
 * exist. A leaning printed as a bare number (「+6」) is indistinguishable from
 * a verdict printed as a bare number, and the difference between them is
 * exactly the thing the number cannot show. Drawn, it is immediate: the bar
 * lies across the zero line, so the estimate is on one side and the evidence
 * is on both.
 *
 * The scale is fixed rather than fitted to the data so that two rows can be
 * compared by eye, and clamped rather than expanded so that one card with a
 * four-observation interval three hundred points wide does not flatten every
 * other row into a dot. A clamped end is drawn flush to the edge; the reader
 * who needs the endpoints has them in the drawer.
 *
 * ±30 because that is roughly the range a real opening-hand effect can
 * occupy before it stops being believable - the seeded fixture's planted
 * effects are 30 points and they are four to ten times anything a genuine
 * mulligan decision is worth.
 */
const WHISKER_DOMAIN = 30
const WHISKER_W = 58

function DiffWhisker({ advice }: { advice: KeepAdvice }): React.JSX.Element | null {
  const { diff, diffLo, diffHi } = advice
  if (diff === null || diffLo === null || diffHi === null) return null
  const pos = (v: number): number =>
    ((Math.max(-WHISKER_DOMAIN, Math.min(WHISKER_DOMAIN, v)) + WHISKER_DOMAIN) /
      (2 * WHISKER_DOMAIN)) *
    100
  const lo = pos(diffLo)
  const hi = pos(diffHi)
  return (
    <Box aria-hidden sx={{ position: 'relative', width: WHISKER_W, height: 14, flexShrink: 0 }}>
      {/* zero */}
      <Box
        sx={{
          position: 'absolute',
          left: '50%',
          top: 0,
          bottom: 0,
          width: '1px',
          bgcolor: 'divider'
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: `${lo}%`,
          width: `${Math.max(hi - lo, 1.5)}%`,
          height: 3,
          transform: 'translateY(-50%)',
          borderRadius: 2,
          bgcolor: 'text.disabled',
          opacity: 0.55
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: `${pos(diff)}%`,
          width: 5,
          height: 5,
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          bgcolor: diff >= 0 ? 'success.light' : 'error.light'
        }}
      />
    </Box>
  )
}

/**
 * A card the evidence leans on without settling: the estimate, its interval
 * drawn, and how far it is from earning a verdict.
 *
 * Deliberately built on the same shell and the same layout as a verdict row
 * but at the disclosure's weight - 偏留 rather than 建議留, no large coloured
 * number, the direction carried by a small word and the dot's colour. The
 * reader should be able to tell the two tiers apart at a glance while
 * scrolling, without reading either label.
 */
function LeaningRow({
  advice,
  pins,
  showImages,
  selected,
  onSelect
}: {
  advice: KeepAdvice
  pins: Pins
  showImages: boolean
  selected: boolean
  onSelect: (advice: KeepAdvice) => void
}): React.JSX.Element {
  const up = (advice.diff ?? 0) >= 0
  const gap = distanceToVerdict(advice)
  return (
    <RowShell advice={advice} verdict="unclear" selected={selected} onSelect={onSelect}>
      {showImages && <RowArt advice={advice} />}
      <CostBadge cost={advice.cost} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600} noWrap title={advice.name}>
          {advice.name}
        </Typography>
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 0.25, minWidth: 0 }}>
          <Typography
            variant="caption"
            noWrap
            sx={{ ...NUMERIC, color: 'text.disabled', minWidth: 0 }}
          >
            留 {advice.kept} · 換 {advice.dealt - advice.kept}
          </Typography>
          <BasisMark advice={advice} pins={pins} size="dot" />
        </Stack>
      </Box>
      <Tooltip
        title={`估計 ${fmtDelta(advice.diff, 0)} 點，但區間仍跨過零：往${up ? '下' : '上'}還有 ${Math.round(gap)} 點在另一側。要成為建議，整個區間都得落在同一側。`}
        placement="top"
        disableInteractive
      >
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ flexShrink: 0, pl: 0.5 }}>
          <DiffWhisker advice={advice} />
          <Typography
            component="span"
            data-testid="mulligan-leaning-effect"
            sx={{
              ...NUMERIC,
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1,
              width: 34,
              textAlign: 'right',
              color: up ? 'success.light' : 'error.light',
              opacity: 0.75
            }}
          >
            {fmtDelta(advice.diff, 0)}
          </Typography>
        </Stack>
      </Tooltip>
    </RowShell>
  )
}

/**
 * A card too thin to compare: name, and the keep rate.
 *
 * The keep rate is here because it is the only thing on this page that is not
 * an inference. It does not say the card wins; it says the player kept it,
 * which is a count, and a count is true at n=4 in a way no comparison is. It
 * also happens to be the number that reveals the problem these rows have:
 * a card kept 95% of the time has almost no swapped arm, so it will not earn
 * a verdict from this player's own games however long they keep playing, and
 * seeing 「留 95%（20 張）」 explains that better than 「樣本不足」 does.
 *
 * A thin bar rather than only the percentage, because a column of bare
 * percentages is a table again, and the bar makes 「almost always kept」 and
 * 「about half」 separable without reading.
 */
function RestRow({
  advice,
  selected,
  onSelect
}: {
  advice: KeepAdvice
  selected: boolean
  onSelect: (advice: KeepAdvice) => void
}): React.JSX.Element {
  const rate = keepRateOf(advice)
  return (
    <RowShell advice={advice} verdict="unknown" selected={selected} onSelect={onSelect} dense>
      <CostBadge cost={advice.cost} size={20} />
      <Typography
        variant="body2"
        noWrap
        title={advice.name}
        sx={{ flex: 1, minWidth: 0, color: 'text.secondary' }}
      >
        {advice.name}
      </Typography>
      {advice.dealt === 0 || rate === null ? (
        <MissingPill kind={advice.missing ?? 'unidentified'} />
      ) : (
        <Tooltip
          title={`換前手牌裡出現 ${advice.dealt} 張，留下 ${advice.kept} 張。這是你的選擇紀錄，不是勝率——這張卡兩側其中一側不到 ${KEEP_THRESHOLDS.show} 張，還不能比勝率。`}
          placement="top"
          disableInteractive
        >
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.75}
            sx={{ flexShrink: 0, cursor: 'help' }}
          >
            <Box
              aria-hidden
              sx={{
                width: 34,
                height: 3,
                borderRadius: 2,
                bgcolor: 'action.selected',
                overflow: 'hidden'
              }}
            >
              <Box sx={{ width: `${rate}%`, height: '100%', bgcolor: 'text.disabled' }} />
            </Box>
            <Typography
              variant="caption"
              noWrap
              data-testid="mulligan-keep-rate"
              sx={{ ...NUMERIC, color: 'text.disabled', width: 62, textAlign: 'right' }}
            >
              留 {fmtPct(rate, 0)} · {advice.dealt}
            </Typography>
          </Stack>
        </Tooltip>
      )}
    </RowShell>
  )
}

/* ---------------------------------------------------------------- groups */

function GroupHeading({
  verdict,
  count,
  title,
  colour,
  info
}: {
  verdict: string
  count: number
  title?: string
  colour?: string
  info?: React.ReactNode
}) {
  const style = GROUP_STYLE[verdict as 'keep' | 'toss'] as (typeof GROUP_STYLE)['keep'] | undefined
  return (
    <Stack
      direction="row"
      alignItems="baseline"
      spacing={0.75}
      data-testid={`mulligan-group-${verdict}`}
      sx={{ px: 1.5, pt: 1.5, pb: 0.5 }}
    >
      <Typography
        variant="caption"
        sx={{
          fontWeight: 800,
          letterSpacing: 0.5,
          color: colour ?? (verdict === 'keep' ? style?.colour : 'text.secondary')
        }}
      >
        {title ?? style?.title}
      </Typography>
      <Typography variant="caption" sx={{ ...NUMERIC, color: 'text.disabled' }}>
        {count} 張
      </Typography>
      {info}
    </Stack>
  )
}

/**
 * The sample-starved cards: one line, and the rows under it.
 *
 * Still a disclosure, because most of a deck lives here and thirty rows that
 * each say 「留 60%（5 張）」 is not a column anybody reads twice. But it opens
 * by default when there is nothing above it, which is the case this whole
 * redesign is about: a column with no verdicts and no leanings must still put
 * cards on screen, not a closed grey line under a paragraph.
 */
function RestLine({
  unknown,
  defaultOpen,
  selectedId,
  onSelect
}: {
  unknown: KeepAdvice[]
  /** Nothing above this line, so it is the column's content and starts open. */
  defaultOpen: boolean
  selectedId: number | null
  onSelect: (advice: KeepAdvice) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  if (unknown.length === 0) return null
  const withData = unknown.filter((a) => a.dealt > 0).length
  return (
    <Box data-testid="mulligan-rest" sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
      <ButtonBase
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        sx={{
          width: '100%',
          justifyContent: 'flex-start',
          textAlign: 'left',
          gap: 0.75,
          px: 1.5,
          py: 1.25,
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        <Typography variant="caption" sx={{ flex: 1, color: 'text.secondary', lineHeight: 1.5 }}>
          <Box component="span" sx={{ ...NUMERIC, fontWeight: 800 }}>
            {unknown.length}
          </Box>{' '}
          張還不能比勝率
          {withData > 0 && '，只看留下的比例'}
        </Typography>
        <ExpandMoreRoundedIcon
          sx={{
            fontSize: 18,
            color: 'text.disabled',
            transition: 'transform .18s',
            transform: open ? 'rotate(180deg)' : 'none'
          }}
        />
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 0.5, pb: 1 }}>
          {unknown.map((advice) => (
            <RestRow
              key={advice.cardId}
              advice={advice}
              selected={advice.cardId === selectedId}
              onSelect={onSelect}
            />
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}

/* ----------------------------------------------------------------- empty */

/**
 * One line above the list when the column has cards but nothing firm.
 *
 * What used to be here was a three-sentence block that replaced the list.
 * This replaces nothing: it sits above the leanings (or above the keep-rate
 * rows when there are not even leanings) and says, in one line, that the
 * column has no verdict yet and what the rows below it therefore are. The
 * facts the old block carried that are worth keeping - the match count - are
 * already in the column heading, and the rest was describing cards the reader
 * can now simply look at.
 */
function SoftHeader({
  result,
  pins,
  hasLeaning
}: {
  result: MulliganResult
  pins: Pins
  hasLeaning: boolean
}): React.JSX.Element {
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.75}
      data-testid="mulligan-no-verdict"
      sx={{ px: 1.5, pt: 1.5, pb: 0.25 }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
        {questionLabel(pins)}{' '}
        <Box component="span" sx={{ ...NUMERIC, fontWeight: 800, color: 'text.primary' }}>
          {result.matches}
        </Box>{' '}
        場，還沒有一張站得住的建議。
        {hasLeaning ? '以下是目前的傾向：' : '以下是你留牌的紀錄：'}
      </Typography>
      <InfoHint
        label="為什麼還沒有建議"
        title={
          <Hint>
            建議只在整個區間都落在零的同一側、而且差距超過 {KEEP_THRESHOLDS.minEffect}{' '}
            個百分點時才出現。在那之前，下面這些數字是真的，但它們和「沒有差別」還分不開——把它們當成排序，不要當成結論。多打幾場，區間會收窄。
          </Hint>
        }
      />
    </Stack>
  )
}

/** No complete hands at all, or hands but no named card. Different fixes, different sentences. */
function NoCards({ result, pins }: { result: MulliganResult; pins: Pins }): React.JSX.Element {
  const text =
    result.matches === 0
      ? `${questionLabel(pins)}還沒有讀到四張全認出的起手。只有 1.3.5 之後、看得到換牌畫面的對局才會進來${
          pins.oppo ? '；換個對手看看，或多打幾場再回來。' : '；多打幾場再回來。'
        }`
      : `${questionLabel(pins)} ${result.matches} 場讀到換牌畫面，還沒有一張卡被認出來。卡圖索引在背景建，建完會自動補上。`
  return (
    <Typography
      variant="caption"
      component="p"
      data-testid="mulligan-empty"
      sx={{ px: 2, py: 3, m: 0, color: 'text.secondary', lineHeight: 1.7, textAlign: 'center' }}
    >
      {text}
    </Typography>
  )
}

/* ---------------------------------------------------------------- column */

export default function MulliganColumn({
  order,
  pins,
  data,
  loading,
  showImages,
  selectedId,
  onSelect
}: {
  order: ColumnOrder
  pins: Pins
  data: MulliganResult | null
  loading: boolean
  showImages: boolean
  /** The card open in the drawer, if it came from this column. */
  selectedId: number | null
  onSelect: (advice: KeepAdvice) => void
}): React.JSX.Element {
  const tone = playOrders[order]
  const groups = useMemo(() => groupByVerdict(data, pins.oppo !== null), [data, pins.oppo])
  const hasVerdicts = groups.keep.length + groups.toss.length > 0

  return (
    <Paper
      elevation={0}
      data-testid={`mulligan-column-${order}`}
      sx={{
        borderRadius: 2,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        // The order's own hue, as a top rule. The two columns are identical in
        // structure; this and the heading are what keep a reader from reading
        // a 後攻 verdict as a 先攻 one after scrolling.
        borderTop: '3px solid',
        borderTopColor: tone.color
      }}
    >
      <Stack
        direction="row"
        alignItems="baseline"
        spacing={1.25}
        sx={{ px: 2, py: 1.25, bgcolor: 'action.hover' }}
      >
        <Typography
          variant="h6"
          component="h3"
          sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.2, color: tone.color }}
        >
          {tone.label}
        </Typography>
        {data === null ? (
          <Skeleton variant="text" width={120} />
        ) : (
          <Typography
            variant="caption"
            data-testid="mulligan-baseline"
            sx={{ ...NUMERIC, color: 'text.secondary', whiteSpace: 'nowrap' }}
          >
            <Box component="span" sx={{ fontWeight: 800, color: 'text.primary' }}>
              {data.matches}
            </Box>{' '}
            場{data.baseline && data.baseline.total > 0 ? ` · 勝率 ${fmtRate(data.baseline)}` : ''}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <InfoHint
          label={`${tone.label}這一欄怎麼讀`}
          size={15}
          title={
            <Hint>
              只列出整個 95%
              區間都在零同一側的卡：全在零以上是「建議留」，全在零以下是「建議換」。旁邊的數字是留下時比換掉時的勝率差（百分點，已向零收縮）；小字是留與換各幾張。點一張卡看它的區間、兩側勝率和分段。
            </Hint>
          }
        />
      </Stack>

      {data === null || (loading && data.cards.length === 0) ? (
        <Stack spacing={0.5} sx={{ p: 1.5 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} variant="rectangular" height={48} sx={{ borderRadius: 1.5 }} />
          ))}
        </Stack>
      ) : data.cards.length === 0 ? (
        <NoCards result={data} pins={pins} />
      ) : (
        <>
          {groups.keep.length > 0 && (
            <Box sx={{ pb: 0.5 }}>
              <GroupHeading verdict="keep" count={groups.keep.length} />
              <Box sx={{ px: 0.5 }}>
                {groups.keep.map((advice) => (
                  <VerdictRow
                    key={advice.cardId}
                    advice={advice}
                    verdict="keep"
                    pins={pins}
                    showImages={showImages}
                    selected={advice.cardId === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </Box>
            </Box>
          )}
          {groups.toss.length > 0 && (
            <Box sx={{ pb: 0.5 }}>
              <GroupHeading verdict="toss" count={groups.toss.length} />
              <Box sx={{ px: 0.5 }}>
                {groups.toss.map((advice) => (
                  <VerdictRow
                    key={advice.cardId}
                    advice={advice}
                    verdict="toss"
                    pins={pins}
                    showImages={showImages}
                    selected={advice.cardId === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </Box>
            </Box>
          )}
          {!hasVerdicts && (
            <SoftHeader result={data} pins={pins} hasLeaning={groups.leaning.length > 0} />
          )}
          {groups.leaning.length > 0 && (
            <Box sx={{ pb: 0.5 }}>
              {/*
                Only headed when something firmer is above it. On its own the
                SoftHeader line already says what these rows are, and two
                headings in a row for one list reads as two lists.
              */}
              {hasVerdicts && (
                <GroupHeading
                  verdict="leaning"
                  title="傾向"
                  count={groups.leaning.length}
                  info={
                    <InfoHint
                      label="「傾向」是什麼"
                      title={
                        <Hint>
                          有數字、但區間還跨過零：方向是目前資料偏的那一邊，還沒到能當建議的程度。右邊那條線畫的就是區間，中間那道是零——線跨過它，就表示「沒有差別」還在可能範圍內。
                        </Hint>
                      }
                    />
                  }
                />
              )}
              <Box sx={{ px: 0.5 }}>
                {groups.leaning.map((advice) => (
                  <LeaningRow
                    key={advice.cardId}
                    advice={advice}
                    pins={pins}
                    showImages={showImages}
                    selected={advice.cardId === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </Box>
            </Box>
          )}
          {groups.general.length > 0 && (
            <Box sx={{ pb: 0.5 }}>
              {/*
                Own heading, deliberately not 建議留. These rows have a
                direction and the direction is real; what they do not have is
                anything to do with the opponent in the column title. Filing
                them among the recommendations is how a column headed
                「對上精靈」 ends up showing five confident cards, none of which
                is about 精靈 - and the same five in every other column too.
              */}
              <Stack
                direction="row"
                alignItems="baseline"
                spacing={0.75}
                sx={{ px: 1.5, pt: 1.25, pb: 0.5 }}
              >
                <Typography sx={{ fontSize: 13, fontWeight: 700, color: 'text.secondary' }}>
                  不分對手時
                </Typography>
                <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                  {groups.general.length}
                </Typography>
                <InfoHint
                  label="說明：為什麼這些不算對這個對手的建議"
                  title={
                    <Hint>
                      這幾張{pins.oppo ? `對上${pins.oppo}` : ''}
                      的場數還不夠比，所以數字是把所有對手合起來算的：**如果這個對手跟其他對手沒兩樣**，才會是這個答案。同一批卡會出現在每一欄，數字也一樣；等這個對位的場次夠了，站得住的那些會自己移上去。
                    </Hint>
                  }
                />
              </Stack>
              {/*
                The asymmetry is worth one line. A card the pool says to KEEP is
                usually a core card that every matchup wants, so borrowing is
                mostly harmless. A card the pool says to THROW BACK is often
                situational - it looks bad averaged over seven opponents
                precisely because it is only good against one - and that one
                may be the column you are reading.
              */}
              {groups.general.some((a) => (a.diff ?? 0) < 0) && (
                <Typography
                  sx={{ px: 1.5, pb: 0.75, fontSize: 11, color: 'warning.light', lineHeight: 1.6 }}
                >
                  裡面的「換」要特別小心：一張只對某個對手有用的牌，合起來算本來就難看，
                  而那個對手可能就是這一欄。
                </Typography>
              )}
              <Box sx={{ px: 0.5, opacity: 0.85 }}>
                {groups.general.map((advice) => (
                  <VerdictRow
                    key={advice.cardId}
                    advice={advice}
                    verdict={advice.diff !== null && advice.diff >= 0 ? 'keep' : 'toss'}
                    pins={pins}
                    showImages={showImages}
                    selected={advice.cardId === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </Box>
            </Box>
          )}
          <RestLine
            unknown={groups.unknown}
            defaultOpen={!hasVerdicts && groups.leaning.length === 0}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </>
      )}
    </Paper>
  )
}
