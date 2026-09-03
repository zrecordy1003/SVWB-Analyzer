import type { ClassName, Deck, GameMode, Match, PlayOrder, Tag } from './domain.js'

export type Stat = { wins: number; total: number; winRate: number }
export type SideStats = { first: Stat; second: Stat; all: Stat }

export type RankedWinrateByOpponent = {
  myClass: ClassName
  start: number | null
  end: number | null
  byOpponent: Record<string, SideStats>
  overall: SideStats
  myDecks?: { id: number; name: string }[]
  tags?: { id: number; name: string }[]
  crMin: number | null
  crMax: number | null
  /** The "most recent N matches" cap that was applied, or null for no cap. */
  limit: number | null
}

export type RangeKey = 'today' | '7d' | '30d' | 'all' | 'custom'

/**
 * Whether the game is there at all, broadcast on the detection poll so any
 * window can distinguish "not detected" from "detected but nothing recorded".
 */
export interface GameStatus {
  running: boolean
  /** Running but minimised or without bounds, so capture is suspended. */
  paused: boolean
  capturing: boolean
}

export interface BattleStatus {
  inBattle: boolean
  ownClass: ClassName | null
  enemyClass: ClassName | null
  playOrder: PlayOrder | null
  /**
   * The mode of the battle in progress, as soon as anything knows it.
   *
   * `null` is a real state, not a gap. A ranked match carries no mode evidence
   * until its result screen, so it stays null for the whole battle; 2Pick and
   * CPU are labelled before the first card is played and arrive here at once.
   * The HUD treats null as "fall back to the last recorded match" rather than
   * as "no mode".
   */
  mode: GameMode | null
}

/**
 * A match with its relations, as the detail and edit handlers answer.
 *
 * The nested `tags` shape - a pivot row carrying the tag - is what Prisma's
 * `include: { tags: { include: { tag } } }` produced, and the renderer's edit
 * dialog reads `tags[].tag`. It is therefore part of the contract rather than
 * a detail of how the query used to be written, which is why it is declared
 * here and pinned by `tests/main/ipcSmoke.test.ts`.
 */
export type MatchDetail = Match & {
  my_deck: Deck | null
  oppo_deck: Deck | null
  tags: { matchId: number; tagId: number; tag: Tag }[]
}

/** One row of the match list: relations loaded, tags flattened to what the card draws. */
export type MatchListRow = Match & {
  my_deck: Deck | null
  oppo_deck: Deck | null
  tags: { id: number; name: string }[]
  /** Kept alongside `tags` because a card shows a count without rendering them all. */
  tagCount: number
}

/** Keyset cursor for the match list's stable `(playedAt, id)` ordering. */
export type MatchCursor = { playedAt: string; id: number }

/**
 * One page of the match list.
 *
 * `total` is null on a cursor fetch: counting the whole filtered set again for
 * every scroll would be the expensive half of a query whose answer has not
 * changed since the first page.
 */
export type MatchListPage = {
  rows: MatchListRow[]
  total: number | null
  hasMore: boolean
  nextCursor: MatchCursor | null
}

/** The two fields the match card loads on demand rather than with the page. */
export type MatchExtras = {
  note: string | null
  tags: { id: number; name: string }[]
}

/**
 * What the edit dialog sends to `matches:updateWithExtras`.
 *
 * Declared here rather than left as an untyped payload because of what the
 * handler does and does not do: it checks each field for PRESENCE
 * (`typeof x !== 'undefined'`) and then writes it straight into the column.
 * It does not check the type. That was invisible while the payload was an
 * implicit `any` - a string could reach an INTEGER column and only SQLite
 * would object - and it is why this type is currently the only thing checking
 * these values at all.
 *
 * `matches:create` is deliberately NOT typed this way: it validates properly
 * (`asClass`, `Number.isFinite`, the deckless-mode clearing) and takes
 * `Record<string, unknown>` because that is honestly what it accepts.
 *
 * Everything is optional but `id`: the dialog sends only what changed.
 */
