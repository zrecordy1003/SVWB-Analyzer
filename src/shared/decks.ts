/**
 * The deck channels' payloads and return shapes.
 *
 * These were declared inside `src/main/ipc/decks.ts` while being exactly what
 * the renderer sends and receives, which makes them part of the contract
 * rather than an implementation detail of the handlers. They moved here when
 * the deck channels went into `shared/ipc.ts`, so the arrow keeps pointing
 * from both processes into `shared/` and never from the renderer into
 * `src/main`.
 *
 * The comments came with them; several record a rule from
 * `docs/deck-versioning-plan.md` that is easy to undo by accident.
 */
import type { ClassName, Deck, GameMode } from './domain.js'
import type { DeckImportPreview } from './deckImport.js'
import type { RangeKey } from './types.js'

/**
 * The portal's language switch is a custom `Lang` REQUEST HEADER.
 *
 * Not a query parameter, not `Accept-Language`, not a cookie, not the `/cht/`
 * path prefix - all four were tried and all four return Japanese. Card names
 * and skill text are the only thing this affects, but they are the whole point.
 *
 * Here rather than in `main/data/svwbApi.ts` because `decks:importPreview`
 * takes one over IPC; that module re-exports it so its own callers are
 * unaffected.
 */
export type PortalLang = 'ja' | 'en' | 'cht' | 'chs' | 'ko'

/** The filter behind the deck-performance numbers. */
export type DeckStatsQuery = {
  deckIds?: number[]
  mode?: GameMode | 'all'
  rangeKey?: RangeKey
  start?: string | number | Date | null
  end?: string | number | Date | null
  /**
   * `'family'` (the default) sums a deck's generations together; `'deck'`
   * keeps each version apart. See `docs/deck-versioning-plan.md`.
   */
  groupBy?: 'family' | 'deck'
}

export type DeckCreateInput = {
  name: string
  class: ClassName
  categoryId?: string | null
  isDefault?: boolean
}

export type DeckUpdateInput = {
  id: number
  name?: string
  categoryId?: string | null
  // 避免語意混亂，不在 update 中改職業；若有需要另開 API。
  isDefault?: boolean
}

export type DeckImportCommitInput = {
  preview: DeckImportPreview
  name: string
  categoryId?: string | null
  isDefault?: boolean
  lang?: PortalLang
  /**
   * Set when the user answered a DUPLICATE_CONTENT by choosing to update the
   * deck they already had, instead of saving a second copy of the same 40 cards.
   */
  replaceDeckId?: number | null
}

export type DeckSaveLocalInput = {
  /** Set to edit an existing deck; omit to create one. */
  deckId?: number | null
  name: string
  classId: number
  battleFormat?: number | null
  categoryId?: string | null
  isDefault?: boolean
  cards: { cardId: number; count: number }[]
  /**
   * The escape hatch of plan rule 3.2: "correct this deck, do not create a new
   * version". A played deck normally freezes and editing it forks a new row;
   * a typo fixed the day after is not a new version, so this flag forces the
   * old in-place overwrite. Default is fork - the caller must say it out loud.
   */
  forceInPlace?: boolean
}

/**
 * A deck as the list screen wants it.
 *
 * Carries two things the Deck row does not: what the deck is made of, and the
 * banner of the card that best represents it. Both are derived here rather than
 * in the renderer, because both need the card list joined to the card cache and
 * the list screen should not be issuing a query per deck to get them.
 */
export type DeckListItem = Deck & {
  /** Banner of the deck's "face" card. See `pickHeroCard`. */
  heroBannerHash: string | null
  /** Null when the deck has no card list at all - distinct from three zeroes. */
  composition: { follower: number; spell: number; amulet: number } | null
}

export type DeckStatsRow = {
  /**
   * Under `groupBy: 'family'` (the default) this is the family's current
   * version id, so the renderer's deckId -> stat lookup keeps working
   * unchanged. Null only on the "no deck assigned" catch-all row.
   */
  deckId: number | null
  familyId: number | null
  total: number
  wins: number
  winRate: number
  /**
   * 先攻／後攻各自的成績。
   *
   * 條件寫成明確比對 `= 'first'` 與 `= 'second'` 而不是「不是先攻就是後攻」：
   * `play_order` 目前是 NOT NULL，兩者相加等於 `total`，但真要跑出第三種值時，
   * 這樣寫是少一列，而不是把它默默算成後攻。
   */
  first: { total: number; wins: number }
  second: { total: number; wins: number }
  /**
   * 這一列（家族或版本）最早與最晚一場對局的 `playedAt`（epoch ms），受同一組
   * 篩選限制。版本時間線用它畫「實際打過的期間」——一個版本的 createdAt 只說它
   * 何時被存下來，說不出它何時在打。沒有對局就是 null。
   */
  firstPlayedAt: number | null
  lastPlayedAt: number | null
}
