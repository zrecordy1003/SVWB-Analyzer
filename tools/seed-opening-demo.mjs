/**
 * Demo data for the 起手 (opening hand) and 換牌建議 (mulligan advisor) pages —
 * reversible, tagged, and off by default.
 *
 * THIS DATA MUST NEVER LEAVE THE MACHINE
 * --------------------------------------
 * Read this section before changing anything in this file, because one line in
 * it is load-bearing for something much bigger than a demo page.
 *
 * Every `Match` row written here carries `source = 'demo-seed'` (the constant
 * `DEMO_SOURCE`, below). `classifyRow` in `src/main/telemetry/rollup.ts` is the
 * single gate every uploaded row passes through, and it FAILS CLOSED: a
 * `source` that is neither `'engine'` nor `'manual'` nor NULL classifies as
 * `'invalid'` and is dropped before it can become a bucket, be counted as
 * `manual`, or be counted as `abandoned`. `'demo-seed'` is none of those three,
 * so the rows this script writes are excluded — by that one comparison and by
 * nothing else.
 *
 * That is not a theoretical safeguard. The check used to fall through to
 * `clean`, 583 seeded matches uploaded themselves as the most trustworthy tier
 * there is, and ten fabricated ranked games reached the published meta
 * document. The server has been repaired and the gate now fails closed, but the
 * gate is the only thing standing there.
 *
 * So: **changing `DEMO_SOURCE` away from `'demo-seed'` re-opens the hole.**
 * Setting it to `'engine'` would upload every seeded match. Setting it to NULL
 * would classify them as `legacy`, which is also a real tier and also uploads.
 * Any other string is safe today only because `classifyRow` rejects everything
 * it does not recognise — which is a property of that function, not of this one,
 * and is why `tests/main/seedOpeningDemo.test.ts` asserts it directly against
 * rows shaped the way this file writes them rather than trusting this comment.
 *
 * WHAT THIS WRITES, AND WHERE
 * ---------------------------
 * It writes into the REAL production database at
 *
 *     %APPDATA%\svwb-analyzer\db\app.db
 *
 * the same file the installed app uses, holding the user's real matches. It
 * inserts synthetic `Match` rows and their `MatchOpeningCard` hands so the
 * opening-hand page has enough data to show every state it can show, including
 * the empty ones. It inserts nothing else except, where the user owns no deck
 * list for a class it needs one for, a small number of `Deck`/`DeckCard` rows.
 *
 * It NEVER updates and NEVER deletes a row it did not create. Everything real
 * in this database is read-only to this script.
 *
 * HOW TO UNDO IT
 * --------------
 *     node tools/seed-opening-demo.mjs --remove
 *
 * Every inserted match carries `Match.source = 'demo-seed'` and every inserted
 * deck carries `Deck.sourceRef = 'demo-seed'` plus a `[demo]` name prefix, so
 * removal is two `DELETE ... WHERE` clauses with no guesswork and no date
 * arithmetic. `MatchOpeningCard.matchId` has `ON DELETE CASCADE` (see
 * `resources/migrations/014_add_opening_hand.sql`), so the hands go with the
 * matches; `--remove` asserts afterwards that no orphan slot survived and says
 * so out loud rather than trusting the declaration.
 *
 * The rejected alternative was a separate demo database file, pointed at by an
 * env var. It is obviously safer, and it was rejected because the thing the
 * user wants to look at is the page inside the installed app, and the installed
 * app reads exactly one path. A demo database they cannot open in the app would
 * have demonstrated nothing. The safety therefore had to be bought with a
 * marker column and a backup rather than with a different file.
 *
 * USAGE
 * -----
 *     node tools/seed-opening-demo.mjs            # dry run: prints, writes nothing
 *     node tools/seed-opening-demo.mjs --apply    # actually writes
 *     node tools/seed-opening-demo.mjs --remove   # undoes it
 *     node tools/seed-opening-demo.mjs --db <path>          # another database
 *     node tools/seed-opening-demo.mjs --apply --ignore-running   # escape hatch
 *
 * Dry run is the default on purpose. A seeder whose default is to write is one
 * fat-fingered shell history entry away from being a data-loss incident, and
 * this one runs against the only copy of 353 matches somebody cares about.
 *
 * TWO PAGES, TWO VERY DIFFERENT DATA REQUIREMENTS
 * -----------------------------------------------
 * The 起手 page asks "was this card dealt, and did that go well". One
 * observation per match, no decision involved, and a few hundred matches are
 * plenty. That is the `witch` set, and it is unchanged.
 *
 * 換牌建議 asks "you kept this card against THIS class with THAT sort of hand
 * beside it — did that go well". `src/main/ipc/mulligan.ts` counts COPIES, not
 * matches; it splits them by the rest-of-hand band (the mean cost of the other
 * three slots, cut at 2.5 and 4.0); it requires BOTH arms of a comparison to
 * clear `KEEP_THRESHOLDS.show` (12) before a number appears and `sort` (30)
 * before it can be ordered on; and it walks a four-rung ladder outward
 * (`stratified` → `turn-order` → `opponent` → `all-opponents`) when a cell is
 * too thin. Multiply those together and the cell that has to be filled is
 * small: one card, one opponent class, one turn order, one band, both arms.
 *
 * The old generator made the keep decision a function of COST ALONE. That is
 * enough for a keep-rate column and useless for the advisor: a card kept 93% of
 * the time has no swapped arm to compare against, the keep decision is
 * independent of the opponent so every matchup looks the same, and nothing is
 * confounded so the Mantel-Haenszel adjustment has nothing to do. The `royal`
 * set below exists to fix exactly that, and `ADVISOR_PLANT_RULES` says what each
 * planted card is supposed to make the page show.
 *
 * DETERMINISM
 * -----------
 * The RNG is a mulberry32 seeded from a constant (`DEMO_SEED`), implemented in
 * this file rather than pulled from npm — a demo seeder is not worth a
 * dependency, and a dependency is exactly the kind of thing that makes a
 * throwaway script un-runnable eighteen months later. Two runs therefore
 * produce byte-identical data, so re-seeding after a `--remove` gives the user
 * back the same page they were looking at.
 *
 * STRUCTURE
 * ---------
 * Everything above `--- SQLITE ---` is pure: it takes a seeded RNG and plain
 * data and returns plain objects, and `tests/main/seedOpeningDemo.test.ts`
 * exercises it without a database. Everything below touches the disk. The split
 * is not decoration: the interesting part of this script is whether the hands
 * are really hypergeometric, and that is not a thing you want to assert by
 * reading rows back out of a production database.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Mirrors of `src/shared/openingStats.ts`. Deliberately re-declared rather than
// imported: that file is TypeScript inside the app's build graph, and this is a
// plain `.mjs` run by bare node with no transpiler in front of it. Two constants
// are a cheaper price than making a maintenance script depend on a bundler.
/** Constructed is always 40. */
export const DECK_SIZE = 40
/** Cards dealt before the mulligan. */
export const HAND_SIZE = 4

/** The marker that makes removal total. Written to `Match.source`. */
export const DEMO_SOURCE = 'demo-seed'
/** The same marker for decks, on `Deck.sourceRef` — see `pickOrBuildDecks`. */
export const DEMO_DECK_REF = 'demo-seed'

/**
 * Fixed, so two runs produce identical data.
 *
 * Not an arbitrary constant: seeds were scanned against the user's own decks for
 * the one whose REALISED numbers land closest to the ones the demo claims. That
 * matters because every interesting figure here is a sample of a few hundred,
 * and at n=420 an 8-point win-rate signal can come out as zero on an unlucky
 * draw — the first seed tried produced 49.2% dealt against 50.0% not dealt,
 * which would have left the comparison column looking broken rather than quiet.
 * The rejected alternative was to widen the planted effect until any seed showed
 * it, which would have meant demonstrating the page with an effect size no real
 * card has.
 *
 * The scan now lives one level down, at `SET_SEED_OFFSETS`: each set draws from
 * its own stream, so a set can be retuned without disturbing its neighbours, and
 * this constant is only the base they are all offset from. Change it to reshuffle
 * EVERYTHING, and re-check every figure the dry run prints.
 */
export const DEMO_SEED = 2021

/**
 * Per-set stream offsets, added to `DEMO_SEED`.
 *
 * Only `witch` is tuned; the rest are arbitrary distinct constants whose only
 * job is to keep the streams apart. Witch is tuned because it is the set whose
 * REALISED figures are claimed in the summary — a planted 8pp win-rate signal
 * measured over 420 matches is a draw, not a setting, and the first offsets
 * tried produced a 9.0% observed deal rate against a claimed ~12%, which reads
 * as a broken page rather than a suppressed card.
 *
 * Scanned over 0..6000 against three targets at once: the suppressed card's
 * observed deal rate near 12%, `recognisedShare` comfortably under 0.9, and the
 * signal card's realised win-rate gap near the 8pp that was planted.
 *
 * Retune by re-running the scan, not by nudging: the three targets pull against
 * each other and the dry run prints all three, so "it looks better" is an
 * observation you can actually make.
 */
export const SET_SEED_OFFSETS = {
  /** Scanned: suppressed 11.9% observed, recognisedShare 0.879, signal +8.1pp. */
  witch: 117,
  /**
   * Scanned too, and against a longer list of targets, because the advisor set
   * has more that can go wrong than a win rate: the crude kept-vs-swapped gap on
   * the confounded card must be large (32.3pp here) while the Mantel-Haenszel
   * estimate collapses (5.7pp), every band must hold BOTH arms or the stratified
   * rung has nothing to combine, and each of the four rungs has to be reachable
   * by the card that was planted to reach it — which means checking that some
   * arms fall SHORT of `KEEP_THRESHOLDS.show` as well as that others clear it.
   * `orderSplit` at 90/2 in the narrow scope is a deliberate failure.
   */
  royal: 207,
  nightmare: 3001,
  elf: 5003,
  dragon: 7001
}

/**
 * Distance between a set's card stream and its context stream.
 *
 * Large and odd rather than 1: mulberry32 decorrelates adjacent seeds perfectly
 * well, but "perfectly well" is a property of the generator and this is a
 * property of the constant, which costs nothing to get right.
 */
export const CTX_STREAM_GAP = 0x9e_37_79_b9

/** `tools/engine/src/fingerprint.rs`: `ALGO_VERSION`, and the 32x36 grey reduction. */
export const ART_ALGO_VERSION = 2
export const ART_VECTOR_BYTES = 32 * 36

// ---------------------------------------------------------------------------
// PURE: randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32. Thirty-two bits of state, one multiply-xor round, uniform enough
 * that a hundred thousand simulated hands land within a tenth of a point of the
 * hypergeometric truth — which is the only property this script needs from it.
 *
 * The rejected alternative was `Math.random()` plus "run it again if it looks
 * odd". That loses the one thing that makes a seeder worth keeping: the user
 * can delete the demo data, re-run, and get the same page back.
 */
