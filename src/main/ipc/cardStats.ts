/**
 * Card-level statistics (docs/deck-versioning-plan.md, stage 3; the shape the
 * 卡片 page wants per docs/card-stats-research.md).
 *
 * Since stage 1 a match's `my_deckId` points at a card list that never changes
 * again, so "which cards was this game played with" is a join and not a
 * reconstruction. Nothing here writes; nothing here needs a new table.
 *
 * The aggregation is done per deck row in SQL and per card in JS, on purpose.
 * A card join per match would be N x 40 rows; a deck is the unit the match
 * actually references, so one row per (class, deck) plus one card list per
 * deck is both smaller and the shape every question below wants: a card's
 * record is the sum over the decks that hold it, its drill-down is that same
 * list of decks, and the coverage line falls out of which decks turned up with
 * no card list at all.
 *
 * Grouped by `my_class` (plan stage 3): the fingerprint has no class in it, so
 * grouping on card lists alone could merge two classes' all-neutral decks, and
 * a card in another class's deck is a different question anyway.
 *
 * Separate from `decks.ts` so this stage can land beside work in that file.
 */
import { ipcMain } from 'electron'
import { sql } from 'kysely'

import type { GameMode } from '../../shared/domain.js'
import { cardKindFromType } from '../../shared/deckImport.js'
import type {
  CardDeckStat,
  CardStat,
  CardStatsClassGroup,
  CardStatsResult
} from '../../shared/cardStats.js'
import { getDb } from '../data/db/client.js'
import { filterExpressions, type QueryPayload } from './matches.js'
import { wrapRes as wrap, type Res } from '../../shared/ipc.js'

/**
 * The match list's filter payload, with two additions: `mode: 'all'` (the
 * 卡片 page has an "every mode" option the list does not) and `limit` (the
 * "most recent N matches" cap). Paging fields are meaningless for an aggregate.
 */
export type CardStatsPayload = Omit<QueryPayload, 'mode' | 'cursor' | 'pageIndex' | 'pageSize'> & {
  mode?: GameMode | 'all' | null
  /** Keep only the `limit` most recent matches that pass every other filter. */
  limit?: number | null
}

/** One deck row's identity, for the per-card drill-down. */
export type DeckMeta = {
  familyId: number
  name: string
  /** 1-based, by id within the family (plan 3.4 / V-3: derived, never stored). */
  version: number
  archivedAt: number | null
}

export type DeckRecordRow = { my_class: string; my_deckId: number; total: number; wins: number }

export type DeckCardMasterRow = {
  deckId: number
  cardId: number
  count: number
  name: string | null
  cost: number | null
  type: number | null
  rarity: number | null
  atk: number | null
  life: number | null
  skillText: string | null
  imageHash: string | null
  bannerHash: string | null
}

const pct = (wins: number, total: number): number =>
  total > 0 ? +((wins / total) * 100).toFixed(2) : 0

const normaliseLimit = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  return n >= 1 ? n : undefined
}

/**
 * Version numbers for a set of deck rows: sort every row of each family by id
 * and count. Takes ALL rows of the touched families, not just the ones in the
 * filter - v3 is v3 even when only v3 was played this week.
 */
export function deckMetaFromRows(
  rows: { id: number; familyId: number | null; name: string; archivedAt: number | null }[]
): Map<number, DeckMeta> {
  const byFamily = new Map<number, typeof rows>()
  for (const row of rows) {
    const key = row.familyId ?? row.id
    const list = byFamily.get(key)
    if (list) list.push(row)
    else byFamily.set(key, [row])
  }
  const out = new Map<number, DeckMeta>()
  for (const [familyId, members] of byFamily) {
    members
      .sort((a, b) => a.id - b.id)
      .forEach((row, index) => {
        out.set(row.id, {
          familyId,
          name: row.name,
          version: index + 1,
          archivedAt: row.archivedAt
        })
      })
  }
  return out
}

