/**
 * The 換牌建議 view's pure half: which cards earn a verdict, in what order,
 * what the column says when none do, and - the part that matters most - the
 * words for `basis`.
 *
 * # What is gone from here, and why
 *
 * The first version of this file carried a sort (`sortMulliganRows`), a
 * ranked/unranked boundary and a `MulliganRow` wrapper with a `sortable` flag,
 * all copied from the 起手 table. They existed because that page was a table
 * of numbers and a table of numbers needs a sort. This page is no longer a
 * table of numbers. It gives verdicts, and a verdict's position is decided by
 * one rule (strongest first within its group) that the user cannot change, so
 * there is nothing to sort and nothing to lock. The `'sortable'` confidence
 * tier still exists in the contract and is still honoured by the drawer's
 * copy; it just no longer moves anything on screen.
 *
 * # Why the basis label is a function of the pins, not of `basis` alone
 *
 * The handler's four rungs are named after what they narrow to:
 * `'stratified'` (opponent + turn order + rest-of-hand bands combined by MH),
 * `'turn-order'` (opponent + turn order, bands pooled), `'opponent'` (turn
 * orders pooled too), `'all-opponents'` (everything pooled). Every column on
 * this page is pinned to one turn order, so two of those rungs are ALWAYS a
 * widening - the row stepped outside the column it is printed in - and the
 * label has to say so. The opponent may still be unpinned (「全部對手」), and
 * printing 「同對手」 on a page where no opponent was chosen would be a
 * sentence about a class that does not exist. So the label is derived from
 * what the rung still honours of what the column asks, in one of three tones:
 *
 * - `'adjusted'`: the real thing. Within the pins, and the other three cards
 *   were conditioned on (by band, coarsely - never say "removed").
 * - `'pooled'`: within the pins, but the bands were pooled raw. Nothing was
 *   widened; the confounder the bands exist for was simply not handled.
 * - `'widened'`: the row stepped OUTSIDE the column's pins because the pinned
 *   cell was too thin. This is the one a reader must not miss: a 建議留 in the
 *   先攻 column that was computed over both turn orders is answering a
 *   different question than the column heading asks.
 *
 * The alternative - one fixed label per `basis` value - was rejected because
 * it produces the copy trap the plan warns about (「對上這個職業」 with no
 * class selected) and because it hides the only distinction a reader needs at
 * a glance: did this verdict honour my column or not.
 */
import type { AdviceBasis, KeepAdvice, KeepVerdict, MulliganResult } from '@shared/openingStats'
import { answersTheChosenMatchup, KEEP_THRESHOLDS, REST_BANDS } from '@shared/openingStats'
import { verdictsForColumn } from '@shared/stats'
import { classes } from '@renderer/map/classMap'
import { playOrders } from '@renderer/map/playOrder'

import type { ClassChoiceId } from '../Common/filters/ClassSelect'
import { fmtN } from './openingFormat'

/* ------------------------------------------------------------------ pins */

/** The two turn orders, in the order the columns are laid out: 先攻 left. */
export type ColumnOrder = 'first' | 'second'

/** What a column actually asked, as labels; `oppo` is null when every opponent is pooled. */
export type Pins = {
  /** 「龍族」, or null for every opponent. */
  oppo: string | null
  /** 「先攻」 or 「後攻」. Every column has one; there is no pooled column any more. */
  order: string
}

export function pinsOf(oppoClass: ClassChoiceId, order: ColumnOrder): Pins {
  return {
    oppo:
      oppoClass === 'all' ? null : (classes.find((c) => c.id === oppoClass)?.label ?? oppoClass),
    order: playOrders[order].label
  }
}

/** The whole question in words, for sentences: 「先攻對上龍族」, 「先攻・全部對手」. */
export function questionLabel(pins: Pins): string {
  return pins.oppo ? `${pins.order}對上${pins.oppo}` : `${pins.order}・全部對手`
}

/* ----------------------------------------------------------------- basis */

export type BasisTone = 'adjusted' | 'pooled' | 'widened'

export type BasisSpec = {
  /** Fits in a pill. Never mentions a class that was not pinned. */
  label: string
  tone: BasisTone
  /** The hover: what was compared against what, and what was NOT handled. */
  explain: string
}