export function makeRng(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d_2b_79_f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** `[0, n)`. */
export const randInt = (rng, n) => Math.floor(rng() * n)

/** Pick one element. */
export const pick = (rng, xs) => xs[randInt(rng, xs.length)]

/**
 * Pick one element from `[{ value, weight }]`. Used for opponent classes and
 * modes, which are emphatically not uniform in anybody's real match history —
 * a demo whose matchup table is seven equal bars looks like a bug.
 */
export function pickWeighted(rng, entries) {
  const total = entries.reduce((s, e) => s + e.weight, 0)
  let r = rng() * total
  for (const e of entries) {
    r -= e.weight
    if (r <= 0) return e.value
  }
  return entries[entries.length - 1].value
}

// ---------------------------------------------------------------------------
// PURE: the deck, and drawing from it
// ---------------------------------------------------------------------------

/**
 * `[{ cardId, count }]` -> a flat array with one entry per physical copy.
 *
 * This is the whole reason the deal rates come out right. Drawing uniformly
 * from the 17 DISTINCT cards of a deck gives a 1-of and a 3-of the same chance
 * of turning up, the observed deal rates then disagree violently with the
 * hypergeometric expectation for every card at once, and `dealRateSuspect`
 * lights up on the entire table — which would make the demo worse than no data
 * at all, because the one alarm the page exists to raise would be meaningless.
 */
export function expandDeck(deckList) {
  const pool = []
  for (const entry of deckList) {
    for (let i = 0; i < entry.count; i += 1) pool.push(entry.cardId)
  }
  return pool
}

/**
 * `n` entries from `pool` without replacement.
 *
 * A partial Fisher-Yates over a copy, rather than "draw and retry on
 * collision": with three copies of a card in forty, retry-on-collision is a
 * subtly different distribution and it is the difference the deal-rate check
 * measures.
 */
export function drawWithoutReplacement(rng, pool, n) {
  const rest = pool.slice()
  const drawn = []
  for (let i = 0; i < n && rest.length > 0; i += 1) {
    const j = randInt(rng, rest.length)
    drawn.push(rest[j])
    rest[j] = rest[rest.length - 1]
    rest.pop()
  }
  return { drawn, rest }
}

/**
 * How likely this player is to keep a card of this cost.
 *
 * A readable gradient rather than noise, because the keep-rate column is the
 * one number on the page that is shown at low n (`OPENING_THRESHOLDS.keepRate`
 * is 10), and a column of values scattered around 50% teaches the reviewer
 * nothing about whether the column works. This curve is the usual constructed
 * mulligan instinct: one- and two-drops almost always stay, the top of the
 * curve almost always goes.
 *
 * Cost can be null (a card the master cache has no row for) and can be absurd —
 * deck 43 really does carry a cost-18 card — so this clamps rather than trusts.
 */
export function keepProbability(cost) {
  if (cost == null) return 0.5
  const c = Math.max(0, Math.min(10, cost))
  // 0.93 at cost 0-1, decaying to about 0.10 at cost 8 and above.
  return Math.max(0.08, 0.95 - 0.11 * c)
}

/**
 * Mirror of `REST_BAND_CUTS` in `src/main/ipc/mulligan.ts`. Re-declared for the
 * same reason `DECK_SIZE` is: this file is bare `.mjs` with no transpiler in
 * front of it. If those cut-points ever move, this constant has to move with
 * them or every planted band effect lands in the wrong stratum and the demo
 * quietly stops demonstrating anything.
 */
export const REST_BAND_CUTS = [2.5, 4]
/** Mirror of `REST_BANDS` in `src/shared/openingStats.ts`. */
export const REST_BANDS = 3

/**
 * Which rest-of-hand band a slot sits in, given the costs of the OTHER three
 * slots. A transcription of `restBand` in `src/main/ipc/mulligan.ts`, down to
 * the `< cut` comparison that sends an exact 4.0 into the higher band.
 *
 * It is a transcription rather than an import on purpose, and the duplication is
 * the point of the test that checks the two agree: the generator has to bucket a
 * hand into precisely the bucket the handler will bucket it into, or a planted
 * "80% kept in band 0" effect turns up smeared across two bands and the
 * Mantel-Haenszel demonstration collapses into noise.
 */
export function restBandOf(costs) {
  if (costs.length === 0) return null
  let sum = 0
  for (const cost of costs) {
    if (cost == null || !Number.isFinite(cost)) return null
    sum += cost
  }
  const avg = sum / costs.length
  for (let band = 0; band < REST_BAND_CUTS.length; band += 1) {
    if (avg < REST_BAND_CUTS[band]) return band
  }
  return REST_BANDS - 1
}

/**
 * One hand: four cards dealt, a swap decision per slot, four cards kept.
 *
 * `slot` is stable across the two stages, which is the migration's rule and not
 * an implementation detail: the mulligan panel moves a discarded card into the
 * row above without changing its column, which is how `swapped` is legible
 * without recognising any card at all.
 *
 * `ctx.keepProbFor` is how a set makes the decision depend on something other
 * than the card's own cost — the opponent, the turn order, the rest of the hand.
 * It is given `{ cardId, cost, band, pre }` and returns a probability, or null
 * to mean "no opinion, use the cost curve". Defaulting to the cost curve rather
 * than requiring a model keeps every set that does not care about the advisor
 * (witch, elf, dragon) drawing exactly the hands it drew before.
 *
 * Note the band is computed from the TRUE dealt hand, before the recogniser gets
 * its hands on it. That is the direction of causation — the player saw four real
 * cards and decided — and it also means a planted band effect is not quietly
 * destroyed by a set that nulls slots.
 */
export function generateHand(rng, ctx) {
  const { pool, costOf, keepProbFor = null } = ctx
  const { drawn: pre, rest } = drawWithoutReplacement(rng, pool, HAND_SIZE)

  const costs = pre.map((cardId) => costOf.get(cardId) ?? null)
  const bands = pre.map((_, slot) => restBandOf(costs.filter((_c, i) => i !== slot)))

  const swapped = pre.map((cardId, slot) => {
    const cost = costs[slot]
    const planted = keepProbFor ? keepProbFor({ cardId, cost, band: bands[slot], slot, pre }) : null
    return rng() >= (planted ?? keepProbability(cost))
  })
  const swapCount = swapped.filter(Boolean).length
  const { drawn: replacements } = drawWithoutReplacement(rng, rest, swapCount)

  let taken = 0
  const post = pre.map((cardId, slot) => (swapped[slot] ? replacements[taken++] : cardId))

  return { pre, post, swapped, bands }
}

// ---------------------------------------------------------------------------
// PURE: what the RECOGNISER wrote down, which is not what was dealt
// ---------------------------------------------------------------------------

/**
 * Choose the four cards the witch demo plants its effects on.
 *
 * By rule rather than by hardcoded id, so the script survives the user editing
 * their deck. The rules are arbitrary but deterministic, and the script prints
 * what it picked so the reviewer can check the page against a name.
 *
 *  - `suppressed`  a 3-of whose deal rate will be pushed down to ~12%
 *  - `lowRecog`    a 3-of whose slots are frequently left unnamed
 *  - `signal`      a 3-of carrying a real ~8pp win-rate difference
 *  - `neverDealt`  the most expensive 1-of; simply never reaches a hand
 */
export function choosePlants(deckList) {
  const threes = deckList.filter((e) => e.count >= 3).sort((a, b) => a.cardId - b.cardId)
  const ones = deckList
    .filter((e) => e.count === 1)
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || a.cardId - b.cardId)

  return {
    suppressed: threes[0]?.cardId ?? null,
    lowRecog: threes[1]?.cardId ?? null,
    signal: threes[2]?.cardId ?? null,
    neverDealt: ones[0]?.cardId ?? null
  }
}

/**
 * The dealt hand, as the recogniser recorded it. This is where the demo lies,
 * and it lies in the two ways the real recogniser does.
 *
 * WHY THE SUPPRESSED CARD IS MISREAD RATHER THAN LEFT NULL. The obvious way to
 * simulate "the recogniser keeps missing this card" is to write NULL into its
 * slot. It does not work, and the reason is worth writing down because it is
 * easy to get wrong twice: `eligible` counts matches whose four pre slots are
 * ALL identified, so a NULLed slot removes that match from the numerator AND
 * the denominator of `observedDealRate`. The ratio does not move. The observed
 * deal rate can only fall below the hypergeometric expectation if the slot is
 * named as something ELSE — which is also the honest model of an alternate
 * illustration, since the fingerprint matcher returns a nearest neighbour and
 * not a shrug. So a misread card is recorded as another card from the same
 * deck, chosen round-robin over enough recipients (13 for deck 43) that no
 * recipient's own deal rate moves by more than about a point.
 *
 * WHAT THE NULL SLOTS ARE FOR. Separately, `lowRecog`'s slots really are left
 * NULL, which is what depresses `recognisedShare`. Note — and this is a
 * property of the contract, not of this script — `recognisedShare`'s
 * denominator is "matches where a deck containing this card was attached",
 * which for a single deck is every match in the set. Making one card's slots
 * unreadable therefore pushes the share below 0.9 for EVERY card in that deck,
 * not just for that one. That is what the page will show, and it is arguably
 * the right answer: an incomplete hand is incomplete for everybody in it.
 */
export function recordHand(rng, hand, plan) {
  const recipients = plan.substituteInto ?? []
  const pre = hand.pre.map((cardId) => ({ cardId, artVector: false }))

  for (let slot = 0; slot < pre.length; slot += 1) {
    const cardId = pre[slot].cardId

    // The unreadable card: a genuinely unnamed slot, and if the demo wants to
    // show `pendingRetry` it also carries the fingerprint that will name it.
    if (cardId === plan.lowRecog && rng() < (plan.lowRecogNullRate ?? 0)) {
      pre[slot] = { cardId: null, artVector: plan.keepArtVector === true }
      continue
    }

    // The alternate illustration: named, confidently, as the wrong card.
    if (cardId === plan.suppressed && recipients.length > 0 && rng() < (plan.suppressRate ?? 0)) {
      pre[slot] = { cardId: pick(rng, recipients), artVector: false }
      continue
    }

    // Everything else: the whole hand may be partly unreadable (the dragon set
    // exists to show this), independently of any particular card.
    if (rng() < (plan.slotNullRate ?? 0)) {
      pre[slot] = { cardId: null, artVector: plan.keepArtVector === true }
    }
  }

  // The post row is the same recognition applied to the kept/replaced hand. A
  // slot whose pre reading was unnamed stays unnamed when the card was kept —
  // the recogniser did not get a second look at it, it is the same picture.
  const post = hand.post.map((cardId, slot) => {
    const keptSameCard = !hand.swapped[slot]
    if (keptSameCard) return { cardId: pre[slot].cardId, artVector: pre[slot].artVector }
    if (
      rng() < (plan.slotNullRate ?? 0) ||
      (cardId === plan.lowRecog && rng() < (plan.lowRecogNullRate ?? 0))
    ) {
      return { cardId: null, artVector: plan.keepArtVector === true }
    }
    return { cardId, artVector: false }
  })

  return { pre, post, swapped: hand.swapped }
}

