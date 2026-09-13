/**
 * 起手 — the opening-hand statistics channel (`docs/opening-hand-plan.md`,
 * 階段 4).
 *
 * The contract, and the reason this is not a second tab on `cards:stats`, live
 * in `shared/openingStats.ts`. What belongs here is how the numbers are got out
 * of the database without the query cost growing with the card list.
 *
 * # Shape of the work
 *
 * `MatchOpeningCard` is eight rows per match and nothing prunes it, so it is
 * the one table here that grows without bound. Every query below therefore
 * collapses it to a cardinality that does not depend on how many matches there
 * are - one row per (card, deck version), one row per (stage, cost bucket) -
 * except one, which returns a row per match. That one is deliberate: the
 * summary needs per-match facts (was the hand complete, how many were swapped,
 * which deck, which turn order) that cannot be re-derived from any coarser
 * grouping, and a match row is an eighth of a hand row. The thing this file is
 * careful never to do is the shape `cardStats.ts` argues against: a query per
 * card. There are as many queries below as there are questions, and no more.
 *
 * # Completeness is derived, never stored
 *
 * `014_`'s comment offered a `Match.openingRecognized` column or a derivation
 * and said to pick one. The derivation wins, and only because of `017_`:
 * `Command::RetryUnnamedCards` fills a `cardId` in long after the match ended,
 * so a match's completeness changes after the fact. A stored flag would be
 * wrong from that moment and nothing in the app would ever notice. So every
 * completeness test in this file is a `GROUP BY matchId ... HAVING`, computed
 * fresh on each call. `tests/main/openingStats.test.ts` pins this by naming a
 * NULL card and re-running the same query.
 *
 * # Unfinished matches
 *
 * Excluded, with `result IS NOT NULL`, the same way `cardStats.ts` excludes
 * them: half of this page is win rates, and a match still being played has no
 * result to put in either arm. It costs the curve a handful of hands and buys
 * one match set that every number on the page shares.
 */
import { sql, type SqlBool } from 'kysely'

import { CLASS_ID_TO_NAME } from '../../shared/deckImport.js'
import {
  CURVE_MAX_COST,
  OPENING_THRESHOLDS,
  type Confidence,
  type CurvePoint,
  type Missing,
  type OpeningCardStat,
  type OpeningStatsPayload,
  type OpeningStatsResult,
  type OpeningSummary,
  type Rate,
  type SwapBand
} from '../../shared/openingStats.js'
import {
  binomialTwoSided,
  confidenceFor,
  hypergeometricAtLeastOne,
  mean,
  newcombeDiff,
  rate,
  shrink
} from '../../shared/stats.js'
import { getDb } from '../data/db/client.js'
import { filterExpressions, type QueryPayload } from './matches.js'
import { handleIpc } from './typed.js'
import { wrapRes as wrap, type Res } from '../../shared/ipc.js'

export type { OpeningStatsPayload } from '../../shared/openingStats.js'

/** The portal's class id for cards every class may run. Mirrors `cardIndex.ts`. */
const NEUTRAL_CLASS_ID = 0

/** Same coercion `cardStats.ts` applies, so "most recent N" means one thing. */
const normaliseLimit = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  return n >= 1 ? n : undefined
}

const num = (v: unknown): number => Number(v ?? 0)

/** One match, as the summary needs it. Flags derived, never read from a column. */
type MatchFacts = {
  id: number
  deckId: number | null
  playOrder: string
  won: boolean
  preComplete: boolean
  /** All four pre slots were READ, named or not - which is all a swap count needs. */
  swapKnown: boolean
  complete: boolean
  swaps: number
  pending: number
}

/** A deck version's contribution to one arm of the dealt/not-dealt comparison. */
type DeckSlice = {
  /** Matches of this deck version with a complete pre hand, and their wins. */
  eligible: number
  eligibleWins: number
  /** Matches with this deck version at all - the recognised-share denominator. */
  seen: number
  /** Of `seen`, how many had all four pre slots named. */
  seenPreComplete: number
}

type CardAcc = {
  cardId: number
  dealt: number
  kept: number
}

const emptySummary = (): OpeningSummary => ({
  matches: 0,
  preComplete: 0,
  complete: 0,
  withDeck: 0,
  pendingRetry: 0,
  avgSwapped: null,
  swapBands: [],
  swapByPlayOrder: { first: [], second: [] },
  curve: [],
  avgCostPre: null,
  avgCostPost: null
})

