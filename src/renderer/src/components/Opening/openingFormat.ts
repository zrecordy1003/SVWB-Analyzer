/**
 * Number formats, labels and the "why is this cell empty" vocabulary for 起手.
 *
 * Separate from the components for the same reason `cardsFormat.ts` is: the
 * table, the summary and the drawer must print the same number the same way,
 * and the components must export only components (fast refresh).
 *
 * # The one rule every helper here enforces
 *
 * A percentage never travels without its n. `fmtRate` takes the whole `Rate`
 * rather than a number, so that a call site cannot print `52.3%` and forget
 * the `(n=40)`; anyone who wants the bare number has to reach for `.rate`
 * deliberately. 17Lands prints the count beside every rate, and that is the
 * floor - a personal dataset in the dozens sits well below theirs, so this
 * page cannot afford to go under it.
 */
import type { Missing, OpeningCardStat, Rate } from '@shared/openingStats'
import { OPENING_THRESHOLDS } from '@shared/openingStats'

export const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const

/** `52.3%` - the point estimate alone. Only for places that print the n beside it themselves. */
export const fmtPct = (value: number | null, digits = 1): string =>
  value === null ? '—' : `${value.toFixed(digits)}%`

/** `52.3% (n=40)`. The default; use it unless the n is printed elsewhere on the same line. */
export const fmtRate = (rate: Rate): string => `${rate.rate.toFixed(1)}% (n=${rate.total})`

/** `38.1–66.2%` - the interval by itself, for tooltips. */
export const fmtInterval = (rate: Rate): string => `${rate.lo.toFixed(1)}–${rate.hi.toFixed(1)}%`

