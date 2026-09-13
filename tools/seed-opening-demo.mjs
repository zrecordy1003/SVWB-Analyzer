/**
 * Demo data for the 起手 (opening hand) page — reversible, tagged, and off by default.
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
 * Not an arbitrary constant: seeds 1..6000 were scanned against the user's own
 * decks, and this is the one whose REALISED numbers land closest to the ones
 * the demo claims — 8.1pp of signal, 11.6% suppressed, 0.883 share. That matters
 * because every interesting figure here is a sample of a few hundred, and at
 * n=420 an 8-point win-rate signal can come out as zero on an unlucky draw —
 * the first seed tried produced 49.2% dealt against 50.0% not dealt, which
 * would have left the comparison column looking broken rather than quiet. The
 * rejected alternative was to widen the planted effect until any seed showed
 * it, which would have meant demonstrating the page with an effect size no real
 * card has.
 *
 * Change it only to reshuffle, and re-check the figures the dry run prints.
 */
export const DEMO_SEED = 2021

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
 * One hand: four cards dealt, a swap decision per slot, four cards kept.
 *
 * `slot` is stable across the two stages, which is the migration's rule and not
 * an implementation detail: the mulligan panel moves a discarded card into the
 * row above without changing its column, which is how `swapped` is legible
 * without recognising any card at all.
 */
