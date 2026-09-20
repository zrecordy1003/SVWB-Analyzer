/**
 * 換牌建議 — the local keep-or-swap comparison (`docs/mulligan-advisor-plan.md`,
 * 階段 M5).
 *
 * The contract, and the argument for why this is a separate channel from
 * `cards:openingStats` rather than five more columns on it, live in
 * `shared/openingStats.ts`. What belongs here is how the comparison is got out
 * of the database, and the two decisions the contract could not express: where
 * the rest-of-hand band boundaries are, and what happens when a cell is empty.
 *
 * # The estimand, in one paragraph
 *
 * `cards:openingStats` compares *dealt* against *not dealt*. That comparison is
 * clean because the deal is a hypergeometric draw and nobody chose it. This one
 * compares *kept* against *swapped*, which nobody randomised: the player kept
 * the card because of the other three, the matchup and the turn order. It is
 * computed anyway because it is the question a mulligan actually asks - a card
 * that is fine to be dealt and a disaster to keep is a real and common thing,
 * and the dealt-versus-not comparison is silent about it (it is intent-to-treat:
 * it already contains whatever the player did next).
 *
 * Two of the three confounders are dealt with rather than disclaimed:
 *
 * - **The player.** There is one. The comparison is within-player by
 *   construction, so skill cannot confound it. This is the structural advantage
 *   the local version has over any pooled cloud version, and it is free.
 * - **The other three cards.** They are randomly dealt and they precede the
 *   decision, so conditioning on them is legitimate - a pre-treatment
 *   covariate, not a collider. That is what the bands below are for, and at
 *   `basis: 'stratified'` they are combined by Mantel-Haenszel rather than
 *   pooled, which is the only form of this estimate that actually removes the
 *   confounding the plan's 二.1 promises to remove.
 * - **Synergy inside the hand** ("keep A only when B is there") survives, and
 *   the contract says the page must admit it. No amount of banding on cost
 *   reaches it, because the reduction to one card at a time is what loses it.
 *
 * # The unit of observation is a COPY, not a match
 *
 * Every count below - `dealt`, `kept`, and both arms of every comparison -
 * counts pre-mulligan SLOTS, and whether a slot was kept is read off that row's
 * own `swapped` flag. `openingStats.ts` does it differently on purpose (one
 * observation per match, kept meaning "the card is somewhere in the post
 * hand"), and that difference is not an oversight in either file:
 *
 * - There, the question is "was this card dealt at all", which is a fact about
 *   the hand; two copies are one observation of it, and counting them twice
 *   would inflate the deal rate against a hypergeometric expectation that is
 *   already phrased as "at least one".
 * - Here, the question is "what happened when this copy was thrown back", and
 *   the decision was taken per copy. Post-membership cannot answer it: a hand
 *   holding two copies where one goes back still has the card in the post hand,
 *   so post-membership scores that as a clean keep and loses the swap entirely.
 *   The `swapped` flag is ground truth - migration 014 reads it off the panel's
 *   geometry, per slot, and it is written for every `stage='pre'` row whether or
 *   not anything was recognised.
 *
 * So do not "fix" this file to match its neighbour. The cost of the choice is
 * stated where it is paid, at `bump`.
 *
 * # Shape of the work
 *
 * One query over `MatchOpeningCard` for the whole filter, grouped in JS. This
 * looks like the thing `openingStats.ts`'s header warns against - it returns
 * eight rows per match rather than collapsing to a cardinality independent of
 * the match count - and the difference is that this channel genuinely needs
 * hand-level facts that no coarser grouping can reconstruct. The band of a slot
 * is a property of the OTHER three slots of that one hand; group in SQL and the
 * companions are gone. The rule the header really states is the one kept here:
 * no query per card, and no query per band. There are two queries below, one
 * for the hands and one to put names on the cards they mention.
 *
 * Completeness is derived on every call, never stored, for the same reason as
 * in `openingStats.ts`: `Command::RetryUnnamedCards` names a card long after
 * the match ended, so a stored flag would be wrong from that moment and nothing
 * would notice. Here the derivation is in JS rather than a `HAVING`, only
 * because this pass already holds every row it would test.
 */
