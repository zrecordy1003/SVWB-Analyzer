import { Deck, Match } from '@shared/domain'

export type MatchTagLite = { id: number; name: string }

export type MatchRow = Match & {
  my_deck?: Pick<Deck, 'id' | 'name'> | null
  oppo_deck?: Pick<Deck, 'id' | 'name'> | null
  tags: MatchTagLite[]
  tagCount: number
}