/**
 * Swap bands over a set of matches.
 *
 * Only bands that actually happened are emitted. A stable 0..4 axis was the
 * other option and it is the wrong one here: a band with `total: 0` and
 * `rate: 0` is indistinguishable from a band the user went 0-for-n in unless
 * the reader checks `total` first, and this page has enough numbers that need
 * their denominator read first already.
 */
function swapBands(matches: MatchFacts[]): SwapBand[] {
  const bands = new Map<number, { total: number; wins: number }>()
  for (const m of matches) {
    const band = bands.get(m.swaps) ?? { total: 0, wins: 0 }
    band.total += 1
    if (m.won) band.wins += 1
    bands.set(m.swaps, band)
  }
  return [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([swapped, { total, wins }]) => ({
      swapped,
      total,
      wins,
      rate: total > 0 ? +((wins / total) * 100).toFixed(2) : 0
    }))
}

export function registerOpeningStatsIpc(): void {
  const db = getDb()

  /**
   * Everything the 起手 page shows, for the match set a filter selects.
   *
   * Takes the match list's filter payload for the same reason `cards:stats`
   * does: a deck, mode, range, tag or CR condition has to mean the same thing
   * on every page, and `filterExpressions` is the one place those become SQL.
   */
  handleIpc(
    'cards:openingStats',
    async (_e, input: OpeningStatsPayload = {}): Promise<Res<OpeningStatsResult>> =>
      wrap(async () => {
        const { limit: rawLimit, mode, ...rest } = input ?? {}
        const p: QueryPayload = { ...rest, mode: mode && mode !== 'all' ? mode : null }
        const limit = normaliseLimit(rawLimit)

        // One sub-select, reused by every query below, so the summary, the
        // curve and the per-card rows all describe the same matches even if
        // the engine inserts one between two of them.
        let scope = db
          .selectFrom('Match')
          .select('id')
          .where((eb) => eb.and([...filterExpressions(eb, p), eb('result', 'is not', null)]))
        if (limit !== undefined) {
          scope = scope.orderBy('playedAt', 'desc').orderBy('id', 'desc').limit(limit)
        }

        // Matches whose four pre-mulligan slots are all named. The card-level
        // deal-rate and win-rate numbers hang off this: a hand read as three
        // cards is not a noisier observation of "was c dealt", it is a wrong
        // one, because the missing slot could have been c.
        const preCompleteScope = db
          .selectFrom('MatchOpeningCard as pc')
          .select('pc.matchId')
          .where('pc.matchId', 'in', scope)
          .where('pc.stage', '=', 'pre')
          .groupBy('pc.matchId')
          .having(sql<SqlBool>`count(*) = 4 and count("pc"."cardId") = 4`)

        // Matches fit to draw a curve from: all eight slots named AND every one
        // of them found in the card cache. The second half is not pedantry -
        // `Card` is a cache of the portal's data and can be missing a row, and
        // a hand where one card has no known cost would silently contribute a
        // three-card curve. Strictly narrower than `complete` in the summary,
        // which is why the two are counted separately rather than shared.
        const curveScope = db
          .selectFrom('MatchOpeningCard as cc')
          .leftJoin('Card as ccc', 'ccc.cardId', 'cc.cardId')
          .select('cc.matchId')
          .where('cc.matchId', 'in', scope)
          .groupBy('cc.matchId')
          .having(
            sql<SqlBool>`count(*) = 8 and count("cc"."cardId") = 8 and count("ccc"."cost") = 8`
          )

        // (1) One row per match with any opening row at all. The GROUP BY is in
        // SQL, so eight hand rows arrive as one; the flags below are the
        // derivation the header promises.
        const matchRows = await db
          .selectFrom('Match as m')
          .innerJoin('MatchOpeningCard as o', 'o.matchId', 'm.id')
          .select(({ fn }) => [
            'm.id as id',
            'm.my_deckId as deckId',
            'm.play_order as playOrder',
            'm.result as result',
            fn.countAll<number>().as('slots'),
            sql<number>`sum(case when "o"."stage" = 'pre' then 1 else 0 end)`.as('preSlots'),
            sql<number>`sum(case when "o"."stage" = 'pre' and "o"."cardId" is not null then 1 else 0 end)`.as(
              'preNamed'
            ),
            sql<number>`sum(case when "o"."cardId" is not null then 1 else 0 end)`.as('named'),
            sql<number>`sum(case when "o"."stage" = 'pre' and "o"."swapped" = 1 then 1 else 0 end)`.as(
              'swaps'
            ),
            sql<number>`sum(case when "o"."cardId" is null and "o"."artVector" is not null then 1 else 0 end)`.as(
              'pending'
            )
          ])
          .where('m.id', 'in', scope)
          .groupBy('m.id')
          .execute()

        if (matchRows.length === 0) return { summary: emptySummary(), cards: [] }

        const facts: MatchFacts[] = matchRows.map((r) => ({
          id: Number(r.id),
          deckId: r.deckId == null ? null : Number(r.deckId),
          playOrder: String(r.playOrder),
          won: Number(r.result) === 1,
          preComplete: num(r.preSlots) === 4 && num(r.preNamed) === 4,
          swapKnown: num(r.preSlots) === 4,
          complete: num(r.slots) === 8 && num(r.named) === 8,
          swaps: num(r.swaps),
          pending: num(r.pending)
        }))

        const preCompleteMatches = facts.filter((f) => f.preComplete)
        const completeCount = facts.filter((f) => f.complete).length
        const deckIds = [
          ...new Set(facts.map((f) => f.deckId).filter((d): d is number => d != null))
        ]

        // Per deck version: both denominators this page needs. `eligible` is
        // the complete-pre one the deal rate and the win-rate arms use;
        // `seen` is every match of that version, which is what makes
        // `recognisedShare` a share of something the user can see.
        const slices = new Map<number, DeckSlice>()
        for (const f of facts) {
          if (f.deckId == null) continue
          const slice = slices.get(f.deckId) ?? {
            eligible: 0,
            eligibleWins: 0,
            seen: 0,
            seenPreComplete: 0
          }
          slice.seen += 1
          if (f.preComplete) {
            slice.seenPreComplete += 1
            slice.eligible += 1
            if (f.won) slice.eligibleWins += 1
          }
          slices.set(f.deckId, slice)
        }

        // (2) Per card, over every match in scope regardless of completeness:
        // how often it was dealt and how often it survived. The inner GROUP BY
        // is what makes `dealt` a count of MATCHES - two copies of the same
        // card in one hand are two rows and one observation, and the obvious
        // `pre LEFT JOIN post` shape counts that pair four times.
        const handPresence = db
          .selectFrom('MatchOpeningCard as h')
          .select([
            'h.cardId as cardId',
            'h.matchId as matchId',
            sql<number>`max(case when "h"."stage" = 'pre' then 1 else 0 end)`.as('inPre'),
            sql<number>`max(case when "h"."stage" = 'post' then 1 else 0 end)`.as('inPost')
          ])
          .where('h.matchId', 'in', scope)
          .where('h.cardId', 'is not', null)
          .groupBy(['h.cardId', 'h.matchId'])

        // (3) Per (card, deck version), the dealt arm. Aggregated to deck
        // versions and not to matches because the arms must not be pooled
        // across versions: a 3-of that became a 2-of has two different deal
        // rates, and a sum over versions with different copy counts compares
        // a card against a mixture of decks rather than against itself.
        const dealtPerDeck = db
          .selectFrom('MatchOpeningCard as d')
          .select(['d.matchId as matchId', 'd.cardId as cardId'])
          .where('d.stage', '=', 'pre')
          .where('d.cardId', 'is not', null)
          .where('d.matchId', 'in', preCompleteScope)
          .groupBy(['d.matchId', 'd.cardId'])

        const [dealtKeptRows, dealtDeckRows, curveRows, curveMatchRow] = await Promise.all([
          db
            .selectFrom(handPresence.as('x'))
            .select(({ fn }) => [
              'x.cardId as cardId',
              fn.countAll<number>().as('dealt'),
              sql<number>`sum("x"."inPost")`.as('kept')
            ])
            .where('x.inPre', '=', 1)
            .groupBy('x.cardId')
            .execute(),
          db
            .selectFrom(dealtPerDeck.as('dp'))
            .innerJoin('Match as dm', 'dm.id', 'dp.matchId')
            .select(({ fn }) => [
              'dp.cardId as cardId',
              'dm.my_deckId as deckId',
              fn.countAll<number>().as('dealt'),
              sql<number>`sum(case when "dm"."result" = 1 then 1 else 0 end)`.as('wins')
            ])
            .where('dm.my_deckId', 'is not', null)
            .groupBy(['dp.cardId', 'dm.my_deckId'])
            .execute(),
          // At most two stages times eight buckets, whatever the match count.
          db
            .selectFrom('MatchOpeningCard as cu')
            .innerJoin('Card as cuc', 'cuc.cardId', 'cu.cardId')
            .select(({ fn }) => [
              'cu.stage as stage',
              sql<number>`min("cuc"."cost", ${CURVE_MAX_COST})`.as('bucket'),
              fn.countAll<number>().as('n'),
              sql<number>`sum("cuc"."cost")`.as('costSum')
            ])
            .where('cu.matchId', 'in', curveScope)
            .groupBy(['cu.stage', sql`min("cuc"."cost", ${CURVE_MAX_COST})`])
            .execute(),
          db
            .selectFrom(curveScope.as('cs'))
            .select(({ fn }) => fn.countAll<number>().as('n'))
            .executeTakeFirst()
        ])

        // (4) The deck lists, one query for every deck in range. This is the
        // only place "is card c in the deck" is answered, and it is answered
        // for every card at once.
        const deckCardRows = deckIds.length
          ? await db
              .selectFrom('DeckCard')
              .select(['deckId', 'cardId', 'count'])
              .where('deckId', 'in', deckIds)
              .execute()
          : []

        // ------------------------------------------------------------ summary

        const curveMatches = num(curveMatchRow?.n)
        const drawCurve = completeCount >= OPENING_THRESHOLDS.curve && curveMatches > 0

        let curve: CurvePoint[] = []
        let avgCostPre: number | null = null
        let avgCostPost: number | null = null
        if (drawCurve) {
          const per = new Map<number, { pre: number; post: number }>()
          let preCards = 0
          let postCards = 0
          let preCost = 0
          let postCost = 0
          for (const row of curveRows) {
            const bucket = Math.max(0, Math.min(CURVE_MAX_COST, num(row.bucket)))
            const point = per.get(bucket) ?? { pre: 0, post: 0 }
            if (String(row.stage) === 'pre') {
              point.pre += num(row.n)
              preCards += num(row.n)
              preCost += num(row.costSum)
            } else {
              point.post += num(row.n)
              postCards += num(row.n)
              postCost += num(row.costSum)
            }
            per.set(bucket, point)
          }
          curve = []
          for (let cost = 0; cost <= CURVE_MAX_COST; cost++) {
            const point = per.get(cost) ?? { pre: 0, post: 0 }
            curve.push({
              cost,
              pre: +(point.pre / curveMatches).toFixed(3),
              post: +(point.post / curveMatches).toFixed(3)
            })
          }
          avgCostPre = preCards > 0 ? +(preCost / preCards).toFixed(2) : null
          avgCostPost = postCards > 0 ? +(postCost / postCards).toFixed(2) : null
        }

        // How many cards were swapped is read off the panel's geometry, not off
        // any card's name, so it is known for every hand the engine saw - including
        // hands where nothing could be identified. Counting only fully-named hands
        // would put selection into the one measurement that had none, and the bias
        // would not be small or random: a hand full of alternate illustrations is
        // exactly the hand that fails to be named, and there is no reason to think
        // such hands get mulliganed like any other.
        const swapKnownMatches = facts.filter((f) => f.swapKnown)
        const avgSwappedRaw = mean(swapKnownMatches.map((f) => f.swaps))
        const summary: OpeningSummary = {
          matches: facts.length,
          preComplete: preCompleteMatches.length,
          complete: completeCount,
          withDeck: preCompleteMatches.filter((f) => f.deckId != null).length,
          pendingRetry: facts.reduce((sum, f) => sum + f.pending, 0),
          avgSwapped: avgSwappedRaw == null ? null : +avgSwappedRaw.toFixed(2),
          swapBands: swapBands(swapKnownMatches),
          swapByPlayOrder: {
            first: swapBands(swapKnownMatches.filter((f) => f.playOrder === 'first')),
            second: swapBands(swapKnownMatches.filter((f) => f.playOrder === 'second'))
          },
          curve,
          avgCostPre,
          avgCostPost
        }

        // ------------------------------------------------------------- cards

        const dealtKept = new Map<number, CardAcc>()
        for (const row of dealtKeptRows) {
          const cardId = Number(row.cardId)
          dealtKept.set(cardId, { cardId, dealt: num(row.dealt), kept: num(row.kept) })
        }

        const dealtByCardDeck = new Map<string, { dealt: number; wins: number }>()
        for (const row of dealtDeckRows) {
          dealtByCardDeck.set(`${Number(row.cardId)}:${Number(row.deckId)}`, {
            dealt: num(row.dealt),
            wins: num(row.wins)
          })
        }

        const decksByCard = new Map<number, { deckId: number; copies: number }[]>()
        for (const row of deckCardRows) {
          const list = decksByCard.get(row.cardId) ?? []
          list.push({ deckId: row.deckId, copies: row.count })
          decksByCard.set(row.cardId, list)
        }

        // Either half is enough to earn a row: a card seen in a hand but in no
        // known list still has a keep rate, and a card in a list but never
        // dealt is exactly the `never-dealt` case the contract asks for.
        const cardIds = [...new Set([...dealtKept.keys(), ...decksByCard.keys()])]

        const masterRows = cardIds.length
          ? await db
              .selectFrom('Card')
              .select(['cardId', 'name', 'cost', 'rarity', 'bannerHash', 'class'])
              .where('cardId', 'in', cardIds)
              .execute()
          : []
        const master = new Map(masterRows.map((r) => [r.cardId, r]))

        const cards: OpeningCardStat[] = cardIds.map((cardId) => {
          const acc = dealtKept.get(cardId) ?? { cardId, dealt: 0, kept: 0 }
          const inDecks = decksByCard.get(cardId) ?? []

          const keepRate: Rate | null =
            acc.dealt >= OPENING_THRESHOLDS.keepRate ? rate(acc.kept, acc.dealt) : null

          // Deck-dependent half. Every sum below runs over deck VERSIONS that
          // hold this card, never over the whole range, which is what keeps
          // both win-rate arms inside one copy count.
          let eligible = 0
          let eligibleWins = 0
          let dealtIn = 0
          let dealtWins = 0
          let seen = 0
          let seenPreComplete = 0
          let copiesWeighted = 0
          let copiesWeight = 0
          let copiesFallbackWeighted = 0
          let copiesFallbackWeight = 0
          let expectedWeighted = 0
          let expectedFallbackWeighted = 0

          for (const { deckId, copies } of inDecks) {
            const slice = slices.get(deckId)
            if (!slice) continue
            eligible += slice.eligible
            eligibleWins += slice.eligibleWins
            seen += slice.seen
            seenPreComplete += slice.seenPreComplete
            const hit = dealtByCardDeck.get(`${cardId}:${deckId}`)
            if (hit) {
              dealtIn += hit.dealt
              dealtWins += hit.wins
            }
            // Weighted by exposure, as `cardStats.ts` weights it: a version
            // played twice should not move the average as far as one played
            // two hundred times. The weight is the eligible count so that
            // `copies` and `observedDealRate` describe the same matches; the
            // fallback covers a version with no complete hand yet, whose
            // copy count would otherwise vanish from the average entirely.
            copiesWeighted += copies * slice.eligible
            copiesWeight += slice.eligible
            copiesFallbackWeighted += copies * slice.seen
            copiesFallbackWeight += slice.seen

            // The expectation is computed HERE, per version, and averaged with
            // the same weights - not once at the averaged `copies`. A card run
            // as a 3-of and then as a 1-of has two deal rates (27.7% and 10%),
            // and the matches were played under one or the other; the
            // expectation at a fictional 2.0-copy deck is a number no game in
            // the range was ever drawn from. `copies` is still averaged, but
            // only because the column has to print something.
            const versionExpectation = hypergeometricAtLeastOne(copies)
            expectedWeighted += versionExpectation * slice.eligible
            expectedFallbackWeighted += versionExpectation * slice.seen
          }

          const copies =
            copiesWeight > 0
              ? +(copiesWeighted / copiesWeight).toFixed(2)
              : copiesFallbackWeight > 0
                ? +(copiesFallbackWeighted / copiesFallbackWeight).toFixed(2)
                : null

          const expectedDealRate =
            copiesWeight > 0
              ? +(expectedWeighted / copiesWeight).toFixed(2)
              : copiesFallbackWeight > 0
                ? +(expectedFallbackWeighted / copiesFallbackWeight).toFixed(2)
                : null
          const observedDealRate = eligible > 0 ? +((dealtIn / eligible) * 100).toFixed(2) : null

          const dealRateSuspect =
            expectedDealRate != null &&
            observedDealRate != null &&
            eligible >= OPENING_THRESHOLDS.dealCheck &&
            // Only the low side. A card turning up MORE often than the list
            // allows is almost never a recognition fault - it is a deck list
            // that does not match what was played, which is a different
            // problem with a different fix, and flagging it here would teach
            // the user to distrust the recogniser for someone else's bug.
            observedDealRate < expectedDealRate &&
            // p < 0.01, and the level is doing a job. This test is run once per
            // card with NO multiplicity correction across the fifteen-odd
            // distinct cards of a deck, so at the conventional 0.05 about one
            // false alarm per deck is the EXPECTED outcome rather than a
            // surprise - the flag would then mean nothing. 0.01 is what keeps
            // it worth reacting to. Even so it says "worth a look", not "the
            // recogniser is broken": the honest reading is a prompt for a human
            // to compare the card against its illustration, and the UI copy
            // must not promise more than that.
            binomialTwoSided(dealtIn, eligible, expectedDealRate) < 0.01

          const recognisedShare = seen > 0 ? +(seenPreComplete / seen).toFixed(4) : null

          const notDealt = Math.max(0, eligible - dealtIn)
          const notDealtWins = Math.max(0, eligibleWins - dealtWins)
          const confidence: Confidence = confidenceFor(dealtIn, notDealt)

          let dealtWr: Rate | null = null
          let notDealtWr: Rate | null = null
          let diff: number | null = null
          let diffLo: number | null = null
          let diffHi: number | null = null
          if (dealtIn > 0 && notDealt > 0) {
            const a = rate(dealtWins, dealtIn)
            const b = rate(notDealtWins, notDealt)
            // The interval describes the RAW difference and the point estimate
            // is shrunk, which reads odd until you remember what each is for:
            // the interval says how much the data pins down, the shrunk value
            // is what the table may be sorted on. Newcombe rather than a Wald
            // interval on the difference - see `stats.ts` for why the naive
            // one collapses exactly where this page lives.
            const nd = newcombeDiff(
              { wins: dealtWins, total: dealtIn },
              { wins: notDealtWins, total: notDealt }
            )
            dealtWr = a
            notDealtWr = b
            diff = +shrink(nd.diff, dealtIn, notDealt).toFixed(2)
            diffLo = +nd.lo.toFixed(2)
            diffHi = +nd.hi.toFixed(2)
          }
          // All five, not the three the brief named. An interval with no point
          // estimate and no arms beside it is the most assured-looking thing on
          // the row, and it would be sitting on the row that earned the least
          // assurance - the same failure the Newcombe interval was chosen to
          // avoid, reintroduced one column over.
          if (confidence === 'hidden') {
            dealtWr = null
            notDealtWr = null
            diff = null
            diffLo = null
            diffHi = null
          }

          // Exactly one reason, most fundamental first: without a deck there is
          // no denominator to be short of, and without a readable hand there is
          // nothing to have failed to draw.
          const missing: Missing | null =
            seen === 0
              ? 'no-deck'
              : eligible === 0
                ? 'unidentified'
                : dealtIn === 0
                  ? 'never-dealt'
                  : keepRate === null || confidence === 'hidden'
                    ? 'low-sample'
                    : null

          const row = master.get(cardId)
          const classId = row?.class == null ? null : Number(row.class)

          return {
            cardId,
            // `Card` is a cache of the portal's data. A missing row degrades to
            // the number, which is still enough to look the card up, rather
            // than dropping a real observation from the page.
            name: row?.name ?? `#${cardId}`,
            cost: row?.cost ?? null,
            rarity: row?.rarity ?? null,
            bannerHash: row?.bannerHash ?? null,
            className:
              classId == null
                ? null
                : classId === NEUTRAL_CLASS_ID
                  ? 'neutral'
                  : (CLASS_ID_TO_NAME[classId] ?? 'neutral'),
            dealt: acc.dealt,
            kept: acc.kept,
            keepRate,
            copies,
            eligible,
            expectedDealRate,
            observedDealRate,
            dealRateSuspect,
            recognisedShare,
            dealtWr,
            notDealtWr,
            diff,
            diffLo,
            diffHi,
            confidence,
            missing
          }
        })

        // Sortable rows first, by the shrunk difference; everything else by how
        // much was observed. A single ordering across both would rank a card
        // whose difference is noise above one with ten times the data.
        cards.sort((a, b) => {
          const aSort = a.confidence === 'sortable' ? 0 : 1
          const bSort = b.confidence === 'sortable' ? 0 : 1
          if (aSort !== bSort) return aSort - bSort
          if (aSort === 0) {
            const d = (b.diff ?? 0) - (a.diff ?? 0)
            if (d !== 0) return d
          }
          return b.dealt - a.dealt || a.cardId - b.cardId
        })

        return { summary, cards }
      })
  )
}