import {
  KEEP_THRESHOLDS,
  REST_BANDS,
  type AdviceBasis,
  type Confidence,
  type KeepAdvice,
  type KeepBand,
  type Missing,
  type MulliganPayload,
  type MulliganResult,
  type Rate
} from '../../shared/openingStats.js'
import { confidenceFor, mantelHaenszelDiff, newcombeDiff, rate } from '../../shared/stats.js'
import { getDb } from '../data/db/client.js'
import { filterExpressions, type QueryPayload } from './matches.js'
import { handleIpc } from './typed.js'
import { wrapRes as wrap, type Res } from '../../shared/ipc.js'

export type { MulliganPayload } from '../../shared/openingStats.js'

/**
 * Where the rest-of-hand bands are cut, as the mean cost of the other three
 * cards. `REST_BANDS - 1` boundaries, low to high.
 *
 * **Fixed cut-points, not quantiles, and that is the choice worth defending.**
 * Quantiles would adapt to the player - each of us would get three equally
 * populated bands whatever our deck looks like - and they were rejected because
 * they make two queries incomparable. Under quantiles, "band 1" means a
 * different hand in the dragon matchup than in the pooled view, a different
 * hand this month than last, and a different hand for a ramp deck than for an
 * aggro one; a reader comparing two rows of this page would be comparing two
 * definitions. Every number on this page is already fragile enough without the
 * axis moving underneath it.
 *
 * The numbers themselves come from what a 40-card constructed hand actually
 * looks like. These lists curve out at one to three mana, so three cards
 * averaging under 2.5 are three things you can cast in the first three turns -
 * the hand you keep an expensive card alongside. Three cards averaging four or
 * more cannot be played before turn four between them, which is the hand where
 * even a good five-drop has to go back. The middle band is everything else, and
 * it is deliberately the widest: it is the ordinary hand, and the confounding
 * this band exists to remove lives at the two ends.
 *
 * A boundary that a mean can land on exactly (4.0, from three four-drops) goes
 * to the HIGHER band, which is the comparison written below (`< cut`).
 */
const REST_BAND_CUTS = [2.5, 4] as const

/** Same coercion `cardStats.ts` and `openingStats.ts` apply, so "most recent N" means one thing. */
const normaliseLimit = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  return n >= 1 ? n : undefined
}

const num = (v: unknown): number => Number(v ?? 0)

/**
 * Which band the other three cards fall in, or null when one of them has no
 * known cost.
 *
 * Null rather than a guess. `Card` is a cache of the portal's data and can be
 * missing a row, and a band computed from two of three companions is not a
 * noisier band, it is the wrong one - dropping the most expensive companion is
 * exactly what would move a hand out of the band that explains the decision.
 * The caller keeps such an observation in the pooled rungs, where the band is
 * not used, and drops it only from the stratified one.
 */
function restBand(costs: (number | null)[]): number | null {
  if (costs.length === 0) return null
  let sum = 0
  for (const cost of costs) {
    if (cost == null || !Number.isFinite(cost)) return null
    sum += cost
  }
  const avg = sum / costs.length
  for (let band = 0; band < REST_BAND_CUTS.length; band++) {
    if (avg < REST_BAND_CUTS[band]) return band
  }
  return REST_BANDS - 1
}

/** One side of the comparison: how many observations, and how many were wins. */
type Arm = { n: number; wins: number }

/** A comparison at one rung of the ladder: the two arms it has to offer. */
type Cell = { kept: Arm; swapped: Arm }

const emptyCell = (): Cell => ({ kept: { n: 0, wins: 0 }, swapped: { n: 0, wins: 0 } })

/**
 * Record one copy's fate.
 *
 * The cost of counting copies rather than matches is paid here and is worth
 * naming: a hand that kept one copy and threw the other puts the SAME match
 * result into both arms. That is the honest description of what happened - two
 * decisions, one outcome - but the two observations are perfectly correlated,
 * so a comparison built from many such hands is slightly more certain-looking
 * than it deserves. It is accepted because the alternative (dropping split
 * hands, or scoring them as a keep) throws away or misreads the only
 * observations where the player actually did both things at once. Duplicates in
 * a four-card opening hand are rare enough that the inflation is small, and
 * `KEEP_THRESHOLDS` is set well above where it would matter.
 */
const bump = (cell: Cell, wasKept: boolean, won: boolean): void => {
  const arm = wasKept ? cell.kept : cell.swapped
  arm.n += 1
  if (won) arm.wins += 1
}

const addCell = (into: Cell, from: Cell): void => {
  into.kept.n += from.kept.n
  into.kept.wins += from.kept.wins
  into.swapped.n += from.swapped.n
  into.swapped.wins += from.swapped.wins
}