/** Pure aggregation, exported so the arithmetic is testable without a database. */
export function aggregateCardStats(
  deckRows: DeckRecordRow[],
  cardRows: DeckCardMasterRow[],
  scopeTotal: number,
  deckMeta: ReadonlyMap<number, DeckMeta> = new Map()
): CardStatsResult {
  const cardsByDeck = new Map<number, DeckCardMasterRow[]>()
  for (const row of cardRows) {
    const list = cardsByDeck.get(row.deckId)
    if (list) list.push(row)
    else cardsByDeck.set(row.deckId, [row])
  }

  type CardAcc = {
    master: DeckCardMasterRow
    total: number
    wins: number
    copiesWeighted: number
    decks: CardDeckStat[]
  }
  type GroupAcc = {
    myClass: string
    total: number
    wins: number
    decks: Set<number>
    families: Set<number>
    cards: Map<number, CardAcc>
  }

  const groups = new Map<string, GroupAcc>()
  let covered = 0

  for (const deck of deckRows) {
    const cards = cardsByDeck.get(deck.my_deckId)
    // A deck row with no card list (hand-made before imports existed, or a
    // played row whose list was never filled in) is exactly what the coverage
    // line reports: matches we know the deck NAME of but not the cards.
    if (!cards || cards.length === 0) continue

    covered += deck.total
    let group = groups.get(deck.my_class)
    if (!group) {
      group = {
        myClass: deck.my_class,
        total: 0,
        wins: 0,
        decks: new Set(),
        families: new Set(),
        cards: new Map()
      }
      groups.set(deck.my_class, group)
    }
    group.total += deck.total
    group.wins += deck.wins
    group.decks.add(deck.my_deckId)

    // A row with no meta (should not happen - every deck row is in `Deck` -
    // but the pure function must not throw) is its own one-version family.
    const meta = deckMeta.get(deck.my_deckId)
    const familyId = meta?.familyId ?? deck.my_deckId
    group.families.add(familyId)

    // Two identical card lists on two deck rows (the user changed a deck back)
    // contribute identical card rows here, so per-card sums already merge
    // "the same 40 cards" without needing the fingerprint as a key.
    for (const card of cards) {
      const deckStat: CardDeckStat = {
        deckId: deck.my_deckId,
        familyId,
        name: meta?.name ?? `#${deck.my_deckId}`,
        versionLabel: `v${meta?.version ?? 1}`,
        copies: card.count,
        total: deck.total,
        wins: deck.wins,
        archivedAt: meta?.archivedAt ?? null
      }
      const acc = group.cards.get(card.cardId)
      if (acc) {
        acc.total += deck.total
        acc.wins += deck.wins
        acc.copiesWeighted += card.count * deck.total
        acc.decks.push(deckStat)
      } else {
        group.cards.set(card.cardId, {
          master: card,
          total: deck.total,
          wins: deck.wins,
          copiesWeighted: card.count * deck.total,
          decks: [deckStat]
        })
      }
    }
  }

  const out: CardStatsClassGroup[] = [...groups.values()].map((group) => {
    const cards: CardStat[] = [...group.cards.values()]
      .map(({ master, total, wins, copiesWeighted, decks }) => ({
        cardId: master.cardId,
        name: master.name ?? `#${master.cardId}`,
        cost: master.cost ?? null,
        type: master.type ?? null,
        kind: cardKindFromType(master.type),
        rarity: master.rarity ?? null,
        atk: master.atk ?? null,
        life: master.life ?? null,
        skillText: master.skillText ?? null,
        imageHash: master.imageHash ?? null,
        bannerHash: master.bannerHash ?? null,
        copies: total > 0 ? +(copiesWeighted / total).toFixed(2) : 0,
        total,
        wins,
        winRate: pct(wins, total),
        // Every covered match in this class either held the card or did not,
        // so "without" is the complement - no second query, and the two halves
        // always add up to the group.
        without: { total: group.total - total, wins: group.wins - wins },
        decks: decks.sort((a, b) => b.total - a.total || a.deckId - b.deckId)
      }))
      .sort(
        (a, b) =>
          b.total - a.total ||
          b.winRate - a.winRate ||
          (a.cost ?? 99) - (b.cost ?? 99) ||
          a.cardId - b.cardId
      )

    return {
      myClass: group.myClass,
      total: group.total,
      wins: group.wins,
      versions: group.decks.size,
      families: group.families.size,
      cards
    }
  })
  out.sort((a, b) => b.total - a.total || a.myClass.localeCompare(b.myClass))

  return { coverage: { total: scopeTotal, covered }, groups: out }
}