// ---------------------------------------------------------------------------
// PURE: matches
// ---------------------------------------------------------------------------

/** The vocabulary actually stored in this database — checked, not guessed. */
export const CLASSES = ['elf', 'royal', 'witch', 'dragon', 'bishop', 'nightmare', 'nemesis']

/**
 * Opponent-class weights, copied from the shape of the user's real 354 matches
 * (royal 97, nightmare 61, bishop 59, witch 56, dragon 46, nemesis 20, elf 15).
 * Demo data whose matchup spread contradicts the real data next to it in the
 * same table reads as corruption rather than as a demo.
 */
export const OPPO_WEIGHTS = [
  { value: 'royal', weight: 97 },
  { value: 'nightmare', weight: 61 },
  { value: 'bishop', weight: 59 },
  { value: 'witch', weight: 56 },
  { value: 'dragon', weight: 46 },
  { value: 'nemesis', weight: 20 },
  { value: 'elf', weight: 15 }
]

/**
 * Modes for a match that HAS a deck attached.
 *
 * `twoPick` is deliberately absent: `isDecklessMode` in `src/shared/domain.ts`
 * says a 2Pick match has no deck by construction, the UI does not offer the
 * field, and the write path strips it. A seeded 2Pick match with a deck id
 * would be a row the app itself considers impossible.
 */
export const DECK_MODES = [
  { value: 'ranked', weight: 111 },
  { value: 'unranked', weight: 43 },
  { value: 'cpu', weight: 53 },
  { value: 'custom', weight: 26 },
  { value: 'weekendPlaza', weight: 4 }
]

/** Modes for a deckless set. This is where `twoPick` belongs, and dominates. */
export const DECKLESS_MODES = [
  { value: 'twoPick', weight: 96 },
  { value: 'ranked', weight: 20 },
  { value: 'cpu', weight: 12 }
]

/** Six months back from `now`, in milliseconds. Date filters need something to bite on. */
export const SPREAD_MS = 183 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// PURE: the mulligan advisor fixture
//
// Everything in this block exists to fill ONE cell shape on 換牌建議: a single
// card, against a single opponent class, at a single turn order, inside a single
// rest-of-hand band, with enough observations on BOTH sides of the keep/swap
// split to clear `KEEP_THRESHOLDS`. Nothing else on either page needs this much
// care, and the arithmetic for why it needs this many matches is at
// `ADVISOR_MATCHES`.
// ---------------------------------------------------------------------------

/**
 * The class whose matches carry the advisor fixture.
 *
 * Royal rather than witch, and the reason is the cost curve. The user's real
 * deck 43 ("witch go") averages 4.875 mana across its forty cards, so the mean
 * of any three of them is almost always at or above 4.0 — every hand lands in
 * band 2, the other two strata stay empty, `mantelHaenszelDiff` gets one
 * stratum, and the adjusted estimate becomes the crude one wearing a different
 * name. A demonstration of stratification needs strata.
 *
 * So the advisor set gets a purpose-built list with a known curve. The rejected
 * alternative was to reuse a real deck and hope: it keeps the "reuse first"
 * rule that the rest of this script follows, and it buys a fixture whose most
 * important property depends on a deck the user can edit at any time.
 */
export const ADVISOR_CLASS = 'royal'

/**
 * The opponent the advisor fixture is about.
 *
 * One class has to dominate, because the narrow rungs of the ladder are
 * per-opponent and splitting 1200 matches across seven classes the way
 * `OPPO_WEIGHTS` does would leave the biggest matchup with ~330 matches, ~165
 * per turn order, and a 3-of showing 49 copies before the keep/swap split — not
 * enough for `sort` on both arms. A player who has been grinding one matchup is
 * also a perfectly ordinary thing to be.
 */
export const ADVISOR_PRIMARY_OPPO = 'dragon'

/** Half the advisor set is the primary matchup; the rest is a plausible tail. */
export const ADVISOR_OPPO_WEIGHTS = [
  { value: ADVISOR_PRIMARY_OPPO, weight: 50 },
  { value: 'nightmare', weight: 12 },
  { value: 'bishop', weight: 10 },
  { value: 'witch', weight: 10 },
  { value: 'royal', weight: 8 },
  { value: 'nemesis', weight: 6 },
  { value: 'elf', weight: 4 }
]

/**
 * Which opponents count as "fast" for the opponent-dependent keep plants.
 *
 * Arbitrary but not random: these are the three classes whose usual builds
 * punish a slow hand, which is the premise the advisor exists to measure. It is
 * a demo fixture, not a metagame claim, and nothing outside this file reads it.
 */
export const ADVISOR_FAST_CLASSES = new Set(['elf', 'royal', 'nemesis'])

/**
 * How many matches the advisor set writes, and the arithmetic that fixes it.
 *
 *   a 3-of is 3 of 40 cards, so a four-card hand holds 4 × 3/40 = 0.30 copies
 *   of it on average (the familiar 27.7% is P(at least one hand), which is the
 *   wrong unit here — `mulligan.ts` counts copies).
 *
 *   1200 matches
 *     × 0.50 against `ADVISOR_PRIMARY_OPPO`      =  600
 *     × 0.50 on one turn order                   =  300   ← the narrowest scope
 *     × 0.30 copies of a 3-of per hand           =   90 copies
 *     × a ~50/50 keep split                      =   45 kept / 45 swapped
 *
 * 45 clears `KEEP_THRESHOLDS.sort` (30) on both arms with half again to spare,
 * which is what "sortable for at least a few cards" costs. Split those 90 copies
 * across the three bands (~25 / ~50 / ~25 for the curve below) and the
 * stratified rung still holds ~22 / ~45 / ~22, so every band contributes a real
 * comparison rather than a one-armed one that has to be dropped.
 *
 * Halving this to 600 would leave 22/22 per arm — past `show` (12), short of
 * `sort` — and the page would never draw a sorted advisor table, which is the
 * state most worth reviewing. The cost of the extra 600 is ~4800 more
 * `MatchOpeningCard` rows, which SQLite does not notice.
 */
export const ADVISOR_MATCHES = 1200

/**
 * What each planted card is for, in the order the roles are assigned.
 *
 * Roles are attached to real cards BY RULE (see `chooseAdvisorPlants`), never by
 * hardcoded id, so the fixture survives the card master cache changing under it.
 * The `shows` strings are printed by the dry run, so a reviewer can put a name
 * against each row of the advisor page without reading this file.
 */
export const ADVISOR_PLANT_RULES = [
  {
    role: 'confounded',
    // Deliberately a five-drop: "do I keep this when the rest of my hand is
    // cheap" is the actual question a five-drop poses, so the confounding here
    // is the real thing rather than an arrangement of numbers.
    threeOfIndex: 8,
    shows: 'crude gap ~32pp that Mantel-Haenszel collapses to ~6pp — bands disagree'
  },
  {
    role: 'trueKeep',
    threeOfIndex: 5,
    shows: 'a REAL keep effect: ~+19pp, flat across bands, survives adjustment'
  },
  // The planted gap is 30pp (0.68 kept against 0.38 swapped), not 22. The
  // difference is dilution: `advisorWinProbability` resolves by priority, and
  // the ~27% of this card's hands that also hold `confounded` take their result
  // from that card's model instead, which is uncorrelated with this one's keep
  // decision. 30pp × 0.73 lands where the row claims to land.
  {
    role: 'oppoFast',
    threeOfIndex: 2,
    shows: 'kept 85% vs fast classes, 25% vs slow — opponent-dependent'
  },
  {
    role: 'oppoSlow',
    threeOfIndex: 9,
    shows: 'the mirror: kept 25% vs fast, 82% vs slow'
  },
  {
    role: 'bandSplit',
    threeOfIndex: 7,
    shows: "always kept in bands 0-1, never in band 2 → no stratum → 'turn-order'"
  },
  {
    role: 'orderSplit',
    threeOfIndex: 6,
    shows: "kept 95% on the play, 15% on the draw → narrow arm empty → 'opponent'"
  },
  {
    role: 'oppoOneSided',
    threeOfIndex: 3,
    shows: "kept 97% vs the primary matchup only → 'all-opponents'"
  },
  {
    role: 'alwaysKept',
    oneOfIndex: 0,
    shows: "kept ~95%: swapped arm never fills, row is correctly 'hidden'"
  }
]

/**
 * Attach every role in `ADVISOR_PLANT_RULES` to a card of the given deck list.
 *
 * Indices into the cost-sorted 3-ofs (and 1-ofs), not card ids, so two runs
 * agree and so the fixture still works on a deck list this script did not build.
 * Indices wrap, because a caller may hand this a shorter list — a duplicate role
 * on one card degrades the demo, whereas a crash in a seeder does not degrade
 * anything, it just stops.
 */
export function chooseAdvisorPlants(deckList) {
  const byCost = (a, b) => (a.cost ?? 0) - (b.cost ?? 0) || a.cardId - b.cardId
  const threes = deckList.filter((e) => e.count >= 3).sort(byCost)
  const ones = deckList.filter((e) => e.count === 1).sort(byCost)

  const out = {}
  for (const rule of ADVISOR_PLANT_RULES) {
    const source = rule.threeOfIndex == null ? ones : threes
    const index = rule.threeOfIndex ?? rule.oneOfIndex
    out[rule.role] = source.length === 0 ? null : source[index % source.length].cardId
  }
  return out
}

/**
 * The keep probability for one slot of one advisor hand.
 *
 * Returns null for a card with no role, which sends the caller back to the
 * ordinary cost curve — most of the deck should still behave like a deck, or the
 * keep-rate column on 起手 would turn into a list of eight planted constants.
 *
 * The three one-sided plants (`orderSplit`, `oppoOneSided`, `alwaysKept`) are
 * how the fallback ladder gets exercised, and it is worth being explicit that
 * they work by STARVING the narrow arm rather than by having few observations.
 * That is the failure the ladder was designed for: plenty of data, all of it on
 * one side of the question, so the honest thing is to step outward and say so.
 * The alternative — simply seeding fewer matches against some opponent — would
 * have exercised the same code path for the boring reason and taught the
 * reviewer nothing about why `basis` is on the row.
 */
