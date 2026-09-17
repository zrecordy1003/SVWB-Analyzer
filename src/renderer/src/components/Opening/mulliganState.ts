/**
 * The 換牌建議 view's rows, sort, and - the part that matters most - the words
 * for `basis`.
 *
 * # Why the basis label is a function of the pins, not of `basis` alone
 *
 * The handler's four rungs are named after what they narrow to:
 * `'stratified'` (opponent + turn order + rest-of-hand bands combined by MH),
 * `'turn-order'` (opponent + turn order, bands pooled), `'opponent'` (turn
 * orders pooled too), `'all-opponents'` (everything pooled). Those names are
 * exact when both selectors are pinned. When nothing is pinned, three of them
 * describe the same population - "the whole filter" - and printing 「同對手」
 * on a page where no opponent was chosen would be a sentence about a class
 * that does not exist. So the label is derived from what the rung actually
 * still honours of what the user actually asked, and it says so in one of
 * three tones:
 *
 * - `'adjusted'`: the real thing. Within the pins, and the other three cards
 *   were conditioned on (by band, coarsely - never say "removed").
 * - `'pooled'`: within the pins, but the bands were pooled raw. Nothing was
 *   widened; the confounder the bands exist for was simply not handled.
 * - `'widened'`: the row stepped OUTSIDE a pin the user set, because the
 *   pinned cell was too thin. This is the one a reader must not miss: the row
 *   answers a different question than the header asks.
 *
 * The alternative - one fixed label per `basis` value - was rejected because
 * it produces the copy trap the plan warns about (「對上這個職業」 with no
 * class selected) and because it hides the only distinction a reader needs at
 * a glance: did this number honour my filter or not.
 */
import type { AdviceBasis, KeepAdvice, MulliganResult } from '@shared/openingStats'
import { KEEP_THRESHOLDS, REST_BANDS } from '@shared/openingStats'
import { classes } from '@renderer/map/classMap'
import { playOrders } from '@renderer/map/playOrder'

import type { OpeningFilters, OpeningSort } from './openingFilterState'
import { fmtN } from './openingFormat'

/* ------------------------------------------------------------------ pins */

/** What the user actually asked, as labels; `null` where nothing was pinned. */
export type Pins = {
  /** 「龍族」, or null for every opponent. */
  oppo: string | null
  /** 「先攻」, or null for both. */
  order: string | null
}

export function pinsOf(filters: Pick<OpeningFilters, 'oppoClass' | 'playOrder'>): Pins {
  return {
    oppo:
      filters.oppoClass === 'all'
        ? null
        : (classes.find((c) => c.id === filters.oppoClass)?.label ?? filters.oppoClass),
    order: filters.playOrder === 'all' ? null : playOrders[filters.playOrder].label
  }
}

/**
 * The question in words, for the header and for every sentence that needs to
 * name it: 「對上龍族・先攻」, 「對上龍族」, 「先攻」, or 「全部對局」 when
 * nothing is pinned.
 */
export function questionLabel(pins: Pins): string {
  const parts = [pins.oppo ? `對上${pins.oppo}` : null, pins.order].filter(Boolean)
  return parts.length ? parts.join('・') : '全部對局'
}

/* ----------------------------------------------------------------- basis */

export type BasisTone = 'adjusted' | 'pooled' | 'widened'

export type BasisSpec = {
  /** Fits in a pill. Never mentions a class or a turn order that was not pinned. */
  label: string
  tone: BasisTone
  /** The hover: what was compared against what, and what was NOT handled. */
  explain: string
}

/**
 * The sentence every rung shares about what conditioning on the bands does
 * and does not do. Kept as one string so the table, the drawer and the header
 * cannot drift into three different claims about the same arithmetic.
 */
export const BAND_CAVEAT =
  '「其餘三張相近」只看那三張的平均費用分成三段，抓的是「其餘手牌順才敢留」這個主要干擾；具體是哪幾張、有沒有配合，它看不到。'

