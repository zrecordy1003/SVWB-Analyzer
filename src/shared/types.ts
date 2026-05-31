import type { ClassName, GameMode, PlayOrder } from '@prisma/client'

type Stat = { wins: number; total: number; winRate: number }
type SideStats = { first: Stat; second: Stat; all: Stat }

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
}

export type RangeKey = 'today' | '7d' | '30d' | 'all' | 'custom'

export interface BattleStatus {
  inBattle: boolean
  ownClass: ClassName | null
  enemyClass: ClassName | null
  playOrder: PlayOrder | null
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
  pageIndex?: number
  pageSize?: number
}