export function advisorKeepProbability(plants, ctx) {
  const { cardId, band, oppoClass, playOrder } = ctx
  const fast = ADVISOR_FAST_CLASSES.has(oppoClass)

  switch (cardId) {
    case plants.confounded:
      // The engine of the whole demonstration. Keeping is strongly predicted by
      // the rest of the hand, and (see `advisorWinProbability`) so is winning.
      // The crude comparison therefore compares mostly-band-0 keeps against
      // mostly-band-2 swaps, which is two different populations wearing one
      // card's name.
      return band == null ? 0.5 : [0.85, 0.5, 0.15][band]
    case plants.trueKeep:
      // Flat on purpose. Its effect has to survive adjustment, so nothing about
      // the decision may correlate with the band.
      return 0.5
    case plants.oppoFast:
      return fast ? 0.85 : 0.25
    case plants.oppoSlow:
      // 0.82 rather than a symmetric 0.85: at 0.85 the swapped arm against the
      // primary matchup lands near 13 copies, one unlucky draw from falling
      // under `show` (12) and turning a deliberate demo row into a dash.
      return fast ? 0.25 : 0.82
    case plants.bandSplit:
      // Deterministic, which is the whole trick: band 0 and band 1 hold keeps
      // only, band 2 holds swaps only, so NO band offers both arms, `mh` is
      // null, and the stratified rung has nothing to return. This is the one
      // plant that is not a probability at all.
      return band == null ? 0.5 : band <= 1 ? 1 : 0
    case plants.orderSplit:
      return playOrder === 'first' ? 0.95 : 0.15
    case plants.oppoOneSided:
      return oppoClass === ADVISOR_PRIMARY_OPPO ? 0.97 : 0.5
    case plants.alwaysKept:
      return 0.95
    default:
      return null
  }
}

/**
 * The match result model for the advisor set.
 *
 * ONE match has ONE result, so when two planted cards are in the same hand
 * something has to win. They are resolved by priority rather than combined,
 * and the order is `confounded` first because its shape (a crude gap that the
 * adjustment destroys) is the thing the page most needs to be able to show, and
 * because it has the most room to lose: a ~40pp crude difference survives being
 * diluted in the ~8% of hands that hold both plants, whereas `trueKeep`'s ~22pp
 * has less to spare.
 *
 * The rejected alternative was to combine the effects additively on the
 * probability scale. It reads better in the abstract and it clips: two plants
 * both pushing up from a 0.5 base run past 1.0, and the clipping lands
 * disproportionately on exactly the hands that hold both cards, which
 * reintroduces a correlation between the two plants that neither of them asked
 * for.
 *
 * Hands holding neither plant sit at the base rate, so the set's own baseline is
 * not itself a planted number.
 */
export function advisorWinProbability(plants, hand, baseWinP) {
  const slotOf = (cardId) => hand.pre.indexOf(cardId)

  const cf = slotOf(plants.confounded)
  if (cf >= 0) {
    const kept = !hand.swapped[cf]
    const band = hand.bands[cf] ?? 1
    // The shape `tests/main/mulligan.test.ts` uses to produce a crude 41.7
    // against an adjusted 5.0: a five-point kept-over-swapped edge inside every
    // band, and a colossal band-to-band difference that the crude comparison
    // mistakes for it.
    return [
      [0.75, 0.8],
      [0.48, 0.52],
      [0.2, 0.25]
    ][band][kept ? 1 : 0]
  }

  const tk = slotOf(plants.trueKeep)
  if (tk >= 0) return hand.swapped[tk] ? 0.38 : 0.68

  return baseWinP
}

/**
 * One class's worth of demo matches.
 *
 * `opts` carries everything: how many, which class, which deck (or none), the
 * pool to draw from, the cost lookup, the recognition plan and the win-rate
 * model. It returns plain objects; nothing here knows SQLite exists.
 */
export function generateMatches(opts) {
  const {
    rng,
    count,
    myClass,
    deckId = null,
    deckList = [],
    plan = {},
    now,
    baseWinP = 0.52,
    signalDealtWinP = null,
    signalNotDealtWinP = null,
    oppoWeights = OPPO_WEIGHTS,
    advisorPlants = null,
    // A SECOND stream, for the facts about a match that are not its cards: who
    // the opponent was, who went first, which queue it was. Splitting the two is
    // not tidiness. The advisor needs the opponent and the turn order BEFORE it
    // can decide whether a card was kept, so those draws had to move ahead of
    // the hand — and on one shared stream that reordering would have reshuffled
    // every hand in the witch set too, discarding the seed scan recorded at
    // `DEMO_SEED` and the realised figures the 起手 demo was tuned to. Two
    // independent streams make the two questions independent, which they are.
    ctxRng = rng
  } = opts

  const costOf = new Map(deckList.map((e) => [e.cardId, e.cost ?? null]))

  // The never-dealt card is removed from the physical pool rather than misread
  // on the way out. Misreading it would have worked too, but it would have
  // added a second stream of substitutions into the other cards' deal rates for
  // no gain — and "this card is in the deck and has simply never turned up" is
  // exactly the state `'never-dealt'` names, so modelling it as a card that
  // never gets drawn is also the more honest story.
  const fullPool = expandDeck(deckList)
  const pool = plan.neverDealt == null ? fullPool : fullPool.filter((id) => id !== plan.neverDealt)

  const modes = deckId == null ? DECKLESS_MODES : DECK_MODES
  const matches = []

  for (let i = 0; i < count; i += 1) {
    // Context first, cards second. See `ctxRng` above for why these three come
    // off a different stream than everything below them.
    const playOrder = ctxRng() < 0.5 ? 'first' : 'second'
    const oppoClass = pickWeighted(ctxRng, oppoWeights)
    const mode = pickWeighted(ctxRng, modes)

    const keepProbFor = advisorPlants
      ? (slotCtx) => advisorKeepProbability(advisorPlants, { ...slotCtx, oppoClass, playOrder })
      : null

    const hand = pool.length >= HAND_SIZE ? generateHand(rng, { pool, costOf, keepProbFor }) : null
    const recorded = hand ? recordHand(rng, hand, plan) : null

    // The win rate is computed from the TRUE hand, not the recorded one. That
    // is the direction of causation — the card that was really there is the one
    // that could have affected the game — and it also means the planted signal
    // survives the recogniser's mistakes rather than being defined by them.
    let winP = baseWinP
    if (plan.signal != null && signalDealtWinP != null && signalNotDealtWinP != null && hand) {
      winP = hand.pre.includes(plan.signal) ? signalDealtWinP : signalNotDealtWinP
    }
    if (advisorPlants && hand) winP = advisorWinProbability(advisorPlants, hand, baseWinP)

    const playedAt = Math.round(now - rng() * SPREAD_MS)
    const durationTime = 90 + randInt(rng, 480)
    const d = new Date(playedAt)

    matches.push({
      result: rng() < winP ? 1 : 0,
      play_order: playOrder,
      my_class: myClass,
      oppo_class: oppoClass,
      my_deckId: deckId,
      mode,
      playedAt,
      endedAt: playedAt + durationTime * 1000,
      durationTime,
      // Local-calendar fields, the way the app writes them.
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      source: DEMO_SOURCE,
      openingCards: recorded ? buildOpeningRows(rng, recorded) : []
    })
  }

  return matches
}

/**
 * The eight `MatchOpeningCard` rows for one hand.
 *
 * `swapped` is set on the `pre` rows only, which is the migration's rule: the
 * post row describes the hand that was played, and "was this thrown away" is
 * not a question about it.
 */
export function buildOpeningRows(rng, recorded) {
  const rows = []
  for (let slot = 0; slot < HAND_SIZE; slot += 1) {
    for (const stage of ['pre', 'post']) {
      const cell = stage === 'pre' ? recorded.pre[slot] : recorded.post[slot]
      rows.push({
        stage,
        slot,
        cardId: cell.cardId,
        // 0.7-0.99, the band the art matcher actually reports when it commits.
        confidence: cell.cardId == null ? null : Math.round((0.7 + rng() * 0.29) * 1000) / 1000,
        swapped: stage === 'pre' ? (recorded.swapped[slot] ? 1 : 0) : null,
        decidedBy: cell.cardId == null ? null : 'art-portal',
        artVector: cell.cardId == null && cell.artVector ? makeArtVector(rng) : null,
        artAlgoVersion: cell.cardId == null && cell.artVector ? ART_ALGO_VERSION : null
      })
    }
  }
  return rows
}

/**
 * A 1152-byte fingerprint-shaped blob.
 *
 * Not a real fingerprint of anything — no retry pass will ever match it against
 * a reference, which is the point: these slots must stay pending so the summary
 * has a non-zero `pendingRetry` to render. Bytes come from the seeded RNG so
 * two runs produce the same blob.
 */
export function makeArtVector(rng) {
  const buf = Buffer.alloc(ART_VECTOR_BYTES)
  for (let i = 0; i < ART_VECTOR_BYTES; i += 1) buf[i] = randInt(rng, 256)
  return buf
}

/**
 * The whole demo, as plain objects. One RNG threaded through every set in a
 * fixed order, so the output is a function of `DEMO_SEED` and nothing else.
 *
 * `sets` is the matrix, and each entry says which page state it exists to show.
 */