const cellSize = (cell: Cell): number => cell.kept.n + cell.swapped.n

/** The smaller arm, which is what every threshold below is measured against. */
const smallerArm = (cell: Cell): number => Math.min(cell.kept.n, cell.swapped.n)

/** Everything one card accumulates in the single pass over the hands. */
type CardAcc = {
  /** Copies dealt inside the payload's own filter, in hands read in full. */
  dealt: number
  /** Of those, how many survived. */
  kept: number
  /** Rung 1: the payload's filter, split by band. Indexed by band. */
  bands: Cell[]
  /** Rung 2: the payload's opponent and turn order, bands pooled raw. */
  turnOrder: Cell
  /** Rung 3: the payload's opponent, turn orders pooled too. */
  opponent: Cell
  /** Rung 4: opponents pooled as well. */
  allOpponents: Cell
  /** The card turned up, but only in hands that were never read in full. */
  seenIncomplete: boolean
}

const emptyAcc = (): CardAcc => ({
  dealt: 0,
  kept: 0,
  bands: Array.from({ length: REST_BANDS }, emptyCell),
  turnOrder: emptyCell(),
  opponent: emptyCell(),
  allOpponents: emptyCell(),
  seenIncomplete: false
})

/** One hand, assembled from its eight rows. */
type Hand = {
  oppoClass: string
  playOrder: string
  won: boolean
  /** The four dealt slots, in the order the rows arrived. */
  pre: { cardId: number | null; cost: number | null; swapped: number | null }[]
}

/** One rung of the ladder, once the pass is done. */
type Rung = {
  basis: AdviceBasis
  /** The crude arms this rung offers, or null when it has nothing. */
  cell: Cell | null
  /**
   * The band-adjusted difference AND its own interval, where the rung has one.
   * Null at every rung below `'stratified'`, which has nothing to adjust.
   */
  adjusted: { diff: number; lo: number; hi: number } | null
  /** The per-band detail, only at `'stratified'`. */
  bands: KeepBand[]
}