/**
 * The sentence every rung shares about what conditioning on the bands does
 * and does not do. Kept as one string so the column, the drawer and the header
 * cannot drift into three different claims about the same arithmetic.
 */
export const BAND_CAVEAT =
  '「其餘三張相近」只看那三張的平均費用分成三段，抓的是「其餘手牌順才敢留」這個主要干擾；具體是哪幾張、有沒有配合，它看不到。'

export function basisSpec(basis: AdviceBasis, pins: Pins): BasisSpec {
  const scope = pins.oppo ? `${pins.order}對上${pins.oppo}的對局` : `${pins.order}的對局`

  switch (basis) {
    case 'stratified':
      return {
        label: '其餘三張相近',
        tone: 'adjusted',
        explain: `留與換只在${scope}裡、而且其餘三張平均費用落在同一段的手牌之間比，三段各比完再合成一個數。${BAND_CAVEAT}`
      }
    case 'turn-order':
      return {
        label: '同條件・未分層',
        tone: 'pooled',
        explain: `留與換都在${scope}裡比，但同一段手牌裡兩邊都有的太少，所以沒有依其餘三張分層。其餘三張的影響沒有處理。`
      }
    case 'opponent':
      // The rung dropped the turn order - which is this column's whole
      // identity. Widened, whether or not an opponent is pinned.
      return {
        label: pins.oppo ? `對上${pins.oppo}・不分先後` : '不分先後',
        tone: 'widened',
        explain: `只看${pins.order}時樣本不夠，這一張把先攻和後攻合起來算${pins.oppo ? `（仍限對上${pins.oppo}）` : ''}，也沒有依其餘三張分層。它回答的比這一欄問的寬。`
      }
    case 'all-opponents': {
      const dropped = pins.oppo ? `${pins.order}對上${pins.oppo}` : pins.order
      return {
        label: '全部對手合併',
        tone: 'widened',
        explain: `${dropped}的樣本不夠，這一張把所有對手、先攻後攻全部合起來算，也沒有分層。它回答的不是這一欄問的問題，只是同一張卡在你所有對局裡的留換紀錄。`
      }
    }
  }
}

/* ----------------------------------------------------------------- bands */

/**
 * The three rest-of-hand bands, by index. The cut points are the handler's
 * and are not repeated here: quoting 2.5 and 4 in the renderer would be a
 * second copy of a constant that lives in `main`, and the drawer's reader
 * needs the direction (cheap / ordinary / expensive), not the boundary.
 */
export const BAND_LABEL: readonly string[] = Array.from({ length: REST_BANDS }, (_, i) =>
  i === 0 ? '其餘三張偏低費' : i === REST_BANDS - 1 ? '其餘三張偏高費' : '其餘三張一般'
)

/* -------------------------------------------------------------- verdicts */

/**
 * One column's cards, sorted into what the column says about them.
 *
 * `keep` and `toss` are the two groups that get a card row each, strongest
 * effect first. `unclear` and `unknown` are summarised in one line and are
 * kept as lists only so that line can be opened; their order is by how close
 * they are to earning a verdict (see `byNearest`), because a reader who opens
 * that line is asking "which of these is nearest to telling me something".
 */
export type VerdictGroups = {
  keep: KeepAdvice[]
  toss: KeepAdvice[]
  /**
   * Rows with a direction whose evidence pooled the chosen opponent away.
   *
   * They are real advice about the player's deck in general and they are NOT
   * advice about this matchup, so they get their own heading rather than
   * sitting among the recommendations under a column titled 「對上精靈」.
   * Empty whenever no opponent is chosen, because then there is nothing the
   * pooling took away. See `answersTheChosenMatchup`.
   */
  general: KeepAdvice[]
  unclear: KeepAdvice[]
  unknown: KeepAdvice[]
}

const byId = (a: KeepAdvice, b: KeepAdvice): number => a.cardId - b.cardId

/**
 * Strongest first, by the shrunk `diff`. Absolute value, so the toss group
 * reads with its biggest loss on top just as the keep group reads with its
 * biggest gain. The shrunk value rather than the interval's near edge: the
 * near edge is what earned the verdict, but it is a floor, and ranking on a
 * floor puts the card with the most data on top rather than the card with the
 * largest effect. Ties fall back to the thinner arm, larger first.
 */