export function generateAll(opts) {
  const { decks, now, seed = DEMO_SEED } = opts
  const out = []

  // One stream per set, rather than one stream threaded through all of them.
  //
  // The old arrangement was a single `makeRng(DEMO_SEED)` handed to each set in
  // turn, which has a property nobody wants: every set is downstream of every
  // earlier set's exact number of random draws. Adding the royal set below, and
  // moving three draws onto the context stream, both silently reshuffled the
  // witch hands — and the witch set is the one whose realised figures were
  // scanned for (`DEMO_SEED`). One stream per set makes the sets independent,
  // so the next person to add a cohort does not have to re-check this one's
  // numbers, and so a single set's offset can be tuned without touching the
  // others.
  const rngFor = (label) => makeRng((seed + (SET_SEED_OFFSETS[label] ?? 0)) >>> 0)
  // The context stream: who the opponent was, who went first, which queue. See
  // `ctxRng` in `generateMatches` for why this is separate from the cards.
  const ctxFor = (label) => makeRng((seed + (SET_SEED_OFFSETS[label] ?? 0) + CTX_STREAM_GAP) >>> 0)
  const rng = rngFor('witch')
  const ctxRng = ctxFor('witch')

  // ---- witch: everything unlocked, and every planted anomaly ----
  const witch = decks.witch
  const witchPlants = witch ? choosePlants(witch.deckList) : {}
  const witchPlan = {
    ...witchPlants,
    // Tuned, not derived: a 3-of that is dealt in 28.4% of hands (39 cards, since
    // the never-dealt 1-of is out of the pool) and is misread this often lands at
    // the ~12% observed rate the user asked to see. The closed form is messy
    // because a 3-of can arrive twice and both copies have to be misread, so
    // this was measured over 200k simulated hands rather than solved.
    suppressRate: 0.62,
    // A 3-of reaches 27.7% of hands; unreadable 45% of those times leaves about
    // 12.5% of hands incomplete, which puts `recognisedShare` near 0.875 —
    // under `OPENING_THRESHOLDS.recognisedShare` (0.9) with room to spare.
    lowRecogNullRate: 0.45,
    keepArtVector: false,
    substituteInto: witch
      ? witch.deckList
          .map((e) => e.cardId)
          .filter(
            (id) =>
              id !== witchPlants.suppressed &&
              id !== witchPlants.lowRecog &&
              id !== witchPlants.signal &&
              id !== witchPlants.neverDealt
          )
      : []
  }
  if (witch) {
    out.push({
      label: 'witch',
      shows: "everything unlocked, incl. 'sortable' difference rows",
      matches: generateMatches({
        rng,
        ctxRng,
        count: 420,
        myClass: 'witch',
        deckId: witch.deckId,
        deckList: witch.deckList,
        plan: witchPlan,
        now,
        // A 3-of is dealt in ~28% of 420 hands: ~118 dealt against ~302 not,
        // both arms clear `wrSort` (50), so the comparison column is sortable
        // and has a real 8pp difference in it rather than noise.
        signalDealtWinP: 0.575,
        signalNotDealtWinP: 0.495
      }),
      plants: witchPlants
    })
  }

  // ---- royal: the 換牌建議 fixture ----
  //
  // The big one, and the only set whose size is derived rather than chosen — see
  // `ADVISOR_MATCHES`. Its recognition plan is deliberately EMPTY: the advisor
  // drops any hand whose four pre slots are not all named (the rest-of-hand band
  // is undefined without the fourth card), so a single nulled slot costs four
  // copies rather than one, and a `slotNullRate` of even 0.05 would quietly
  // remove ~19% of the hands this set exists to provide. The unreadable-slot
  // states are demonstrated by the dragon set, where they cost nothing.
  const advisor = decks[ADVISOR_CLASS]
  const advisorPlants = advisor ? chooseAdvisorPlants(advisor.deckList) : null
  if (advisor) {
    out.push({
      label: ADVISOR_CLASS,
      shows: '換牌建議: every rung, a real effect, a confounded one, a hidden one',
      matches: generateMatches({
        rng: rngFor(ADVISOR_CLASS),
        ctxRng: ctxFor(ADVISOR_CLASS),
        count: ADVISOR_MATCHES,
        myClass: ADVISOR_CLASS,
        deckId: advisor.deckId,
        deckList: advisor.deckList,
        now,
        oppoWeights: ADVISOR_OPPO_WEIGHTS,
        advisorPlants,
        // Only reached by hands holding neither of the two win-effect plants.
        baseWinP: 0.5
      }),
      advisorPlants
    })
  }

  // ---- nightmare: past `wrShow` (20), short of `wrSort` (50) ----
  //
  // This set used to be 25 matches and used to be the "below every threshold"
  // one; royal was the middle state. Royal is now 1200 matches and clears
  // everything, so the middle state moved here, and the tiny-sample state is
  // covered by the 8-match dragon set below. Both states are still on the page;
  // only which class carries them changed.
  if (decks.nightmare) {
    out.push({
      label: 'nightmare',
      shows: "'shown' but not 'sortable' — the middle confidence state",
      matches: generateMatches({
        rng: rngFor('nightmare'),
        ctxRng: ctxFor('nightmare'),
        count: 90,
        myClass: 'nightmare',
        deckId: decks.nightmare.deckId,
        deckList: decks.nightmare.deckList,
        now
      })
    })
  }

  // ---- elf: real hands, but no deck to compare them against ----
  //
  // `deckId: null` with a REAL `deckList`, and the split between those two is
  // the entire point of this set. The first version of this passed no deck list
  // either, on the theory that "we do not know what was in the deck" should
  // mean no hand. That was wrong, and wrong in a way that made the set useless:
  // a match with no `MatchOpeningCard` rows is invisible to the page — it does
  // not reach the `'no-deck'` branch, it is simply not counted. The state worth
  // demonstrating is the opposite and much more interesting one: the panel WAS
  // read, all four cards WERE named, and the page still cannot say a word about
  // deal rates because nothing records what the other 36 cards were.
  //
  // So these hands are drawn hypergeometrically from a 40-card elf pseudo-deck
  // assembled in memory from the user's real `Card` rows (see
  // `buildClassDrawPool`). That list is a DRAW SOURCE AND NOTHING ELSE. It is
  // never inserted, no elf `Deck` row is created, and `my_deckId` stays NULL —
  // it exists only so the cards in the hands are coherent elf cards rather than
  // a random scatter across seven classes.
  //
  // The result in the table should be a readable `keepRate` (which needs only
  // recognition) sitting beside a null `copies`, `expectedDealRate`,
  // `observedDealRate` and `dealtWr`, with `missing === 'no-deck'`. That
  // contrast is what the set is for.
  out.push({
    label: 'elf',
    shows: "'no-deck': hands are readable, deal rates are not",
    matches: generateMatches({
      rng: rngFor('elf'),
      ctxRng: ctxFor('elf'),
      count: 40,
      myClass: 'elf',
      deckId: null,
      deckList: decks.elf?.deckList ?? [],
      now
    })
  })

  // ---- dragon: tiny sample, and a third of the slots still waiting for a name ----
  if (decks.dragon) {
    out.push({
      label: 'dragon',
      shows: "tiny sample, plus 'unidentified' slots and a non-zero pendingRetry",
      matches: generateMatches({
        rng: rngFor('dragon'),
        ctxRng: ctxFor('dragon'),
        count: 8,
        myClass: 'dragon',
        deckId: decks.dragon.deckId,
        deckList: decks.dragon.deckList,
        plan: { slotNullRate: 0.3, keepArtVector: true },
        now
      })
    })
  }

  // bishop and nemesis get nothing, on purpose: the completely-empty per-class
  // state is one of the states the user asked to review, and the only way to
  // review it is for the seeder to refuse to fill it in.

  return out
}

// ---------------------------------------------------------------------------
// --- SQLITE --- everything below this line touches the disk.
// ---------------------------------------------------------------------------

/** `%APPDATA%\svwb-analyzer\db\app.db`, the path the installed app uses. */
export function defaultDbPath() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA is not set; pass --db <path> explicitly.')
  return path.join(appData, 'svwb-analyzer', 'db', 'app.db')
}

/**
 * Is the app holding this database open?
 *
 * Cheap and best-effort. A hot `-wal` proves nothing on its own (SQLite leaves
 * one behind after a clean exit), and a lock probe proves nothing either
 * because Electron does not sit inside a write transaction. So this asks the
 * process table, which is the only source here that actually knows. It returns
 * a list of reasons rather than a boolean so the refusal can say WHICH process.
 *
 * A failure to run `tasklist` is not treated as "not running" — it is reported
 * as "could not tell", and the caller decides.
 */
export function detectRunningApp() {
  const names = ['SVWB Analyzer.exe', 'electron.exe']
  const found = []
  for (const name of names) {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true
      })
      if (out.toLowerCase().includes(name.toLowerCase())) found.push(name)
    } catch {
      return { known: false, found: [] }
    }
  }
  return { known: true, found }
}

/**
 * A consistent copy beside the original, named like the backups already there
 * (`app.2026-08-26T08-28-49-605Z.bak.db`) with `pre-demo-seed` in the middle so
 * the user can tell at a glance which one this script made.
 *
 * `db.backup()` rather than `fs.copyFile`: this database runs in WAL mode with
 * a four-megabyte `-wal` beside it, and copying the main file alone would
 * produce a "backup" missing every recent match — the single worst possible
 * failure for a file whose entire job is to be the safety net. SQLite's own
 * backup API checkpoints into the destination and gives one self-contained
 * file.
 */
export async function backupDatabase(Database, dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(path.dirname(dbPath), `app.${stamp}.pre-demo-seed.bak.db`)
  const src = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    await src.backup(dest)
  } finally {
    src.close()
  }
  const size = fs.statSync(dest).size
  if (size <= 0) throw new Error(`backup at ${dest} is empty`)
  return { dest, size }
}

/**
 * Which decks the demo can use, and which it has to invent.
 *
 * REUSE FIRST, ALWAYS. `docs/deck-versioning-plan.md` records that the Deck
 * family's `ON DELETE SET NULL` fires the sync-outbox triggers, so every Deck
 * row this script creates is a row whose removal has to be thought about.
 * (This database currently has no triggers at all — `sqlite_master` has zero
 * `type='trigger'` rows — but the plan says they are coming back, and a seeder
 * that is only safe against today's schema is not safe.)
 *
 * The user has six decks and exactly ONE of them has a card list: deck 43,
 * "witch go", 17 rows summing to 40. The other five are empty shells. So witch
 * reuses a real deck and royal/nightmare/dragon cannot — there is no royal,
 * nightmare or dragon deck in this database at all, let alone one with cards.
 * Those three are built from the user's real `Card` rows, tagged twice (a
 * `[demo]` name prefix they can see, `sourceRef = 'demo-seed'` the remover
 * keys on) and deleted by `--remove`.
 */
export function planDecks(db) {
  const classesNeedingDecks = ['witch', 'royal', 'nightmare', 'dragon']
  const out = {}
  const reused = []
  const toCreate = []

  for (const className of classesNeedingDecks) {
    // The advisor class is the one exception to "reuse first", and it is an
    // exception on purpose rather than an oversight. The fixture's most
    // important property — that all three rest-of-hand bands are populated — is
    // a property of the deck's COST CURVE, and a deck the user owns and can edit
    // has whatever curve it has. See `ADVISOR_CLASS`. So this class always gets
    // a `[demo]`-tagged list built to a known curve, which `--remove` deletes.
    if (className === ADVISOR_CLASS) {
      const deckList = buildAdvisorDeckList(db, className)
      out[className] = { deckId: null, deckName: `[demo] ${className}`, deckList, created: true }
      toCreate.push({ className, cards: deckList.reduce((s, e) => s + e.count, 0) })
      continue
    }

    const row = db
      .prepare(
        `SELECT d.id, d.name,
                (SELECT COALESCE(SUM(count), 0) FROM DeckCard c WHERE c.deckId = d.id) AS cards
         FROM Deck d
         WHERE d.class = ? AND d.archivedAt IS NULL AND d.sourceRef IS NOT ?
         ORDER BY cards DESC, d.isDefault DESC, d.id DESC
         LIMIT 1`
      )
      .get(className, DEMO_DECK_REF)

    if (row && row.cards >= DECK_SIZE) {
      const deckList = db
        .prepare(
          `SELECT dc.cardId, dc.count, c.cost
           FROM DeckCard dc LEFT JOIN Card c ON c.cardId = dc.cardId
           WHERE dc.deckId = ?
           ORDER BY dc.cardId`
        )
        .all(row.id)
      out[className] = { deckId: row.id, deckName: row.name, deckList, created: false }
      reused.push({ className, deckId: row.id, name: row.name, cards: row.cards })
    } else {
      const deckList = buildDemoDeckList(db, className)
      out[className] = { deckId: null, deckName: `[demo] ${className}`, deckList, created: true }
      toCreate.push({ className, cards: deckList.reduce((s, e) => s + e.count, 0) })
    }
  }

  // The elf set is the odd one out and must stay that way. It gets a card list
  // so its hands can be drawn, and NO deck — `deckId: null`, `created: false`,
  // so `insertDemoDecks` skips it and `my_deckId` is written NULL. `drawOnly`
  // is what every other part of this file keys on to remember the difference;
  // without it the summary would cheerfully report a deck the database does not
  // have, which is exactly how the first version of this hid its own bug.
  out.elf = {
    deckId: null,
    deckName: '— none (draw source only) —',
    deckList: buildClassDrawPool(db, 'elf'),
    created: false,
    drawOnly: true
  }

  return { decks: out, reused, toCreate }
}

