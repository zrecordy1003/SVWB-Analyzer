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
 * # The empty state is the common state
 *
 * At one player's sample size most matchups will recommend nothing at all,
 * and against the seeded 1200-match fixture only the main matchup produces
 * more than a handful. So the block a column shows when it has no verdicts is
 * the block the owner will see most often, and it is written to read as "not
 * yet" rather than as a failure: it names the match count, says how many
 * cards are close and in which way, and names the nearest one with what it is
 * short by. The alternative - a centred 「沒有資料」 - was rejected because it
 * is indistinguishable from a bug.
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
  armsRemaining,
  groupByVerdict,
  questionLabel,
  thinnerArmLabel,
  type ColumnOrder,
  type Pins
} from './mulliganState'
import { ART_WINDOW_RATIO, artWindowImageSx } from '@renderer/components/Common/cardArtWindow'
import { fmtDelta, fmtRate, NUMERIC } from './openingFormat'

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
 * A row inside the disclosure: name, and on the right the one fact that says
 * why it has no verdict - the straddling difference for `unclear`, the two
 * arms for `unknown`. Greyed throughout; these are the cards the column is
 * explicitly not recommending, and they must not read as a third group.
 */
function RestRow({
  advice,
  verdict,
  selected,
  onSelect
}: {
  advice: KeepAdvice
  verdict: 'unclear' | 'unknown'
  selected: boolean
  onSelect: (advice: KeepAdvice) => void
}): React.JSX.Element {
  const swapped = advice.dealt - advice.kept
  return (
    <RowShell advice={advice} verdict={verdict} selected={selected} onSelect={onSelect} dense>
      <CostBadge cost={advice.cost} size={20} />
      <Typography
        variant="body2"
        noWrap
        title={advice.name}
        sx={{ flex: 1, minWidth: 0, color: 'text.secondary' }}
      >
        {advice.name}
      </Typography>
      {advice.dealt === 0 ? (
        <MissingPill kind={advice.missing ?? 'unidentified'} />
      ) : (
        <Typography
          variant="caption"
          noWrap
          sx={{ ...NUMERIC, color: 'text.disabled', flexShrink: 0 }}
        >
          {verdict === 'unclear'
            ? `${fmtDelta(advice.diff, 0)} · 區間跨零`
            : `留 ${advice.kept} · 換 ${swapped}`}
        </Typography>
      )}
    </RowShell>
  )
}

/* ---------------------------------------------------------------- groups */

function GroupHeading({ verdict, count }: { verdict: 'keep' | 'toss'; count: number }) {
  const style = GROUP_STYLE[verdict]
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
          color: verdict === 'keep' ? style.colour : 'text.secondary'
        }}
      >
        {style.title}
      </Typography>
      <Typography variant="caption" sx={{ ...NUMERIC, color: 'text.disabled' }}>
        {count} 張
      </Typography>
    </Stack>
  )
}

/**
 * The sentence for the cards without a verdict, and the disclosure under it.
 *
 * The count of each kind is in the sentence rather than behind the
 * disclosure, because "twelve cards have a number and no direction" is
 * itself information about how far the column is from saying more. The
 * disclosure is for the reader who wants to know WHICH twelve.
 */
function RestLine({
  unclear,
  unknown,
  selectedId,
  onSelect
}: {
  unclear: KeepAdvice[]
  unknown: KeepAdvice[]
  selectedId: number | null
  onSelect: (advice: KeepAdvice) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const total = unclear.length + unknown.length
  if (total === 0) return null
  const parts = [
    unclear.length ? `${unclear.length} 張有數字但方向未定` : null,
    unknown.length ? `${unknown.length} 張樣本不足` : null
  ].filter(Boolean)
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
          另外{' '}
          <Box component="span" sx={{ ...NUMERIC, fontWeight: 800 }}>
            {total}
          </Box>{' '}
          張還不能給建議：{parts.join('、')}
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
          {unclear.map((advice) => (
            <RestRow
              key={advice.cardId}
              advice={advice}
              verdict="unclear"
              selected={advice.cardId === selectedId}
              onSelect={onSelect}
            />
          ))}
          {unknown.map((advice) => (
            <RestRow
              key={advice.cardId}
              advice={advice}
              verdict="unknown"
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
 * The block a column shows when it has cards and no verdicts.
 *
 * Three sentences at most. The first is the fact (how many matches). The
 * second is where the cards stand, in the two ways they can fall short. The
 * third names the nearest one and what it is short by - an `unclear` card by
 * its straddling estimate, an `unknown` card by how many more of its thinner
 * arm the threshold wants, in the handler's unit (copies, called 次 here
 * because that is what a player counts). Match counts are not converted from
 * copies: a 3-of shows up in ~0.3 hands per match and is kept about half the
 * time, so "4 more swaps" is around 25 more matches, and a number that rough
 * printed as a match count would be read as a promise.
 */
function NoVerdict({
  result,
  pins,
  unclear,
  unknown
}: {
  result: MulliganResult
  pins: Pins
  unclear: KeepAdvice[]
  unknown: KeepAdvice[]
}): React.JSX.Element {
  const standing = [
    unclear.length ? `${unclear.length} 張算得出差值，但區間都跨過零` : null,
    unknown.length ? `${unknown.length} 張有一側不到 ${KEEP_THRESHOLDS.show} 次` : null
  ].filter(Boolean)

  const nearestUnclear = unclear[0]
  const nearestUnknown = unknown.find((a) => a.dealt > 0)
  const nearest = nearestUnclear
    ? `最接近的是《${nearestUnclear.name}》：差 ${fmtDelta(nearestUnclear.diff, 0)}，但區間還跨過零，方向沒定。`
    : nearestUnknown
      ? `最接近的是《${nearestUnknown.name}》：${thinnerArmLabel(nearestUnknown)}那一側再 ${armsRemaining(nearestUnknown)} 次就能比。`
      : null

  return (
    <Box data-testid="mulligan-no-verdict" sx={{ px: 2, pt: 2.5, pb: 2 }}>
      <Typography variant="body2" fontWeight={800} sx={{ mb: 0.75 }}>
        還沒有可以建議的卡
      </Typography>
      <Typography
        variant="caption"
        component="p"
        sx={{ color: 'text.secondary', lineHeight: 1.7, m: 0 }}
      >
        {questionLabel(pins)}目前{' '}
        <Box component="span" sx={{ ...NUMERIC, fontWeight: 800, color: 'text.primary' }}>
          {result.matches}
        </Box>{' '}
        場。{standing.join('；')}。{nearest ? ` ${nearest}` : ''}
      </Typography>
      <Typography
        variant="caption"
        component="p"
        sx={{ color: 'text.disabled', lineHeight: 1.7, mt: 0.75, mb: 0 }}
      >
        建議只在整個區間都落在零的同一側時才出現。多打幾場，區間會收窄。
      </Typography>
    </Box>
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
            <NoVerdict
              result={data}
              pins={pins}
              unclear={groups.unclear}
              unknown={groups.unknown}
            />
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
            unclear={groups.unclear}
            unknown={groups.unknown}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </>
      )}
    </Paper>
  )
}
