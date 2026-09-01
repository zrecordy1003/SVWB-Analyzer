/**
 * The domain vocabulary, owned by this repo instead of generated.
 *
 * These used to be imported from '@prisma/client' in 24 files, which welded the
 * whole renderer's type surface to an ORM the app was shipping only for them.
 * The shapes are the same ones the SQLite schema stores and the engine's
 * protocol speaks - see `resources/migrations/001_init.sql` (the schema's single
 * source of truth) and `tools/engine/src/protocol.rs`.
 *
 * Each enum is a const object plus a union type, matching how Prisma exported
 * them, so both value uses (`GameMode.ranked`, `Object.values(ClassName)`) and
 * type uses keep working unchanged.
 */

export const ClassName = {
  elf: 'elf',
  royal: 'royal',
  witch: 'witch',
  dragon: 'dragon',
  bishop: 'bishop',
  nightmare: 'nightmare',
  nemesis: 'nemesis'
} as const
export type ClassName = (typeof ClassName)[keyof typeof ClassName]

export const PlayOrder = {
  first: 'first',
  second: 'second'
} as const
export type PlayOrder = (typeof PlayOrder)[keyof typeof PlayOrder]

/**
 * `unknown` is deliberately distinct from `unranked`: a mode the analyzer
 * failed to recognise must not be silently folded into the free-play
 * statistics. See the comment on the same enum in the engine's protocol.
 */
export const GameMode = {
  ranked: 'ranked',
  unranked: 'unranked',
  cpu: 'cpu',
  weekendPlaza: 'weekendPlaza',
  custom: 'custom',
  twoPick: 'twoPick',
  unknown: 'unknown'
} as const
export type GameMode = (typeof GameMode)[keyof typeof GameMode]

/**
 * Model shapes as the rest of the app consumes them - dates as `Date`, booleans
 * as booleans. SQLite stores epoch-millisecond integers and 0/1; the data layer
 * converts at the boundary exactly as the Prisma client used to, so nothing
 * above it can tell the ORM left.
 */

export interface Match {
  id: number
  result: boolean | null
  play_order: PlayOrder
  my_class: ClassName
  oppo_class: ClassName
  my_deckId: number | null
  oppo_deckId: number | null
  mode: GameMode | null
  bp: number | null
  mp: number | null
  delta_mp: number | null
  current_cr: number | null
  delta_cr: number | null
  durationTime: number | null
  playedAt: Date
  endedAt: Date | null
  year: number | null
  month: number | null
  day: number | null
  note: string | null
  updatedAt: Date | null
  /**
   * Where this row's values came from.
   *
   * `null` source means the row predates the provenance migration, so nothing
   * is known about it - deliberately distinct from `'engine'`, in the same way
   * `GameMode.unknown` is distinct from `unranked`. `recog_flags` and
   * `edited_fields` are JSON arrays as stored; `observed` is a JSON snapshot of
   * the engine's values from before the first user edit.
   */
  source: 'engine' | 'manual' | null
  observed: string | null
  edited_fields: string | null
  mode_confidence: 'weak' | 'strong' | 'authoritative' | null
  engine_version: string | null
  recog_flags: string | null
}

/**
 * `'local'` is reserved for decks built or edited inside this app; nothing
 * writes it yet. `null` means the deck was created by hand, the only way that
 * existed before imports - deliberately distinct from an import whose source we
 * do know, in the same way `Match.source` uses null for "unknown".
 */
export type DeckSourceKind = 'code' | 'hash' | 'local'

export interface Deck {
  id: number
  name: string
  class: string
  createdAt: Date
  updatedAt: Date | null
  isDefault: boolean
  categoryId: string | null
  /**
   * Import provenance and contents. See `resources/migrations/009_add_deck_import.sql`.
   *
   * `sourceRef` is the long deck hash and never a 4-character code: codes
   * expire three minutes after they are issued and are then handed to somebody
   * else's deck, so one is not an identifier. Duplicate detection compares
   * `fingerprint`, which is derived from the card list itself.
   *
   * The raw portal response is stored too, but stays in the data layer - see
   * `deckFromRow`.
   */
  sourceKind: DeckSourceKind | null
  sourceRef: string | null
  fingerprint: string | null
  battleFormat: number | null
  keyCardId: number | null
  importedAt: Date | null
}

export interface DeckCategory {
  id: string
  name: string
  sort: number | null
  createdAt: Date
  updatedAt: Date | null
}

export interface Tag {
  id: number
  name: string
  createdAt: Date
  updatedAt: Date | null
}

export interface MatchTag {
  matchId: number
  tagId: number
}
