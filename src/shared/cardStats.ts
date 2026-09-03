/**
 * Card-level statistics (docs/deck-versioning-plan.md, stage 3; redesigned per
 * docs/card-stats-research.md).
 *
 * Shared between the `cards:stats` IPC in main and the 卡片 page that draws it,
 * so the two sides agree on the shape without a copy of it on each.
 *
 * What this is NOT: a card strength ranking. There is no draw/play event data,
 * so the only per-card number available is "the record of the decks that
 * carried it" (17Lands' GP WR). The page is therefore built as a card-axis
 * lookup - which of my decks and versions ran this card, and how did they do -
 * and every field here is named for what it measures, not what one wishes it
 * measured.
 */
import type { CardKind } from './deckImport.js'

/**
 * What the renderer sends to `cards:stats`.
 *
 * Re-exported, not redeclared. There was a hand-written `CardStatsQuery` here
 * whose own comment called it "the renderer-side contract" - a THIRD spelling
 * of the payload, and a wider one: `myClassIds?: string[]` where the channel
 * takes `ClassName[]`, `mode?: string | null` where it takes the enum. Two
 * sides each describing the same message is the thing `shared/ipc.ts` exists
 * to stop.
 */
export type { CardStatsPayload as CardStatsQuery } from './cards.js'

export type WinLoss = { total: number; wins: number }

/**
 * One deck row (= one immutable card list) that carried a card, with that
 * row's record inside the filter. This is the drill-down: a card's total is
 * the sum of these.
 */
export type CardDeckStat = {
  deckId: number
  /** `deckId` itself when the row predates migration 011 and has no family. */
  familyId: number
  name: string
  /** `v1`, `v2`… by id order within the family - never stored, always derived. */
  versionLabel: string
  /** Copies of the card in THIS version's list. */
  copies: number
  total: number
  wins: number
  /** Epoch ms; null when the version is live. */
  archivedAt: number | null
}

/**
 * One card's record across every match played with a card list that held it.
 *
 * `copies` is the average number of copies carried in those matches - a card
 * run as a 3-of in one version and a 1-of in the next reads as 2.x, which is
 * the honest answer rather than either version's count.
 */
export type CardStat = {
  cardId: number
  /** `#<cardId>` when the card master cache has no row for it. */
  name: string
  cost: number | null
  type: number | null
  kind: CardKind | null
  rarity: number | null
  atk: number | null
  life: number | null
  /** The portal's markup, verbatim; `parseCardText` renders it. */
  skillText: string | null
  imageHash: string | null
  bannerHash: string | null
  copies: number
  total: number
  wins: number
  /** Percent, two decimals, 0 when total is 0 - same convention as `decks:stats`. */
  winRate: number
  /**
   * The other side of the comparison: matches in the SAME class group whose
   * card list did NOT hold this card. Within one family that is "versions
   * without it"; across a class it is "this class's other decks".
   */
  without: WinLoss
  /** Every deck row that carried the card, most played first. */
  decks: CardDeckStat[]
}

/**
 * Everything for one `my_class`. Card lists are grouped per class (plan stage
 * 3): the fingerprint excludes the class, so an all-neutral list could in
 * theory be shared by two classes, and the same card means something else in
 * another class's deck anyway.
 */
export type CardStatsClassGroup = {
  myClass: string
  /** Covered matches in this class - the denominator behind every `without`. */
  total: number
  wins: number
  /** Distinct card lists (deck rows) those matches point at. */
  versions: number
  /** Distinct families those deck rows belong to. */
  families: number
  cards: CardStat[]
}

export type CardStatsCoverage = {
  /** Every finished match in the filter. */
  total: number
  /** Of those, the ones pointing at a deck row that has a card list. */
  covered: number
}

export type CardStatsResult = {
  coverage: CardStatsCoverage
  /** Sorted by covered match count, most first. */
  groups: CardStatsClassGroup[]
}

/** Below this many matches a card row (or a comparison group) is provisional. */
export const CARD_STATS_LOW_SAMPLE = 10