export function generateHand(rng, ctx) {
  const { pool, costOf } = ctx
  const { drawn: pre, rest } = drawWithoutReplacement(rng, pool, HAND_SIZE)

  const swapped = pre.map((cardId) => rng() >= keepProbability(costOf.get(cardId) ?? null))
  const swapCount = swapped.filter(Boolean).length
  const { drawn: replacements } = drawWithoutReplacement(rng, rest, swapCount)

  let taken = 0
  const post = pre.map((cardId, slot) => (swapped[slot] ? replacements[taken++] : cardId))

  return { pre, post, swapped }
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
    if (rng() < (plan.slotNullRate ?? 0) || (cardId === plan.lowRecog && rng() < (plan.lowRecogNullRate ?? 0))) {
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
    signalNotDealtWinP = null
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
    const hand = pool.length >= HAND_SIZE ? generateHand(rng, { pool, costOf }) : null
    const recorded = hand ? recordHand(rng, hand, plan) : null

    // The win rate is computed from the TRUE hand, not the recorded one. That
    // is the direction of causation — the card that was really there is the one
    // that could have affected the game — and it also means the planted signal
    // survives the recogniser's mistakes rather than being defined by them.
    let winP = baseWinP
    if (plan.signal != null && signalDealtWinP != null && signalNotDealtWinP != null && hand) {
      winP = hand.pre.includes(plan.signal) ? signalDealtWinP : signalNotDealtWinP
    }

    const playedAt = Math.round(now - rng() * SPREAD_MS)
    const durationTime = 90 + randInt(rng, 480)
    const d = new Date(playedAt)

    matches.push({
      result: rng() < winP ? 1 : 0,
      play_order: rng() < 0.5 ? 'first' : 'second',
      my_class: myClass,
      oppo_class: pickWeighted(rng, OPPO_WEIGHTS),
      my_deckId: deckId,
      mode: pickWeighted(rng, modes),
      playedAt,
      endedAt: playedAt + durationTime * 1000,
      durationTime,
      // Local-calendar fields, the way the app writes them.
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      source: DEMO_SOURCE,
      openingCards: recorded
        ? buildOpeningRows(rng, recorded)
        : []
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
  const rng = makeRng(seed)
  const out = []

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

  // ---- royal: past `wrShow` (20), short of `wrSort` (50) ----
  if (decks.royal) {
    out.push({
      label: 'royal',
      shows: "'shown' but not 'sortable' — the middle confidence state",
      matches: generateMatches({
        rng,
        count: 90,
        myClass: 'royal',
        deckId: decks.royal.deckId,
        deckList: decks.royal.deckList,
        now
      })
    })
  }

  // ---- nightmare: under almost every threshold ----
  if (decks.nightmare) {
    out.push({
      label: 'nightmare',
      shows: "below most thresholds — 'low-sample' everywhere",
      matches: generateMatches({
        rng,
        count: 25,
        myClass: 'nightmare',
        deckId: decks.nightmare.deckId,
        deckList: decks.nightmare.deckList,
        now
      })
    })
  }

  // ---- elf: hands, but no deck to compare them against ----
  // Deliberately `deckId: null` AND `deckList: []`. With no deck there is no
  // pool to draw from, so these matches get no opening rows at all, which is
  // the honest version of "we do not know what was in the hand": `'no-deck'`
  // is about the denominator being unknowable, and inventing hands for it would
  // have given the page a keep rate it has no right to.
  out.push({
    label: 'elf',
    shows: "the 'no-deck' missing state",
    matches: generateMatches({ rng, count: 40, myClass: 'elf', deckId: null, now })
  })

  // ---- dragon: tiny sample, and a third of the slots still waiting for a name ----
  if (decks.dragon) {
    out.push({
      label: 'dragon',
      shows: "tiny sample, plus 'unidentified' slots and a non-zero pendingRetry",
      matches: generateMatches({
        rng,
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
 * Twelve 3-ofs and four 1-ofs, spread across the cost curve by taking evenly
 * spaced entries from the cost-sorted class list. It is not a deck anyone would
 * play. It does not need to be: its only job is to be a 40-card multiset with a
 * believable curve and a couple of singletons, so the hypergeometric maths and
 * the cost-keyed keep rate both have something real to chew on.
 *
 * Real card ids, never invented ones, because a `MatchOpeningCard.cardId` with
 * no `Card` row renders as `#10573310` and would make the demo page look broken
 * rather than empty.
 */
export function buildDemoDeckList(db, className) {
  const classId = CLASS_NAME_TO_ID[className]
  const cards = db
    .prepare(
      `SELECT cardId, cost, deckEnabledNum
       FROM Card
       WHERE class = ? AND isToken = 0 AND cost IS NOT NULL
       ORDER BY cost, cardId`
    )
    .all(classId)

  if (cards.length < 16) throw new Error(`only ${cards.length} usable cards for class ${className}`)

  const profile = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1] // sums to 40
  const step = cards.length / profile.length
  return profile.map((count, i) => {
    const card = cards[Math.floor(i * step)]
    return {
      cardId: card.cardId,
      count: Math.min(count, card.deckEnabledNum ?? 3),
      cost: card.cost
    }
  })
}

/** Insert the demo decks, returning their new ids. */
function insertDemoDecks(db, plan, now) {
  for (const [className, entry] of Object.entries(plan.decks)) {
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

  lines.push('')
  lines.push('  class      matches  deck                          shows')
  lines.push('  ---------  -------  ----------------------------  ' + '-'.repeat(56))
  let total = 0
  let slots = 0
  for (const set of sets) {
    const entry = plan.decks[set.label]
    const deckLabel = entry
      ? `${entry.deckName}${entry.created ? ' (demo, created)' : ' (yours)'}`
      : '— none —'
    const deck = deckLabel.length > 28 ? `${deckLabel.slice(0, 27)}…` : deckLabel
    total += set.matches.length
    slots += set.matches.reduce((s, m) => s + m.openingCards.length, 0)
    lines.push(
      `  ${set.label.padEnd(9)}  ${String(set.matches.length).padStart(7)}  ${deck.padEnd(28)}  ${set.shows}`
    )
  }
  lines.push(`  ${'bishop'.padEnd(9)}  ${'0'.padStart(7)}  ${'—'.padEnd(28)}  the completely-empty per-class state`)
  lines.push(`  ${'nemesis'.padEnd(9)}  ${'0'.padStart(7)}  ${'—'.padEnd(28)}  the completely-empty per-class state`)
  lines.push('  ' + '-'.repeat(100))
  lines.push(`  TOTAL      ${String(total).padStart(7)} matches, ${slots} MatchOpeningCard rows`)

  const witch = sets.find((s) => s.label === 'witch')
  if (witch?.plants) {
    const p = witch.plants
    lines.push('')
    lines.push('  Planted inside the witch set:')
    lines.push(`    suppressed deal rate   ${nameOf(p.suppressed)}  — 3-of, expected ~27.7%, will read ~12%`)
    lines.push(`    low recognisedShare    ${nameOf(p.lowRecog)}  — slots left NULL ~45% of the time it is dealt`)
    lines.push(`    real win-rate signal   ${nameOf(p.signal)}  — dealt WR ~57.5% vs ~49.5% not dealt`)
    lines.push(`    never dealt            ${nameOf(p.neverDealt)}  — in the deck, removed from the draw`)

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
    const wr = (ms) => (ms.length === 0 ? 0 : (100 * ms.reduce((s, m) => s + m.result, 0)) / ms.length)
    lines.push(
      `    check: signal card WR  dealt ${wr(dealt).toFixed(1)}% (n=${dealt.length})` +
        ` vs not dealt ${wr(notDealt).toFixed(1)}% (n=${notDealt.length})` +
        ` = ${(wr(dealt) - wr(notDealt)).toFixed(1)}pp`
    )
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
        console.error('  The app holds this database open; writing underneath it risks a half-written')
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
        db.prepare(`SELECT cardId, name FROM Card`).all().map((r) => [r.cardId, r.name])
      )

      console.log('mode:     DRY RUN — nothing will be written. Add --apply to write.')
      console.log('')
      console.log('Existing data (read-only, untouched):')
      console.log(`  Match ${db.prepare('SELECT COUNT(*) c FROM Match').get().c}` +
        `  (already tagged demo-seed: ${db.prepare(`SELECT COUNT(*) c FROM Match WHERE source = ?`).get(DEMO_SOURCE).c})`)
      console.log(`  Deck ${db.prepare('SELECT COUNT(*) c FROM Deck').get().c},` +
        ` DeckCard ${db.prepare('SELECT COUNT(*) c FROM DeckCard').get().c},` +
        ` Card ${db.prepare('SELECT COUNT(*) c FROM Card').get().c},` +
        ` MatchOpeningCard ${db.prepare('SELECT COUNT(*) c FROM MatchOpeningCard').get().c}`)
      console.log('')
      console.log('Decks reused (yours, read-only):')
      for (const r of plan.reused) console.log(`  ${r.className.padEnd(10)} #${r.deckId} ${r.name} (${r.cards} cards)`)
      if (plan.reused.length === 0) console.log('  (none)')
      console.log('Decks this would CREATE (tagged sourceRef=demo-seed, removed by --remove):')
      for (const c of plan.toCreate) console.log(`  ${c.className.padEnd(10)} [demo] ${c.className} 示範牌組 (${c.cards} cards)`)
      if (plan.toCreate.length === 0) console.log('  (none)')

      console.log(summarise(sets, plan, cardNames))
      console.log('')
      console.log(`To write it:  node tools/seed-opening-demo.mjs --apply${dbOverride ? ` --db "${dbOverride}"` : ''}`)
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
      console.log(`About to delete ${before} Match rows, ${slots} MatchOpeningCard rows (by cascade),`)
      console.log(`and ${decks.length} demo Deck rows: ${decks.map((d) => `#${d.id} ${d.name}`).join(', ') || '(none)'}`)

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
            console.warn(`  keeping Deck #${d.id} ${d.name}: ${stillUsed} of your own matches still reference it`)
            continue
          }
          db.prepare(`DELETE FROM DeckCard WHERE deckId = ?`).run(d.id)
          db.prepare(`DELETE FROM Deck WHERE id = ?`).run(d.id)
        }
      })()

      const leftMatches = db.prepare(`SELECT COUNT(*) c FROM Match WHERE source = ?`).get(DEMO_SOURCE).c
      const orphans = db
        .prepare(
          `SELECT COUNT(*) c FROM MatchOpeningCard oc
           LEFT JOIN Match m ON m.id = oc.matchId WHERE m.id IS NULL`
        )
        .get().c
      const leftDecks = db.prepare(`SELECT COUNT(*) c FROM Deck WHERE sourceRef = ?`).get(DEMO_DECK_REF).c

      console.log('')
      console.log(`leftover demo matches:            ${leftMatches}  ${leftMatches === 0 ? 'OK' : 'NOT CLEAN'}`)
      console.log(`orphaned MatchOpeningCard rows:   ${orphans}  ${orphans === 0 ? 'OK — the cascade held' : 'NOT CLEAN'}`)
      console.log(`leftover demo decks:              ${leftDecks}  ${leftDecks === 0 ? 'OK' : '(kept: still referenced)'}`)
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
    const cardNames = new Map(db.prepare(`SELECT cardId, name FROM Card`).all().map((r) => [r.cardId, r.name]))

    let written
    db.transaction(() => {
      insertDemoDecks(db, plan, now)
      const sets = generateAll({ decks: plan.decks, now })
      written = { sets, counts: insertSets(db, sets) }
    })()

    console.log(summarise(written.sets, plan, cardNames))
    console.log('')
    console.log(`Wrote ${written.counts.matches} Match rows and ${written.counts.slots} MatchOpeningCard rows.`)
    console.log('')
    console.log(`TO UNDO THIS RUN:  ${UNDO}`)
    console.log(`Pre-run backup:    ${backup.dest}`)
    return 0
  } catch (err) {
    if (String(err?.code).startsWith('SQLITE_BUSY')) {
      console.error('')
      console.error('  關掉 app 再跑。The database is locked by another process; nothing was written.')
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
