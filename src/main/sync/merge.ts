/**
 * The rules that decide who wins, as pure functions.
 *
 * Nothing in this file touches a database or a network, on purpose: these are
 * the rules whose failure is silent data loss, and the cheapest place to pin
 * them is a table of inputs and outputs. `tests/main/syncMerge.test.ts` does.
 * The convergence property they have to satisfy - every machine, given the same
 * set of changes in ANY order, ends up with the same rows - is tested one level
 * up against two real databases.
 */

/** The four kinds of row that sync. `MatchTag` and `DeckCard` ride inside their parent. */
export type SyncTable = 'Match' | 'Deck' | 'Tag' | 'DeckCategory'

export const SYNC_TABLES: readonly SyncTable[] = ['DeckCategory', 'Tag', 'Deck', 'Match']

/**
 * What a machine knows about one row: when it last changed, who changed it, and
 * whether the change was a deletion.
 *
 * `ts` is a hybrid-logical-clock value (see `nextTs`): a wall-clock millisecond
 * count that never goes backwards on this machine and never falls behind
 * anything it has seen from another.
 */
export interface Version {
  ts: number
  device: string
  deleted: boolean
}

/**
 * -1, 0 or 1: is `a` the later of the two?
 *
 * Time first; the device id breaks a tie. The tiebreak is arbitrary but it is
 * the SAME on every machine, which is the only property it needs - two machines
 * given the same pair must pick the same winner without talking to each other.
 */
export function compareVersions(a: Version, b: Version): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  if (a.device !== b.device) return a.device < b.device ? -1 : 1
  return 0
}

/**
 * Whether an incoming change should replace what is here.
 *
 * `null` local means this machine has never heard of the row. An exact tie
 * (same time, same device) is the same change seen twice - a segment pulled
 * again after a crash - and applying it again would be harmless but pointless,
 * so it is skipped. That is what makes re-applying a segment idempotent.
 *
 * A deletion is just a version like any other: a delete that is newer than an
 * edit wins, an edit newer than a delete brings the row back. The plan's rule
 * ("delete wins if its timestamp is newer") is this, not a special case.
 */
export function remoteWins(local: Version | null, remote: Version): boolean {
  if (local === null) return true
  return compareVersions(remote, local) > 0
}

/**
 * The next timestamp this machine may hand out.
 *
 * `changedAt` is when the user actually did the thing, not when it is being
 * uploaded: a laptop that edits a match on Monday and syncs on Wednesday should
 * lose to a desktop that edited the same match on Tuesday. `highWater` is the
 * largest value ever issued or seen, so the result is strictly greater than it -
 * two changes in the same millisecond still get distinct, ordered timestamps,
 * and a machine whose clock is behind another's never issues something that
 * sorts before what it has already read.
 */
export function nextTs(changedAt: number, highWater: number): number {
  return Math.max(changedAt, highWater + 1)
}

/**
 * Two rows claim the same unique name (a tag, a category) under different uids.
 *
 * The smaller uid keeps the name. Every machine computes this from the two
 * uids alone, so none of them needs the server, or to have seen the other's
 * decision, to arrive at the same answer.
 */
export function nameWinner(a: string, b: string): string {
  return a < b ? a : b
}

/**
 * Follow `SyncAlias` links to the surviving uid.
 *
 * Chains are possible (a loser's loser) and short, so this walks them. A cycle
 * cannot be written - an alias always points at the smaller uid - but the walk
 * is bounded anyway, because the cost of being wrong about that is a hang in
 * the middle of a transaction that holds the database write lock.
 */
export function resolveAlias(aliases: ReadonlyMap<string, string>, uid: string): string {
  let current = uid
  for (let hops = 0; hops < 16; hops++) {
    const next = aliases.get(current)
    if (next === undefined || next === current) return current
    current = next
  }
  return current
}

/**
 * Of several decks that all claim to be a class's default, the one that keeps
 * the flag.
 *
 * "At most one default per class" is enforced by the application, not by the
 * schema, so merging two machines that each set a default can leave two. The
 * most recently set one wins - the user's last word - and the uid breaks a tie
 * so that every machine picks the same one.
 */
export function pickDefault<T extends { uid: string; ts: number }>(candidates: readonly T[]): T {
  if (candidates.length === 0) throw new Error('pickDefault needs at least one candidate')
  return candidates.reduce((best, c) =>
    c.ts > best.ts || (c.ts === best.ts && c.uid > best.uid) ? c : best
  )
}