/** The portal's `class_id`, from `src/shared/deckImport.ts`. Order matters; do not index an array. */
export const CLASS_NAME_TO_ID = {
  elf: 1,
  royal: 2,
  witch: 3,
  dragon: 4,
  nightmare: 5,
  bishop: 6,
  nemesis: 7
}

/**
 * Forty cards of a class, from the user's real `Card` rows.
 *
 * `profile` says how many copies of each distinct card, spread across the cost
 * curve by taking evenly spaced entries from the cost-sorted class list. It is
 * not a deck anyone would play. It does not need to be: its only job is to be
 * a 40-card multiset with a
 * believable curve and a couple of singletons, so the hypergeometric maths and
 * the cost-keyed keep rate both have something real to chew on.
 *
 * Real card ids, never invented ones, because a `MatchOpeningCard.cardId` with
 * no `Card` row renders as `#10573310` and would make the demo page look broken
 * rather than empty.
 */
export function buildDemoDeckList(db, className, profile = DEMO_DECK_PROFILE, neutralRows = 0) {
  const cards = classCards(db, className, NEUTRAL_CLASS_ID, false)
  const neutrals = classCards(db, className, NEUTRAL_CLASS_ID, true)

  if (cards.length < profile.length) {
    throw new Error(`only ${cards.length} usable cards for class ${className}`)
  }

  // Neutrals go in the LAST `neutralRows` entries, which the profiles order as
  // singletons. That is where they sit in a real list: the user's own deck 43
  // carries three neutral cards out of forty, two of one and one of another.
  // Spreading them evenly instead would have made ~39% of every hand neutral,
  // because the class pool (106 cards) and the neutral pool (69) are close
  // enough in size that even sampling all but ignores the distinction — which
  // is what the first version did, and it made elf hands look like nobody's
  // deck.
  const step = cards.length / profile.length
  const neutralStep = neutrals.length / Math.max(1, neutralRows)
  const firstNeutral = profile.length - neutralRows

  return profile.map((count, i) => {
    const card =
      i >= firstNeutral
        ? neutrals[Math.floor((i - firstNeutral) * neutralStep)]
        : cards[Math.floor(i * step)]
    return {
      cardId: card.cardId,
      count: Math.min(count, card.deckEnabledNum ?? 3),
      cost: card.cost
    }
  })
}

/** Twelve 3-ofs and four 1-ofs. Sums to 40. Used for decks that get INSERTED. */
export const DEMO_DECK_PROFILE = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1]

/**
 * Seven 3-ofs, four 2-ofs, eleven 1-ofs. Also sums to 40, but across 22 rows
 * rather than 16, so a hand drawn from it holds a believable spread of
 * singletons and playsets instead of looking like four copies of the same four
 * cards. Used for pools that are NEVER inserted.
 */
export const CLASS_POOL_PROFILE = [3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]

/**
 * A 40-card list for a class that exists ONLY to be drawn from.
 *
 * Same construction as `buildDemoDeckList` and a deliberately different name,
 * because the difference between the two is not their contents — it is that
 * this one must never reach the database. It is what lets the elf set have real
 * hands while `my_deckId` stays NULL. If you find yourself passing the result
 * of this to `insertDemoDecks`, the elf set has stopped demonstrating anything.
 *
 * Neutral cards are included here where `buildDemoDeckList` leaves them out:
 * a pool is meant to look like what a player actually opens, and the user's own
 * deck 43 carries two neutral cards out of seventeen rows.
 */
export function buildClassDrawPool(db, className) {
  return buildDemoDeckList(db, className, CLASS_POOL_PROFILE, POOL_NEUTRAL_ROWS)
}

/** Three of the pool's 22 rows are neutral, all singletons — deck 43's ratio. */
export const POOL_NEUTRAL_ROWS = 3

/**
 * The advisor deck, as `[cost, count]` rows summing to 40.
 *
 * Unlike `DEMO_DECK_PROFILE`, which takes evenly spaced entries from whatever
 * the class pool happens to look like, this one names the cost of every row.
 * That is the point: the rest-of-hand band is the mean cost of three cards, so
 * the band distribution is a function of this curve and of nothing else, and
 * the fixture needs all three bands to be full.
 *
 *   costs   1 × 8, 2 × 10, 3 × 7, 4 × 4, 5 × 4, 6 × 4, 7 × 3     = 40 cards
 *   mean    130 / 40 = 3.25,  E[c²] = 14.15,  sd ≈ 1.89
 *   mean of three companions:  sd ≈ 1.89 / √3 ≈ 1.09
 *     P(mean < 2.5)  = P(z < −0.69) ≈ 25%   → band 0
 *     P(mean ≥ 4.0)  = P(z > +0.69) ≈ 25%   → band 2
 *     the rest                       ≈ 50%   → band 1
 *
 * A ~25/50/25 split is what makes the stratified rung real: the two end bands
 * still hold ~22 copies of a 3-of per arm at `ADVISOR_MATCHES`, so both of them
 * contribute a comparison instead of being dropped for having one arm. The
 * rejected alternative was the real curve of deck 43 (mean 4.875), where band 0
 * essentially never occurs and the "stratified" estimate would be band 2 alone.
 *
 * Eleven 3-ofs and seven 1-ofs, ordered by cost, because `chooseAdvisorPlants`
 * indexes into the cost-sorted 3-ofs and wants a five-drop and a six-drop to
 * exist. Not a deck anyone would play; a deck whose arithmetic is known.
 */
export const ADVISOR_DECK_PROFILE = [
  [1, 3],
  [1, 3],
  [1, 1],
  [1, 1],
  [2, 3],
  [2, 3],
  [2, 3],
  [2, 1],
  [3, 3],
  [3, 3],
  [3, 1],
  [4, 3],
  [4, 1],
  [5, 3],
  [5, 1],
  [6, 3],
  [6, 1],
  [7, 3]
]

/**
 * A 40-card list for `ADVISOR_CLASS`, hitting `ADVISOR_DECK_PROFILE`'s costs
 * with the user's REAL `Card` rows.
 *
 * Cards are taken from the class's own pool at each requested cost, walking to
 * the next-nearest cost when a cost is exhausted, and never reusing a card —
 * two rows naming the same card would be a `DeckCard` primary-key collision on
 * insert, which is a crash at the worst possible moment (mid-transaction, in a
 * production database, after the backup was taken but before the summary was
 * printed).
 *
 * Real ids only, for the same reason `buildDemoDeckList` insists on them: a
 * `MatchOpeningCard.cardId` with no `Card` row renders as `#10573310`, has no
 * cost, and therefore has no band — so an invented id would not merely look
 * broken, it would silently delete the hand from the advisor's input.
 */
export function buildAdvisorDeckList(db, className) {
  const pool = classCards(db, className, NEUTRAL_CLASS_ID, false)
  const used = new Set()

  /** The unused card whose cost is closest to `target`, cheapest id first. */
  const nearest = (target) => {
    let best = null
    for (const card of pool) {
      if (used.has(card.cardId)) continue
      const distance = Math.abs((card.cost ?? 0) - target)
      if (best === null || distance < best.distance) best = { card, distance }
    }
    return best?.card ?? null
  }

  return ADVISOR_DECK_PROFILE.map(([cost, count]) => {
    const card = nearest(cost)
    if (!card) throw new Error(`not enough usable cards for the advisor deck (${className})`)
    used.add(card.cardId)
    return {
      cardId: card.cardId,
      count: Math.min(count, card.deckEnabledNum ?? 3),
      cost: card.cost
    }
  })
}

/** Real `Card` rows, cost-sorted: `neutral` picks class 0 instead of the class. */
function classCards(db, className, neutralClassId, neutral) {
  const classId = neutral ? neutralClassId : CLASS_NAME_TO_ID[className]
  return db
    .prepare(
      `SELECT cardId, cost, deckEnabledNum
       FROM Card
       WHERE class = ? AND isToken = 0 AND cost IS NOT NULL
       ORDER BY cost, cardId`
    )
    .all(classId)
}

/** The portal's id for cards every class can play. Matches `cardIndex.ts`. */
export const NEUTRAL_CLASS_ID = 0

/** Insert the demo decks, returning their new ids. */
function insertDemoDecks(db, plan, now) {
  for (const [className, entry] of Object.entries(plan.decks)) {
    // Two separate reasons to skip, and they are not the same reason. `created`
    // false means "the user already owns a deck for this class". `drawOnly`
    // means "this list must never become a row" — inserting it would attach a
    // deck to the elf set and silently delete the `'no-deck'` state from the
    // demo. Checked explicitly so that a future edit to `created` cannot
    // resurrect the bug.
    if (entry.drawOnly) continue
    if (!entry.created) continue
    const info = db
      .prepare(
        `INSERT INTO Deck (name, class, createdAt, updatedAt, isDefault, sourceKind, sourceRef, familyId)
         VALUES (?, ?, ?, ?, 0, 'local', ?, NULL)`
      )
      .run(`[demo] ${className} 示範牌組`, className, now, now, DEMO_DECK_REF)
    const deckId = Number(info.lastInsertRowid)
    // `familyId` equals `id` for a deck that has never been forked — 011's rule,
    // and the deck pages assume it rather than coalescing.
    db.prepare(`UPDATE Deck SET familyId = ? WHERE id = ?`).run(deckId, deckId)
    const ins = db.prepare(`INSERT INTO DeckCard (deckId, cardId, count) VALUES (?, ?, ?)`)
    for (const e of entry.deckList) ins.run(deckId, e.cardId, e.count)
    entry.deckId = deckId
  }
}

/** Insert the matches and their hands. */
function insertSets(db, sets) {
  const insMatch = db.prepare(
    `INSERT INTO Match
       (result, play_order, my_class, oppo_class, my_deckId, mode,
        playedAt, endedAt, durationTime, year, month, day, updatedAt, source)
     VALUES (@result, @play_order, @my_class, @oppo_class, @my_deckId, @mode,
             @playedAt, @endedAt, @durationTime, @year, @month, @day, @playedAt, @source)`
  )
  const insCard = db.prepare(
    `INSERT INTO MatchOpeningCard
       (matchId, stage, slot, cardId, confidence, swapped, decidedBy, artVector, artAlgoVersion)
     VALUES (@matchId, @stage, @slot, @cardId, @confidence, @swapped, @decidedBy, @artVector, @artAlgoVersion)`
  )

  let matches = 0
  let slots = 0
  for (const set of sets) {
    for (const m of set.matches) {
      const { openingCards, ...row } = m
      const info = insMatch.run(row)
      const matchId = Number(info.lastInsertRowid)
      matches += 1
      for (const c of openingCards) {
        insCard.run({ ...c, matchId })
        slots += 1
      }
    }
  }
  return { matches, slots }
}