const byStrength = (a: KeepAdvice, b: KeepAdvice): number =>
  Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0) || thinnerArm(b) - thinnerArm(a) || byId(a, b)

/** The smaller of the two arms - the one that decides whether anything can be said. */
export const thinnerArm = (advice: KeepAdvice): number =>
  Math.min(advice.kept, advice.dealt - advice.kept)

/**
 * Nearest-to-a-verdict first. For an `unclear` card the interval's distance
 * to zero is what stands between it and a verdict; for an `unknown` card it is
 * how many more of the thinner arm the threshold wants. Neither is comparable
 * to the other, so the two lists are sorted separately and concatenated with
 * `unclear` ahead: it has more data by definition.
 */
const byNearest = (a: KeepAdvice, b: KeepAdvice): number =>
  distanceToVerdict(a) - distanceToVerdict(b) || b.dealt - a.dealt || byId(a, b)

/** How far an `unclear` interval reaches past zero on its wrong side, in points. */
function distanceToVerdict(advice: KeepAdvice): number {
  if (advice.diffLo === null || advice.diffHi === null) return Number.POSITIVE_INFINITY
  // The interval straddles zero; the smaller overhang is the side it would
  // need to pull back to become a verdict.
  return Math.min(-advice.diffLo, advice.diffHi)
}

export function groupByVerdict(
  result: MulliganResult | null,
  /** Whether the reader actually chose an opponent, or is looking at all of them. */
  oppoPinned: boolean
): VerdictGroups {
  const groups: VerdictGroups = { keep: [], toss: [], general: [], unclear: [], unknown: [] }
  if (!result) return groups
  // One pass over the whole column, not a judgement per card: the verdicts are
  // Benjamini-Hochberg corrected against each other, so a card's answer depends
  // on how many other cards were examined beside it. See `verdictsForColumn`.
  const verdicts = verdictsForColumn(result.cards)
  for (const advice of result.cards) {
    const verdict = verdicts.get(advice.cardId) ?? 'unknown'
    // A direction is only filed as advice about THIS matchup when the evidence
    // still concerns it. Otherwise it is true and it is about something else.
    const misattributed =
      (verdict === 'keep' || verdict === 'toss') &&
      !answersTheChosenMatchup(advice.basis, oppoPinned)
    groups[misattributed ? 'general' : verdict].push(advice)
  }
  groups.keep.sort(byStrength)
  groups.toss.sort(byStrength)
  groups.general.sort(byStrength)
  groups.unclear.sort(byNearest)
  groups.unknown.sort(
    (a, b) => armsRemaining(a) - armsRemaining(b) || b.dealt - a.dealt || byId(a, b)
  )
  return groups
}

/** The words for each verdict, where a card row needs to name its group. */
export const VERDICT_LABEL: Record<KeepVerdict, string> = {
  keep: '建議留',
  toss: '建議換',
  unclear: '方向未定',
  unknown: '樣本不足'
}

/* --------------------------------------------------------------- samples */

/**
 * The two arms as the drawer prints them when the comparison is hidden:
 * `n=57 / 3`.
 *
 * Inside the column's own pins, not at whatever rung might have been chosen -
 * when the comparison is hidden no rung was chosen, and these two counts are
 * the ones the reader can check against `dealt` and the keep rate. A card kept
 * 95% of the time shows `n=57 / 3` here, and that 3 is the whole story: the
 * control arm is nearly empty, which is what the plan's 四 says the keep rate
 * is there to reveal.
 */
export function armsSample(advice: KeepAdvice): string {
  return `n=${advice.kept} / ${advice.dealt - advice.kept}`
}

/** How many more of the thinner arm until the comparison shows. */
export function armsRemaining(advice: KeepAdvice): number {
  return Math.max(0, KEEP_THRESHOLDS.show - thinnerArm(advice))
}

/** Which arm is the thin one, in the words the empty state uses: 「留下」 or 「換掉」. */
export function thinnerArmLabel(advice: KeepAdvice): string {
  return advice.kept <= advice.dealt - advice.kept ? '留下' : '換掉'
}

export const keepSample = (advice: KeepAdvice): string => fmtN(advice.dealt)
export const keepRemaining = (advice: KeepAdvice): number =>
  Math.max(0, KEEP_THRESHOLDS.keepRate - advice.dealt)