export function registerCardStatsIpc(): void {
  const db = getDb()

  /**
   * Per-card record over the matches a filter selects, with the deck rows
   * behind each card.
   *
   * Takes the match list's filter payload so a deck, mode, range, tag or CR
   * condition means the same thing here as in the list and the analyzer -
   * `filterExpressions` is the one place those become SQL. `myDeckIds` expands
   * to families by default (deckScope.ts), which is what makes "this deck's
   * cards" include the versions before the current one.
   */
  ipcMain.handle(
    'cards:stats',
    async (_e, input: CardStatsPayload = {}): Promise<Res<CardStatsResult>> =>
      wrap(async () => {
        const { limit: rawLimit, mode, ...rest } = input ?? {}
        const p: QueryPayload = { ...rest, mode: mode && mode !== 'all' ? mode : null }
        const limit = normaliseLimit(rawLimit)

        // The scope is one sub-select reused by every query below, so the
        // coverage total, the per-deck records and the card lists all describe
        // the same set of matches even if the engine inserts one mid-way.
        // Unfinished matches have no result to count.
        let scope = db
          .selectFrom('Match')
          .select('id')
          .where((eb) => eb.and([...filterExpressions(eb, p), eb('result', 'is not', null)]))
        if (limit !== undefined) {
          scope = scope.orderBy('playedAt', 'desc').orderBy('id', 'desc').limit(limit)
        }

        const [scoped, perDeck] = await Promise.all([
          db
            .selectFrom('Match')
            .select(({ fn }) => fn.countAll<number>().as('total'))
            .where('id', 'in', scope)
            .executeTakeFirst(),
          db
            .selectFrom('Match')
            .select(({ fn, eb }) => [
              'my_class',
              'my_deckId',
              fn.countAll<number>().as('total'),
              eb.fn.sum<number>(eb.case().when('result', '=', 1).then(1).else(0).end()).as('wins')
            ])
            .where('id', 'in', scope)
            .where('my_deckId', 'is not', null)
            .groupBy(['my_class', 'my_deckId'])
            .execute()
        ])

        const deckIds = [...new Set(perDeck.map((r) => r.my_deckId as number))]
        const [cardRows, familyRows] = deckIds.length
          ? await Promise.all([
              // LEFT join: `Card` is a cache of the portal's data and may lack a
              // row. A card with no cached master still counts; it just reads
              // as #<id>.
              db
                .selectFrom('DeckCard')
                .leftJoin('Card', 'Card.cardId', 'DeckCard.cardId')
                .select([
                  'DeckCard.deckId',
                  'DeckCard.cardId',
                  'DeckCard.count',
                  'Card.name',
                  'Card.cost',
                  'Card.type',
                  'Card.rarity',
                  'Card.atk',
                  'Card.life',
                  'Card.skillText',
                  'Card.imageHash',
                  'Card.bannerHash'
                ])
                .where('DeckCard.deckId', 'in', deckIds)
                .execute(),
              // Every row of every touched family, so version numbers are the
              // same ones 牌組戰績 shows and not "1..n of the ones played".
              db
                .selectFrom('Deck')
                .select(['id', 'familyId', 'name', 'archivedAt'])
                .where(
                  sql<number>`coalesce("Deck"."familyId", "Deck"."id")`,
                  'in',
                  db
                    .selectFrom('Deck as Picked')
                    .select(sql<number>`coalesce("Picked"."familyId", "Picked"."id")`.as('fam'))
                    .where('Picked.id', 'in', deckIds)
                )
                .execute()
            ])
          : [[], []]

        return aggregateCardStats(
          perDeck.map((r) => ({
            my_class: String(r.my_class),
            my_deckId: r.my_deckId as number,
            total: Number(r.total),
            wins: Number(r.wins ?? 0)
          })),
          cardRows,
          Number(scoped?.total ?? 0),
          deckMetaFromRows(
            familyRows.map((r) => ({
              id: r.id,
              familyId: r.familyId,
              name: r.name,
              archivedAt: r.archivedAt == null ? null : Number(r.archivedAt)
            }))
          )
        )
      })
  )
}
