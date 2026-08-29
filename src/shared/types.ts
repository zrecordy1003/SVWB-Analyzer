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
  tagIds?: number[]
  note?: 'any' | 'with' | 'without'
  crMin?: number | null
  crMax?: number | null
  /** Keyset cursor for the match list's stable playedAt/id ordering. */
  cursor?: { playedAt: string; id: number } | null
  pageIndex?: number
  pageSize?: number
}