/** `+4.2` / `−3.1`, with a real minus sign; percentage points. */
export const fmtDelta = (delta: number | null, digits = 1): string =>
  delta === null ? '—' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(digits)}`

/** `n=7` - what stands in for a number that must not be shown. */
export const fmtN = (n: number): string => `n=${n}`

/** `1.8 張` - an average card count with one decimal. */
export const fmtCards = (value: number | null): string =>
  value === null ? '—' : `${value.toFixed(1)} 張`

/** `3.42 費` - an average cost with two decimals; one would hide most real differences. */
export const fmtCost = (value: number | null): string =>
  value === null ? '—' : `${value.toFixed(2)} 費`

/* --------------------------------------------------------------- missing */

/**
 * How each kind of absence is drawn and explained.
 *
 * Four states, four looks, and they are deliberately not four shades of grey.
 * The reactions they call for are different - shrug, import a deck, wait for
 * the recogniser, keep playing - so a user must be able to tell them apart
 * without opening a tooltip. The tooltip then says what to do.
 *
 * `tone` is a palette path, never a literal colour: the drawer, the table and
 * the demo legend all read from here and must agree in both themes.
 */
export type MissingSpec = {
  /** Short label, fits in a cell. */
  label: string
  /** One or two sentences: what happened and what, if anything, to do about it. */
  explain: string
  /** Palette path for the text/icon. */
  tone: string
  /** How the pill is drawn. */
  variant: 'solid' | 'dashed' | 'tinted' | 'plain'
}

export const MISSING_SPEC: Record<Missing, MissingSpec> = {
  'never-dealt': {
    label: '0 次',
    explain:
      '有紀錄、有牌組、也認得出手牌 - 這張卡就是一次都沒被發到。這是一個可信的零，不是資料缺口。',
    tone: 'text.primary',
    variant: 'solid'
  },
  'no-deck': {
    label: '無牌組',
    explain:
      '這些對局沒有掛上牌組，所以「牌組裡有沒有這張卡」沒有答案，發到率和對照組都算不出來。到對局列表幫這些場次掛上牌組，或用牌組代碼匯入之後再打，就會補進來。',
    tone: 'text.disabled',
    variant: 'dashed'
  },
  unidentified: {
    label: '未辨識',
    explain:
      '換牌畫面讀到了，但手牌裡有一格認不出是哪張卡，整手牌就不能算。多半是卡圖索引還沒建完 - 背景會自動重試，稍後回來看就會補上。',
    tone: 'warning.light',
    variant: 'tinted'
  },
  'low-sample': {
    label: '樣本不足',
    explain: '有資料，但還不到能印出數字的場數。這裡顯示的是目前的樣本數，再打幾場就會變成數字。',
    tone: 'text.disabled',
    variant: 'plain'
  }
}

/**
 * Which absence a given section of a row is in.
 *
 * The contract carries one `missing` per row and says it is set "when a section
 * is absent" - it does not say which section. Sections fail in a fixed order
 * (keep rate needs the least, the comparison needs the most), so the rule here
 * is: a row-level reason that explains a whole-row condition (no deck, an
 * unreadable hand) applies to every absent section; otherwise an absent section
 * is simply under its own threshold. The alternative - showing the same
 * `unidentified` pill in three columns when only the keep rate was affected -
 * would overstate the damage.
 */
export type Section = 'keep' | 'deal' | 'compare'

export function missingFor(stat: OpeningCardStat, section: Section): Missing {
  switch (section) {
    case 'keep':
      if (stat.dealt === 0) return stat.missing ?? 'never-dealt'
      return 'low-sample'
    case 'deal':
      if (stat.copies === null) return 'no-deck'
      if (stat.missing === 'unidentified' && stat.eligible === 0) return 'unidentified'
      return 'low-sample'
    case 'compare':
      if (stat.copies === null) return 'no-deck'
      if (stat.missing === 'unidentified' && stat.eligible === 0) return 'unidentified'
      if (stat.dealt === 0 && stat.missing === 'never-dealt') return 'never-dealt'
      return 'low-sample'
  }
}

/** The sample size to print in place of a number the section may not show. */
export function sampleFor(stat: OpeningCardStat, section: Section): string {
  switch (section) {
    case 'keep':
      return fmtN(stat.dealt)
    case 'deal':
      return fmtN(stat.eligible)
    case 'compare': {
      // Both arms: the smaller one is what holds the comparison back, and a
      // user who sees `n=41 / 6` knows it is the not-dealt side that is thin.
      const dealt = stat.dealtWr?.total ?? stat.dealt
      const notDealt = stat.notDealtWr?.total ?? Math.max(0, stat.eligible - stat.dealt)
      return `n=${dealt} / ${notDealt}`
    }
  }
}

/** How many more of the relevant unit until this section would show. */
export function remainingFor(stat: OpeningCardStat, section: Section): number {
  switch (section) {
    case 'keep':
      return Math.max(0, OPENING_THRESHOLDS.keepRate - stat.dealt)
    case 'deal':
      return Math.max(0, OPENING_THRESHOLDS.dealCheck - stat.eligible)
    case 'compare': {
      const dealt = stat.dealtWr?.total ?? stat.dealt
      const notDealt = stat.notDealtWr?.total ?? Math.max(0, stat.eligible - stat.dealt)
      return Math.max(0, OPENING_THRESHOLDS.wrShow - Math.min(dealt, notDealt))
    }
  }
}

/* ------------------------------------------------------------ confidence */

export const CONFIDENCE_LABEL = {
  hidden: '樣本不足，不顯示數字',
  shown: '可以看，還不能排序',
  sortable: '樣本夠，可排序'
} as const

/** Below this share of hands recognised, the row's numbers get a warning mark. */
export const lowRecognised = (stat: OpeningCardStat): boolean =>
  stat.recognisedShare !== null && stat.recognisedShare < OPENING_THRESHOLDS.recognisedShare

/**
 * The sentence `CautionMark` carries for a low recognised share.
 *
 * The field's name invites the wrong reading, so the sentence corrects it
 * first: this is not how often THIS card was recognised. It is, of the matches
 * whose deck contained this card, how many had their whole four-card hand read.
 * A perfectly readable card in a deck full of unreadable ones scores low, and
 * that is the point - the hands that went missing did not go missing at
 * random, so every number on the row is computed over a biased subset.
 */
export function recognisedCaution(share: number): string {
  return `牌組裡有這張卡的對局中，只有 ${(share * 100).toFixed(0)}% 的四張起手是完整讀到的（門檻 ${
    OPENING_THRESHOLDS.recognisedShare * 100
  }%）。這不是說這張卡難辨識，而是那些對局的手牌常常讀不全 - 沒讀到的場次不是隨機少掉的，所以這一列的每個數字都是在缺了一角的資料上算的，可能偏。`
}

export const RARITY_LABEL: Record<number, string> = { 1: '銅', 2: '銀', 3: '金', 4: '虹' }

/** Green at or above half, red below - the rule every win-rate bar in the app uses. */
export const rateTone = (rate: number, variant: 'light' | 'main'): string =>
  rate >= 50 ? `success.${variant}` : `error.${variant}`