/** Human-readable shape of what was (or would be) written. */
function summarise(sets, plan, cardNames) {
  const lines = []
  const nameOf = (id) => (id == null ? '(none)' : `${cardNames.get(id) ?? '?'} (#${id})`)

  // The `slots` column is not decoration. An earlier version of this script
  // printed only the grand total, and the elf set — 40 matches with zero
  // opening rows, invisible to the page it was supposed to demonstrate — sat in
  // that total undetected. A per-class count makes "matches but no hands" a
  // zero you cannot miss instead of 320 rows missing from a four-figure sum.
  lines.push('')
  lines.push('  class      matches    slots  deck                          shows')
  lines.push('  ---------  -------  -------  ----------------------------  ' + '-'.repeat(48))
  let total = 0
  let slots = 0
  for (const set of sets) {
    const entry = plan.decks[set.label]
    const deckLabel =
      !entry || entry.drawOnly
        ? '— none —'
        : `${entry.deckName}${entry.created ? ' (demo, created)' : ' (yours)'}`
    const deck = deckLabel.length > 28 ? `${deckLabel.slice(0, 27)}…` : deckLabel
    const setSlots = set.matches.reduce((s, m) => s + m.openingCards.length, 0)
    total += set.matches.length
    slots += setSlots
    lines.push(
      `  ${set.label.padEnd(9)}  ${String(set.matches.length).padStart(7)}` +
        `  ${String(setSlots).padStart(7)}  ${deck.padEnd(28)}  ${set.shows}`
    )
  }
  for (const empty of ['bishop', 'nemesis']) {
    lines.push(
      `  ${empty.padEnd(9)}  ${'0'.padStart(7)}  ${'0'.padStart(7)}  ${'—'.padEnd(28)}` +
        `  the completely-empty per-class state`
    )
  }
  lines.push('  ' + '-'.repeat(100))
  lines.push(`  TOTAL      ${String(total).padStart(7)} matches, ${slots} MatchOpeningCard rows`)

  // A set with matches but no hands contributes nothing to the page at all, so
  // it is called out rather than left for the reader to spot in the column.
  const mute = sets.filter(
    (s) => s.matches.length > 0 && s.matches.every((m) => m.openingCards.length === 0)
  )
  if (mute.length > 0) {
    lines.push('')
    lines.push(
      `  WARNING: ${mute.map((s) => s.label).join(', ')} have matches but NO opening rows.`
    )
    lines.push('  Those matches are invisible to the 起手 page. That is almost certainly a bug.')
  }

  const witch = sets.find((s) => s.label === 'witch')
  if (witch?.plants) {
    const p = witch.plants
    lines.push('')
    lines.push('  Planted inside the witch set:')
    lines.push(
      `    suppressed deal rate   ${nameOf(p.suppressed)}  — 3-of, expected ~27.7%, will read ~12%`
    )
    lines.push(
      `    low recognisedShare    ${nameOf(p.lowRecog)}  — slots left NULL ~45% of the time it is dealt`
    )
    lines.push(
      `    real win-rate signal   ${nameOf(p.signal)}  — dealt WR ~57.5% vs ~49.5% not dealt`
    )
    lines.push(
      `    never dealt            ${nameOf(p.neverDealt)}  — in the deck, removed from the draw`
    )

    // Observed deal rates, straight off the generated rows. Cheaper than
    // trusting the arithmetic in the comments above.
    const eligible = witch.matches.filter((m) =>
      m.openingCards.filter((c) => c.stage === 'pre').every((c) => c.cardId != null)
    )
    const rateOf = (id) =>
      eligible.length === 0
        ? '—'
        : `${(
            (100 *
              eligible.filter((m) =>
                m.openingCards.some((c) => c.stage === 'pre' && c.cardId === id)
              ).length) /
            eligible.length
          ).toFixed(1)}%`
    lines.push('')
    lines.push(
      `    check: eligible (complete pre hands) ${eligible.length}/${witch.matches.length}` +
        ` = recognisedShare ${(eligible.length / witch.matches.length).toFixed(3)}`
    )
    lines.push(`    check: observed deal rate, suppressed card  ${rateOf(p.suppressed)}`)
    lines.push(`    check: observed deal rate, signal card      ${rateOf(p.signal)}`)
    lines.push(`    check: observed deal rate, never-dealt card ${rateOf(p.neverDealt)}`)

    // The planted win-rate signal, measured off the generated rows the way the
    // page will measure it. Printed rather than asserted in a comment because
    // it is a sample of a few hundred: at this n the difference is a draw, not
    // a setting, and the reviewer should see the number it actually came out as
    // before deciding the comparison column works.
    const dealt = witch.matches.filter((m) =>
      m.openingCards.some((c) => c.stage === 'pre' && c.cardId === p.signal)
    )
    const notDealt = witch.matches.filter(
      (m) => !m.openingCards.some((c) => c.stage === 'pre' && c.cardId === p.signal)
    )
    const wr = (ms) =>
      ms.length === 0 ? 0 : (100 * ms.reduce((s, m) => s + m.result, 0)) / ms.length
    lines.push(
      `    check: signal card WR  dealt ${wr(dealt).toFixed(1)}% (n=${dealt.length})` +
        ` vs not dealt ${wr(notDealt).toFixed(1)}% (n=${notDealt.length})` +
        ` = ${(wr(dealt) - wr(notDealt)).toFixed(1)}pp`
    )
  }

  const advisorSet = sets.find((s) => s.advisorPlants)
  if (advisorSet) {
    // Costs come from the deck list, not from the generated rows: an opening row
    // records what was recognised, and the band is a fact about the card.
    const entry = plan.decks[advisorSet.label]
    const costOf = new Map((entry?.deckList ?? []).map((e) => [e.cardId, e.cost ?? null]))
    lines.push(summariseAdvisor(advisorSet, nameOf, costOf))
  }

  lines.push('')
  lines.push('  Overall win rate per set (plausible noise, except where planted):')
  for (const set of sets) {
    const w = set.matches.length
      ? (100 * set.matches.reduce((s, m) => s + m.result, 0)) / set.matches.length
      : 0
    lines.push(`    ${set.label.padEnd(10)} ${w.toFixed(1)}%  (n=${set.matches.length})`)
  }

  return lines.join('\n')
}

/**
 * What the advisor fixture actually came out as, measured off the generated
 * rows the way `src/main/ipc/mulligan.ts` will measure it.
 *
 * Printed rather than asserted, and printed in the SAME units the handler uses —
 * copies, split by the narrowest scope (primary opponent, `first`) — because
 * every one of these is a sample. The planted probabilities say what was asked
 * for; only these numbers say what the seed gave, and a reviewer deciding
 * whether to run `--apply` needs the second, not the first.
 *
 * This deliberately stops short of re-implementing the ladder. Whether a card
 * lands at `'stratified'` or falls to `'turn-order'` is the handler's judgement,
 * and a second implementation of it here would agree with itself rather than
 * with the page. What this prints is the raw material the judgement is made
 * from: per-arm counts at each scope, so the rung is legible against
 * `KEEP_THRESHOLDS` (show 12, sort 30) without being predicted.
 */
function summariseAdvisor(set, nameOf, costOf) {
  const plants = set.advisorPlants
  const lines = []
  lines.push('')
  lines.push(
    `  換牌建議 fixture (${set.label}), as the advisor will count it — COPIES, not matches.`
  )
  lines.push(
    `  Narrow scope = oppo ${ADVISOR_PRIMARY_OPPO} + play_order first.` +
      `  Thresholds: show 12, sort 30, on the SMALLER arm.`
  )
  lines.push('')
  lines.push(
    '    role          narrow k/s      +both orders    all opponents   card / what it shows'
  )
  lines.push('    ' + '-'.repeat(110))

  // One pass over every pre slot of every match, bucketed exactly the way the
  // handler buckets: a hand with an unnamed slot contributes nothing at all.
  const counts = new Map()
  const bandCounts = new Map()
  for (const rule of ADVISOR_PLANT_RULES) {
    counts.set(rule.role, { narrow: [0, 0], oppo: [0, 0], all: [0, 0] })
    bandCounts.set(
      rule.role,
      Array.from({ length: REST_BANDS }, () => ({ kept: [0, 0], swapped: [0, 0] }))
    )
  }

  for (const m of set.matches) {
    const pre = m.openingCards.filter((c) => c.stage === 'pre')
    if (pre.length !== HAND_SIZE || pre.some((c) => c.cardId == null)) continue
    const costs = pre.map((c) => costOf.get(c.cardId) ?? null)
    pre.forEach((cell, slot) => {
      for (const rule of ADVISOR_PLANT_RULES) {
        if (plants[rule.role] !== cell.cardId) continue
        const arm = cell.swapped === 1 ? 1 : 0
        const scope = counts.get(rule.role)
        scope.all[arm] += 1
        if (m.oppo_class === ADVISOR_PRIMARY_OPPO) {
          scope.oppo[arm] += 1
          if (m.play_order === 'first') scope.narrow[arm] += 1
        }
        // Bands are accumulated over the WHOLE set, not the narrow scope.
        // That is the filter the advisor page opens on (no opponent pinned, no
        // turn order pinned), so it is the drill-down a reviewer will actually
        // read; and it is where the sample is large enough for the planted
        // per-band win rates to come out as the planted per-band win rates
        // rather than as four-observation noise.
        const band = restBandOf(costs.filter((_c, i) => i !== slot))
        if (band != null) {
          const bandCell = bandCounts.get(rule.role)[band][arm === 0 ? 'kept' : 'swapped']
          bandCell[0] += 1
          bandCell[1] += m.result
        }
      }
    })
  }

  const pair = ([kept, swapped]) => `${String(kept).padStart(4)}/${String(swapped).padStart(4)}`
  for (const rule of ADVISOR_PLANT_RULES) {
    const c = counts.get(rule.role)
    lines.push(
      `    ${rule.role.padEnd(13)} ${pair(c.narrow).padEnd(15)} ${pair(c.oppo).padEnd(15)}` +
        ` ${pair(c.all).padEnd(15)} ${nameOf(plants[rule.role])}`
    )
    lines.push(`    ${''.padEnd(13)} ${''.padEnd(47)} ${rule.shows}`)
  }

  // The confounded card's drill-down, which is the row the whole set exists for.
  // If the bands do not disagree here, the Mantel-Haenszel adjustment has
  // nothing to collapse and the demonstration has failed regardless of what any
  // other number says.
  lines.push('')
  lines.push(`  Confounded card, per band, WHOLE set (the page's default filter) — must DISAGREE:`)
  lines.push('    band   kept n (wr)        swapped n (wr)')
  const wr = ([n, wins]) => (n === 0 ? '  —  ' : `${((100 * wins) / n).toFixed(1)}%`)
  const cf = bandCounts.get('confounded')
  let crudeKept = [0, 0]
  let crudeSwapped = [0, 0]
  cf.forEach((band, i) => {
    crudeKept = [crudeKept[0] + band.kept[0], crudeKept[1] + band.kept[1]]
    crudeSwapped = [crudeSwapped[0] + band.swapped[0], crudeSwapped[1] + band.swapped[1]]
    lines.push(
      `    ${i}      ${String(band.kept[0]).padStart(4)} (${wr(band.kept)})` +
        `      ${String(band.swapped[0]).padStart(4)} (${wr(band.swapped)})`
    )
  })
  const crude =
    crudeKept[0] && crudeSwapped[0]
      ? (100 * crudeKept[1]) / crudeKept[0] - (100 * crudeSwapped[1]) / crudeSwapped[0]
      : 0
  lines.push(
    `    crude, pooled over bands: kept ${wr(crudeKept)} (n=${crudeKept[0]})` +
      ` vs swapped ${wr(crudeSwapped)} (n=${crudeSwapped[0]}) = ${crude.toFixed(1)}pp`
  )
  lines.push('    …which the page must NOT report, because the bands above say ~5pp.')

  return lines.join('\n')
}