export type MatchEditInput = {
  id: number
  /**
   * The `updatedAt` the dialog was opened with, for the optimistic lock. A
   * `Date` over IPC arrives as one; a string is accepted because older call
   * sites sent ISO text.
   */
  prevUpdatedAt?: string | number | Date | null
  tagIds?: number[]
  result?: boolean | null
  play_order?: PlayOrder
  my_class?: ClassName
  oppo_class?: ClassName
  mode?: GameMode | null
  bp?: number | null
  durationTime?: number | null
  my_deckId?: number | null
  oppo_deckId?: number | null
  note?: string | null
  playedAt?: string | number | Date | null
  current_cr?: number | null
  delta_cr?: number | null
}

/**
 * The filter behind the ranked win-rate chart.
 *
 * Lives here because it crosses the boundary, and it is one declaration rather
 * than two for a reason: it was restated by hand while adding the IPC
 * contract, and the copy was wrong in four places - `gameMode` optional rather
 * than required, `start`/`end` non-nullable, `crMin`/`crMax` plain numbers,
 * `myDeckScope` missing entirely. The compiler caught every one, which is a
 * fair summary of why the contract is worth having.
 */
export type RankedWinrateQuery = {
  myClass: ClassName
  /** `'all'` drops the mode filter entirely; omitted still means ranked. */
  gameMode?: GameMode | 'all'
  rangeKey?: RangeKey
  start?: Date | number | string
  end?: Date | number | string
  myDeckIds?: number[]
  /** Default `'family'`: a picked deck stands for every version of it. */
  myDeckScope?: 'family' | 'deck'
  tagIds?: number[]
  crMin?: number
  crMax?: number
  /** Keep only the `limit` most recent matches that pass every other filter. */
  limit?: number
}

export type QueryPayload = {
  myClassIds?: ClassName[]
  oppoClassIds?: ClassName[]
  mode?: GameMode | null
  rangeKey?: RangeKey
  start?: string | number | Date | null
  end?: string | number | Date | null
  myDeckIds?: number[]
  /**
   * How `myDeckIds` is read. `'family'` (the default) expands each id to every
   * version of that deck; `'deck'` matches exactly those rows. See
   * `main/ipc/deckScope.ts`.
   */
  myDeckScope?: 'family' | 'deck'
  tagIds?: number[]
  note?: 'any' | 'with' | 'without'
  crMin?: number | null
  crMax?: number | null
  /** Keyset cursor for the match list's stable playedAt/id ordering. */
  cursor?: { playedAt: string; id: number } | null
  pageIndex?: number
  pageSize?: number
}

/**
 * What the provenance columns add up to, as the settings page reads them.
 *
 * The counting lives in `main/data/provenanceStats.ts`; the shape lives here
 * because both processes speak it - same reason `RankedWinrateByOpponent` does.
 */
export type FlagBreakdown = {
  /** Distinct matches carrying this flag. */
  matches: number
  /** Of those, how many had an observed column corrected by hand. */
  corrected: number
}

export type ProvenanceTransition = {
  field: string
  from: string
  to: string
  count: number
}

export type ProvenanceStats = {
  total: number
  /** `unknown` is pre-provenance: rows whose origin nobody can establish. */
  bySource: { engine: number; manual: number; unknown: number }
  /** Matches with any edit at all, including ones no statistic reads. */
  editedMatches: number
  /** Matches where an observed column was overwritten by hand. */
  correctedMatches: number
  /** Edit count per field name, including `note` / `tags` / deck columns. */
  editedByField: Record<string, number>
  flagged: Record<string, FlagBreakdown>
  /** The comparison group: engine-written matches carrying no flag. */
  unflagged: FlagBreakdown
  /** Engine value -> corrected value, for categorical columns only. */
  transitions: ProvenanceTransition[]
}
