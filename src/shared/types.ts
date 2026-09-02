import type { ClassName, GameMode, PlayOrder } from './domain.js'

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