/**
 * The undo command, printed at the end of every run.
 *
 * It repeats `--db` when one was given, because a command that quietly undoes a
 * DIFFERENT database than the one just written is worse than no command at all.
 */
const undoCommand = (dbFlagValue) =>
  `node tools/seed-opening-demo.mjs --remove${dbFlagValue ? ` --db "${dbFlagValue}"` : ''}`

async function main(argv) {
  const args = new Set(argv)
  const dbFlag = argv.indexOf('--db')
  const dbOverride = dbFlag >= 0 ? argv[dbFlag + 1] : null
  const dbPath = dbOverride ?? defaultDbPath()
  const UNDO = undoCommand(dbOverride)
  const apply = args.has('--apply')
  const remove = args.has('--remove')

  const { default: Database } = await import('better-sqlite3')

  console.log(`database: ${dbPath}`)
  if (!fs.existsSync(dbPath)) {
    console.error(`  no database at that path. Nothing done.`)
    return 1
  }

  // The process check only gates the two modes that write. A dry run opens the
  // file read-only and is safe to run with the app up — which matters, because
  // the whole point of a dry run is that the user can look at it first.
  if (apply || remove) {
    if (!args.has('--ignore-running')) {
      const running = detectRunningApp()
      if (!running.known) {
        console.warn('  could not check whether the app is running (tasklist unavailable).')
      } else if (running.found.length > 0) {
        console.error('')
        console.error(`  關掉 app 再跑。偵測到還在執行：${running.found.join(', ')}`)
        console.error(
          '  The app holds this database open; writing underneath it risks a half-written'
        )
        console.error('  seed and a confused renderer. Close SVWB Analyzer and run this again.')
        console.error('  (If you are certain it is not this database: --ignore-running)')
        return 1
      }
    }
  }

  if (!apply && !remove) {
    // ---- DRY RUN ----
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const plan = planDecks(db)
      const sets = generateAll({ decks: plan.decks, now: Date.now() })
      const cardNames = new Map(
        db
          .prepare(`SELECT cardId, name FROM Card`)
          .all()
          .map((r) => [r.cardId, r.name])
      )

      console.log('mode:     DRY RUN — nothing will be written. Add --apply to write.')
      console.log('')
      console.log('Existing data (read-only, untouched):')
      console.log(
        `  Match ${db.prepare('SELECT COUNT(*) c FROM Match').get().c}` +
          `  (already tagged demo-seed: ${db.prepare(`SELECT COUNT(*) c FROM Match WHERE source = ?`).get(DEMO_SOURCE).c})`
      )
      console.log(
        `  Deck ${db.prepare('SELECT COUNT(*) c FROM Deck').get().c},` +
          ` DeckCard ${db.prepare('SELECT COUNT(*) c FROM DeckCard').get().c},` +
          ` Card ${db.prepare('SELECT COUNT(*) c FROM Card').get().c},` +
          ` MatchOpeningCard ${db.prepare('SELECT COUNT(*) c FROM MatchOpeningCard').get().c}`
      )
      console.log('')
      console.log('Decks reused (yours, read-only):')
      for (const r of plan.reused)
        console.log(`  ${r.className.padEnd(10)} #${r.deckId} ${r.name} (${r.cards} cards)`)
      if (plan.reused.length === 0) console.log('  (none)')
      console.log('Decks this would CREATE (tagged sourceRef=demo-seed, removed by --remove):')
      for (const c of plan.toCreate)
        console.log(`  ${c.className.padEnd(10)} [demo] ${c.className} 示範牌組 (${c.cards} cards)`)
      if (plan.toCreate.length === 0) console.log('  (none)')

      console.log(summarise(sets, plan, cardNames))
      console.log('')
      console.log(
        `To write it:  node tools/seed-opening-demo.mjs --apply${dbOverride ? ` --db "${dbOverride}"` : ''}`
      )
      console.log(`To undo it:   ${UNDO}`)
      return 0
    } finally {
      db.close()
    }
  }

  // ---- WRITING MODES ----
  const backup = await backupDatabase(Database, dbPath)
  console.log(`backup:   ${backup.dest} (${backup.size} bytes)`)

  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma('foreign_keys = ON') // the whole removal story rests on the cascade
  db.pragma('busy_timeout = 3000')

  try {
    if (remove) {
      const before = db.prepare(`SELECT COUNT(*) c FROM Match WHERE source = ?`).get(DEMO_SOURCE).c
      const slots = db
        .prepare(
          `SELECT COUNT(*) c FROM MatchOpeningCard oc
           JOIN Match m ON m.id = oc.matchId WHERE m.source = ?`
        )
        .get(DEMO_SOURCE).c
      const decks = db.prepare(`SELECT id, name FROM Deck WHERE sourceRef = ?`).all(DEMO_DECK_REF)
      console.log('')
      console.log(
        `About to delete ${before} Match rows, ${slots} MatchOpeningCard rows (by cascade),`
      )
      console.log(
        `and ${decks.length} demo Deck rows: ${decks.map((d) => `#${d.id} ${d.name}`).join(', ') || '(none)'}`
      )

      db.transaction(() => {
        db.prepare(`DELETE FROM Match WHERE source = ?`).run(DEMO_SOURCE)
        for (const d of decks) {
          // Refuse to remove a demo deck a REAL match now points at. Deleting it
          // would fire `ON DELETE SET NULL` on a row this script did not create,
          // which is the one thing rule 4 forbids.
          const stillUsed = db
            .prepare(`SELECT COUNT(*) c FROM Match WHERE my_deckId = ? OR oppo_deckId = ?`)
            .get(d.id, d.id).c
          if (stillUsed > 0) {
            console.warn(
              `  keeping Deck #${d.id} ${d.name}: ${stillUsed} of your own matches still reference it`
            )
            continue
          }
          db.prepare(`DELETE FROM DeckCard WHERE deckId = ?`).run(d.id)
          db.prepare(`DELETE FROM Deck WHERE id = ?`).run(d.id)
        }
      })()

      const leftMatches = db
        .prepare(`SELECT COUNT(*) c FROM Match WHERE source = ?`)
        .get(DEMO_SOURCE).c
      const orphans = db
        .prepare(
          `SELECT COUNT(*) c FROM MatchOpeningCard oc
           LEFT JOIN Match m ON m.id = oc.matchId WHERE m.id IS NULL`
        )
        .get().c
      const leftDecks = db
        .prepare(`SELECT COUNT(*) c FROM Deck WHERE sourceRef = ?`)
        .get(DEMO_DECK_REF).c

      console.log('')
      console.log(
        `leftover demo matches:            ${leftMatches}  ${leftMatches === 0 ? 'OK' : 'NOT CLEAN'}`
      )
      console.log(
        `orphaned MatchOpeningCard rows:   ${orphans}  ${orphans === 0 ? 'OK — the cascade held' : 'NOT CLEAN'}`
      )
      console.log(
        `leftover demo decks:              ${leftDecks}  ${leftDecks === 0 ? 'OK' : '(kept: still referenced)'}`
      )
      if (leftMatches !== 0 || orphans !== 0) {
        console.error('')
        console.error(`Removal did not come out clean. Your pre-run backup is at ${backup.dest}`)
        return 1
      }
      console.log('')
      console.log(`Demo data removed. Re-seed with: ${UNDO.replace('--remove', '--apply')}`)
      return 0
    }

    // ---- APPLY ----
    // Refuse to stack a second seed on top of a first. `--apply` twice would
    // double every count on the page — 840 witch matches, two copies of every
    // planted anomaly — and the resulting numbers would look like a bug in the
    // query layer rather than a bug in how the script was run. `--remove` is
    // total, so "remove then apply" is always available and always correct.
    const already = db.prepare(`SELECT COUNT(*) c FROM Match WHERE source = ?`).get(DEMO_SOURCE).c
    if (already > 0) {
      console.error('')
      console.error(`  This database already holds ${already} demo-seed matches.`)
      console.error(`  Seeding again would double them. Remove them first:`)
      console.error(`      ${UNDO}`)
      return 1
    }

    const now = Date.now()
    const plan = planDecks(db)
    const cardNames = new Map(
      db
        .prepare(`SELECT cardId, name FROM Card`)
        .all()
        .map((r) => [r.cardId, r.name])
    )

    let written
    db.transaction(() => {
      insertDemoDecks(db, plan, now)
      const sets = generateAll({ decks: plan.decks, now })
      written = { sets, counts: insertSets(db, sets) }
    })()

    console.log(summarise(written.sets, plan, cardNames))
    console.log('')
    console.log(
      `Wrote ${written.counts.matches} Match rows and ${written.counts.slots} MatchOpeningCard rows.`
    )
    console.log('')
    console.log(`TO UNDO THIS RUN:  ${UNDO}`)
    console.log(`Pre-run backup:    ${backup.dest}`)
    return 0
  } catch (err) {
    if (String(err?.code).startsWith('SQLITE_BUSY')) {
      console.error('')
      console.error(
        '  關掉 app 再跑。The database is locked by another process; nothing was written.'
      )
      console.error(`  Your pre-run backup is at ${backup.dest}`)
      return 1
    }
    throw err
  } finally {
    db.close()
  }
}

// Run only when invoked directly, so the test file can import the pure half
// without the CLI reaching for %APPDATA%.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