export function basisSpec(basis: AdviceBasis, pins: Pins): BasisSpec {
  const within = [pins.oppo ? `對上${pins.oppo}` : null, pins.order].filter(Boolean).join('、')
  const scope = within ? `${within}的對局` : '全部對局'

  switch (basis) {
    case 'stratified':
      return {
        label: '其餘三張相近',
        tone: 'adjusted',
        explain: `留與換只在${scope}裡、而且其餘三張平均費用落在同一段的手牌之間比，三段各比完再合成一個數。${BAND_CAVEAT}`
      }
    case 'turn-order':
      // Bands pooled, both pins honoured. When nothing is pinned this rung IS
      // the whole filter, and the label has to say that rather than invent a
      // narrower comparison.
      return {
        label: within ? '同條件・未分層' : '全部合併',
        tone: 'pooled',
        explain: `留與換都在${scope}裡比，但同一段手牌裡兩邊都有的太少，所以沒有依其餘三張分層。其餘三張的影響沒有處理。`
      }
    case 'opponent':
      if (pins.order) {
        // The rung dropped the turn-order pin. That is a widening whether or
        // not an opponent is pinned.
        return {
          label: pins.oppo ? `對上${pins.oppo}・不分先後` : '不分先後',
          tone: 'widened',
          explain: `只看${pins.order}時樣本不夠，這一列把先攻和後攻合起來算${pins.oppo ? `（仍限對上${pins.oppo}）` : ''}，也沒有依其餘三張分層。它回答的比你選的問題寬。`
        }
      }
      return pins.oppo
        ? {
            label: '同條件・未分層',
            tone: 'pooled',
            explain: `留與換都在對上${pins.oppo}的對局裡比，但沒有依其餘三張分層。其餘三張的影響沒有處理。`
          }
        : {
            label: '全部合併',
            tone: 'pooled',
            explain: '全部對局合起來比，沒有依其餘三張分層。其餘三張的影響沒有處理。'
          }
    case 'all-opponents':
      if (pins.oppo || pins.order) {
        const dropped = [pins.oppo ? `對上${pins.oppo}` : null, pins.order]
          .filter(Boolean)
          .join('、')
        return {
          label: '全部對手合併',
          tone: 'widened',
          explain: `${dropped}的樣本不夠，這一列把所有對手、先攻後攻全部合起來算，也沒有分層。它回答的不是你選的問題，只是同一張卡在你所有對局裡的留換紀錄。`
        }
      }
      return {
        label: '全部合併',
        tone: 'pooled',
        explain: '全部對局合起來比，沒有依其餘三張分層。其餘三張的影響沒有處理。'
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

/* ------------------------------------------------------------------ rows */

export type MulliganRow = {
  key: string
  advice: KeepAdvice
  /** `confidence === 'sortable'`; the only rows a difference sort may rank. */
  sortable: boolean
}

export function toMulliganRows(result: MulliganResult | null): MulliganRow[] {
  if (!result) return []
  return result.cards.map((advice) => ({
    key: String(advice.cardId),
    advice,
    sortable: advice.confidence === 'sortable'
  }))
}

const byId = (a: MulliganRow, b: MulliganRow): number => a.advice.cardId - b.advice.cardId
const byDealtDesc = (a: MulliganRow, b: MulliganRow): number =>
  b.advice.dealt - a.advice.dealt || byId(a, b)

/**
 * Same rule as the 起手 table, on the advisor's rows: nulls sink, and a
 * difference sort ranks only sortable rows, the rest keeping dealt order as
 * a block beneath them.
 *
 * The handler already returns sortable rows first by `diff`. The page does
 * not keep that order by default, on purpose: `diff` is the confounded
 * column, and a table that opens ranked by it tells the reader the ranking
 * is the point. It opens by `dealt`, which is the card they see most.
 */
export function sortMulliganRows(rows: MulliganRow[], sort: OpeningSort): MulliganRow[] {
  const dir = sort.descending ? -1 : 1
  const numeric = (
    pick: (row: MulliganRow) => number | null
  ): ((a: MulliganRow, b: MulliganRow) => number) => {
    return (a, b) => {
      const av = pick(a)
      const bv = pick(b)
      if (av === null && bv === null) return byDealtDesc(a, b)
      if (av === null) return 1
      if (bv === null) return -1
      return (av - bv) * dir || byDealtDesc(a, b)
    }
  }

  switch (sort.key) {
    case 'cost':
      return [...rows].sort(
        (a, b) => ((a.advice.cost ?? 99) - (b.advice.cost ?? 99)) * dir || byDealtDesc(a, b)
      )
    case 'name':
      return [...rows].sort(
        (a, b) => a.advice.name.localeCompare(b.advice.name, 'zh-Hant') * dir || byId(a, b)
      )
    case 'keepRate':
      return [...rows].sort(numeric((r) => r.advice.keepRate?.rate ?? null))
    case 'diff': {
      const ranked = rows.filter((r) => r.sortable).sort(numeric((r) => r.advice.diff))
      const rest = rows.filter((r) => !r.sortable).sort(byDealtDesc)
      return [...ranked, ...rest]
    }
    default:
      return [...rows].sort((a, b) => (a.advice.dealt - b.advice.dealt) * dir || byId(a, b))
  }
}

/** Under a difference sort, where the unranked block starts, or -1. */
export function mulliganUnrankedBoundary(rows: MulliganRow[], sort: OpeningSort): number {
  if (sort.key !== 'diff') return -1
  const index = rows.findIndex((r) => !r.sortable)
  return index <= 0 ? -1 : index
}

/* --------------------------------------------------------------- samples */

/**
 * The two arms as the row would print them when the comparison is hidden:
 * `n=57 / 3`.
 *
 * Inside the user's own filter, not at whatever rung might have been chosen -
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
  return Math.max(0, KEEP_THRESHOLDS.show - Math.min(advice.kept, advice.dealt - advice.kept))
}

export const keepSample = (advice: KeepAdvice): string => fmtN(advice.dealt)
export const keepRemaining = (advice: KeepAdvice): number =>
  Math.max(0, KEEP_THRESHOLDS.keepRate - advice.dealt)