export function registerMulliganIpc(): void {
  const db = getDb()

  /**
   * "Against this opponent, should I keep this card?", for the match set the
   * filter selects.
   *
   * Takes the match list's filter payload for the same reason every other
   * aggregate page does: a deck, mode, range, tag or CR condition has to mean
   * the same thing everywhere, and `filterExpressions` is the one place those
   * become SQL. `oppoClass` and `playOrder` are this page's own two, and they
   * are NOT passed through `filterExpressions` on purpose - the ladder below
   * has to be able to step outside them, which a filter baked into the scope
   * could not do.
   */
  handleIpc(
    'cards:mulligan',
    async (_e, input: MulliganPayload = {}): Promise<Res<MulliganResult>> =>
      wrap(async () => {
        const { limit: rawLimit, mode, oppoClass, playOrder, ...rest } = input ?? {}
        const p: QueryPayload = { ...rest, mode: mode && mode !== 'all' ? mode : null }
        const limit = normaliseLimit(rawLimit)
        const pinnedOppo = oppoClass ?? null
        const pinnedOrder = playOrder ?? null

        // The match set, exactly as `cards:openingStats` builds it: the shared
        // filters, finished matches only (half of this page is win rates and a
        // match still being played has no result to put in either arm), and the
        // "most recent N" cut applied before anything else looks at a row.
        let scope = db
          .selectFrom('Match')
          .select('id')
          .where((eb) => eb.and([...filterExpressions(eb, p), eb('result', 'is not', null)]))
        if (limit !== undefined) {
          scope = scope.orderBy('playedAt', 'desc').orderBy('id', 'desc').limit(limit)
        }

        // The one pass. `cost` is joined here rather than looked up later
        // because it is needed per SLOT - the band of a copy is the mean cost of
        // the three slots beside it - and a per-card cost map cannot answer that
        // for a hand holding two copies without re-deriving the slots anyway.
        const handRows = await db
          .selectFrom('MatchOpeningCard as o')
          .innerJoin('Match as m', 'm.id', 'o.matchId')
          .leftJoin('Card as c', 'c.cardId', 'o.cardId')
          .select([
            'o.matchId as matchId',
            'o.stage as stage',
            'o.slot as slot',
            'o.cardId as cardId',
            'o.swapped as swapped',
            'c.cost as cost',
            'm.oppo_class as oppoClass',
            'm.play_order as playOrder',
            'm.result as result'
          ])
          .where('o.matchId', 'in', scope)
          .where('o.stage', '=', 'pre')
          .execute()

        if (handRows.length === 0) return { matches: 0, baseline: null, cards: [] }

        const hands = new Map<number, Hand>()
        for (const row of handRows) {
          const matchId = Number(row.matchId)
          let hand = hands.get(matchId)
          if (!hand) {
            hand = {
              oppoClass: String(row.oppoClass ?? ''),
              playOrder: String(row.playOrder ?? ''),
              won: num(row.result) === 1,
              pre: []
            }
            hands.set(matchId, hand)
          }
          hand.pre.push({
            cardId: row.cardId == null ? null : Number(row.cardId),
            cost: row.cost == null ? null : Number(row.cost),
            swapped: row.swapped == null ? null : Number(row.swapped)
          })
        }

        const accs = new Map<number, CardAcc>()
        const accFor = (cardId: number): CardAcc => {
          const existing = accs.get(cardId)
          if (existing) return existing
          const fresh = emptyAcc()
          accs.set(cardId, fresh)
          return fresh
        }

        let matches = 0
        let baselineWins = 0

        for (const hand of hands.values()) {
          // The payload's two selectors. `inNarrow` is the set the page claims
          // to be about, and it is what `matches`, `baseline`, `dealt` and the
          // keep rate are counted over - those four are descriptions of the
          // filter the user chose, and they must never quietly widen.
          const inOppo = pinnedOppo == null || hand.oppoClass === pinnedOppo
          const inOrder = pinnedOrder == null || hand.playOrder === pinnedOrder
          const inNarrow = inOppo && inOrder

          // Every slot read, named, and carrying its swap flag. A hand read as
          // three cards cannot contribute at all - not because the observation
          // is noisier but because the rest-of-hand band is undefined without
          // the fourth card, and the unread slot is exactly the one that would
          // have moved it. The flag is checked too although migration 014
          // promises it is never NULL on a `pre` row, because the alternative to
          // checking is silently scoring an unread panel as four keeps.
          const preComplete =
            hand.pre.length === 4 && hand.pre.every((s) => s.cardId != null && s.swapped != null)

          if (!preComplete) {
            // Remembered, but only so the row can say `'unidentified'` rather
            // than vanishing. A card the user has seen a dozen times and this
            // page has never counted needs to say why.
            if (inNarrow) {
              for (const slot of hand.pre) {
                if (slot.cardId != null) accFor(slot.cardId).seenIncomplete = true
              }
            }
            continue
          }

          if (inNarrow) {
            matches += 1
            if (hand.won) baselineWins += 1
          }

          hand.pre.forEach((slot, index) => {
            const cardId = slot.cardId as number
            const acc = accFor(cardId)
            const wasKept = slot.swapped !== 1

            if (inNarrow) {
              acc.dealt += 1
              if (wasKept) acc.kept += 1
            }

            // The other three SLOTS, which is why the loop is over slots and
            // not over distinct card ids: for a hand holding two copies the
            // companions of one copy include the other copy, and that is the
            // hand the player was actually looking at.
            const band = restBand(hand.pre.filter((_, i) => i !== index).map((s) => s.cost))

            if (inNarrow && band != null) bump(acc.bands[band], wasKept, hand.won)
            if (inNarrow) bump(acc.turnOrder, wasKept, hand.won)
            if (inOppo) bump(acc.opponent, wasKept, hand.won)
            bump(acc.allOpponents, wasKept, hand.won)
          })
        }

        const cardIds = [...accs.keys()].filter((cardId) => {
          const acc = accs.get(cardId)!
          return acc.dealt > 0 || acc.seenIncomplete
        })

        // Cards are the ones the user was actually dealt inside the filter they
        // are looking at. A card dealt only against other opponents can have a
        // pooled estimate and no reason to be on a page about this matchup, and
        // printing it with `dealt: 0` beside a borrowed win rate would be the
        // most confusing row on the screen.
        if (cardIds.length === 0) {
          return {
            matches,
            baseline: matches > 0 ? rate(baselineWins, matches) : null,
            cards: []
          }
        }

        const masterRows = await db
          .selectFrom('Card')
          .select(['cardId', 'name', 'cost', 'bannerHash', 'imageHash'])
          .where('cardId', 'in', cardIds)
          .execute()
        const master = new Map(masterRows.map((r) => [r.cardId, r]))

        const cards: KeepAdvice[] = cardIds.map((cardId) => {
          const acc = accs.get(cardId)!
          const row = master.get(cardId)

          const keepRate: Rate | null =
            acc.dealt >= KEEP_THRESHOLDS.keepRate ? rate(acc.kept, acc.dealt) : null

          // ------------------------------------------------ the stratified rung
          //
          // Only the bands that hold BOTH a keep and a swap take part. A band
          // where the card was always kept contributes no comparison - there is
          // nothing to compare it against inside that band - and including it
          // would be pooling by the back door, which is the thing the bands
          // exist to prevent. `mantelHaenszelDiff` weights each surviving band
          // by `n1·n0/(n1+n0)`, so a band with twenty of each counts for more
          // than one with one of each, and returns null when nothing survives.
          const contributing = acc.bands.filter((cell) => smallerArm(cell) > 0)
          const stratified = emptyCell()
          for (const cell of contributing) addCell(stratified, cell)
          const mh = mantelHaenszelDiff(
            contributing.map((cell) => ({
              aWins: cell.kept.wins,
              aTotal: cell.kept.n,
              bWins: cell.swapped.wins,
              bTotal: cell.swapped.n
            }))
          )
          // Every band with anything in it, including the one-armed ones the
          // estimate could not use. This is the drill-down, and a band that had
          // to be left out is precisely what a suspicious reader is looking for.
          const bandDetail: KeepBand[] = acc.bands
            .map((cell, band) => ({
              band,
              keptWr: cell.kept.n > 0 ? rate(cell.kept.wins, cell.kept.n) : null,
              swappedWr: cell.swapped.n > 0 ? rate(cell.swapped.wins, cell.swapped.n) : null
            }))
            .filter((_, band) => cellSize(acc.bands[band]) > 0)

          // ------------------------------------------------- the fallback ladder
          //
          // Narrowest first, then outward until both arms clear `show`:
          //
          //   (opponent, turn order, bands combined by MH) -> 'stratified'
          //   (opponent, turn order, bands pooled raw)     -> 'turn-order'
          //   (opponent, turn orders pooled)               -> 'opponent'
          //   (opponents pooled too)                       -> 'all-opponents'
          //
          // The reason this exists at all is the reason the whole feature is a
          // local one. `docs/mulligan-advisor-plan.md` 二.2 killed the previous
          // design - a within-player fixed effect - and the decisive argument
          // was not that it was wrong but that it degenerated to the EMPTY SET
          // rather than to an unadjusted estimate: at this sample size only the
          // handful of cards a player sometimes keeps and sometimes swaps, in
          // one stratum, would have survived, and the page would have shown
          // nothing at all. **An estimator that returns nothing when the data is
          // thin is worse, as a product, than one that returns something coarser
          // and says so.** A user who is told "against dragon specifically we
          // cannot tell, but across all opponents this card has gone better when
          // kept" has been given something they can act on and can discount.
          // A user shown a dash has been given a working feature that looks
          // broken, and they will stop opening the page.
          //
          // The two rules that keep that from becoming a lie: `basis` always
          // names the rung actually used, and the levels are never mixed within
          // one card. A `keptWr` from the matchup beside a `swappedWr` borrowed
          // from the pooled set would be a difference between two different
          // populations, which is not a small error - it is the whole Simpson
          // family of mistakes, arriving dressed as a fallback.
          //
          // Note what the last rung does when the payload PINS an opponent: it
          // pools over that pin, in defiance of the filter the user set. That is
          // intended, and `basis: 'all-opponents'` is how the page is obliged to
          // say it. It pools over this page's own two selectors ONLY - every
          // filter from the shared filter bar (deck, mode, date range, tags, the
          // `oppoClassIds` multi-select, CR) is still applied at every rung,
          // because those define which matches exist at all, while `oppoClass`
          // and `playOrder` here define strata inside them.
          const ladder: Rung[] = [
            {
              basis: 'stratified',
              cell: mh == null ? null : stratified,
              adjusted: mh,
              bands: bandDetail
            },
            { basis: 'turn-order', cell: acc.turnOrder, adjusted: null, bands: [] },
            { basis: 'opponent', cell: acc.opponent, adjusted: null, bands: [] },
            { basis: 'all-opponents', cell: acc.allOpponents, adjusted: null, bands: [] }
          ]

          let chosen: Rung | null = null
          for (const rung of ladder) {
            if (rung.cell && smallerArm(rung.cell) >= KEEP_THRESHOLDS.show) {
              chosen = rung
              break
            }
          }

          const cell = chosen?.cell ?? null
          const confidence: Confidence = cell
            ? confidenceFor(cell.kept.n, cell.swapped.n, KEEP_THRESHOLDS)
            : 'hidden'

          let keptWr: Rate | null = null
          let swappedWr: Rate | null = null
          let diff: number | null = null
          let diffLo: number | null = null
          let diffHi: number | null = null
          let bands: KeepBand[] = []
          if (cell && chosen && confidence !== 'hidden') {
            // The two arms are always the CRUDE ones, pooled over whatever this
            // rung covers, because they are what the page prints beside the
            // card and a reader must be able to check them against `dealt` and
            // the keep rate. The point estimate is the adjusted one where the
            // rung has one, so at `'stratified'` `diff` deliberately does not
            // equal `keptWr.rate - swappedWr.rate`: the distance between them IS
            // the confounding the bands removed, and the contract says so.
            keptWr = rate(cell.kept.wins, cell.kept.n)
            swappedWr = rate(cell.swapped.wins, cell.swapped.n)
            // Each rung's interval is the one that belongs to its own
            // estimator, never a borrowed one. At `'stratified'` that is
            // Greenland-Robins around the MH estimate; at the lower rungs there
            // is nothing to adjust, so the crude gap and Newcombe on the crude
            // arms are both correct and describe the same quantity. Mixing them
            // - an adjusted point inside a crude interval - is how a page ends
            // up drawing an estimate that sits outside its own whisker.
            const interval =
              chosen.adjusted ??
              newcombeDiff(
                { wins: cell.kept.wins, total: cell.kept.n },
                { wins: cell.swapped.wins, total: cell.swapped.n }
              )
            // `diff` is the estimate itself, no longer shrunk toward zero.
            //
            // Shrinkage was here to stop a tiny sample from topping a sortable
            // table with a huge effect. That table is gone: the advisor gives a
            // verdict, and the verdict is decided by whether the INTERVAL
            // clears zero (`verdictFor`), which handles the same danger
            // properly - a thin arm produces bounds too wide to point anywhere,
            // whatever the point estimate says.
            //
            // So the shrinkage no longer buys anything, and it costs something
            // real: the point could land outside its own bounds (+17.3 against
            // [17.8, 64.6] in the demo fixture), which the drawer now prints
            // side by side as plain text. A number outside its own interval
            // reads as a bug, and defending it needs a paragraph nobody will
            // read. One estimate, one interval, and they agree.
            //
            // `shrink` stays in `shared/stats.ts` - the 起手 page still sorts
            // on a shrunk difference, and there the table it protects is real.
            diff = +interval.diff.toFixed(2)
            diffLo = +interval.lo.toFixed(2)
            diffHi = +interval.hi.toFixed(2)
            bands = chosen.bands
          }
          // All five go together when the rung is hidden, not just the estimate.
          // An interval standing on its own, with no arms and no point estimate
          // beside it, is the most authoritative-looking thing that could be
          // printed on the row that earned the least authority - the same
          // failure the Newcombe interval was chosen to avoid, reintroduced one
          // column over. The reasoning is recorded at the equivalent spot in
          // `openingStats.ts`.

          // `'never-dealt'` cannot arise on this page: a card with no
          // appearances is simply not in the result, because unlike the 起手
          // page there is no deck list here to say the card should have turned
          // up. If a case for it ever appears, it is a bug, not a state to
          // invent a value for.
          const missing: Missing | null =
            acc.dealt === 0
              ? 'unidentified'
              : keepRate === null || confidence === 'hidden'
                ? 'low-sample'
                : null

          return {
            cardId,
            // A missing `Card` row degrades to the number, which is still enough
            // to look the card up, rather than dropping a real observation.
            name: row?.name ?? `#${cardId}`,
            cost: row?.cost ?? null,
            bannerHash: row?.bannerHash ?? null,
            imageHash: row?.imageHash ?? null,
            dealt: acc.dealt,
            kept: acc.kept,
            keepRate,
            keptWr,
            swappedWr,
            diff,
            diffLo,
            diffHi,
            basis: chosen?.basis ?? 'all-opponents',
            bands,
            confidence,
            missing
          }
        })

        // Sortable rows first by the shrunk difference, everything else by how
        // much was observed. One ordering across both would rank a card whose
        // difference is noise above one with ten times the data.
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

        return {
          matches,
          baseline: matches > 0 ? rate(baselineWins, matches) : null,
          cards
        }
      })
  )
}
