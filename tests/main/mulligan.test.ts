/**
 * `cards:mulligan` - 換牌建議, the keep-or-swap comparison.
 *
 * What is worth pinning here is not the arithmetic (`shared/stats.ts` has its
 * own tests) but the rules that decide which observations the arithmetic ever
 * sees: a hand read as three cards contributes nothing, a copy's fate comes off
 * its own swap flag rather than off the post hand, both arms have to clear the
 * threshold rather than their sum, a thin cell steps outward and says so, and a
 * stratified estimate is combined across the bands instead of pooling them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerMulliganIpc } from '../../src/main/ipc/mulligan'
import { KEEP_THRESHOLDS, type MulliganResult } from '../../src/shared/openingStats'
import { createMigratedTestDb, insertMatch, removeTestDb, testDb, type TestDb } from '../helpers/db'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    })
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

let db: TestDb | undefined

async function mulligan(payload: Record<string, unknown> = {}): Promise<MulliganResult> {
  const handler = electronMock.handlers.get('cards:mulligan')
  expect(handler, 'Missing IPC handler: cards:mulligan').toBeTypeOf('function')
  const res = (await handler!({}, payload)) as { ok: boolean; data?: MulliganResult }
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return res.data!
}

let clock = Date.UTC(2026, 0, 1)

/** One finished match, most-recent-first ordering taken care of. */
async function match(opts: {
  won?: boolean
  playOrder?: string
  oppoClass?: string
}): Promise<number> {
  clock += 60_000
  return insertMatch({
    result: opts.won ?? true,
    play_order: opts.playOrder ?? 'first',
    my_class: 'witch',
    oppo_class: opts.oppoClass ?? 'dragon',
    mode: 'ranked',
    my_deckId: null,
    playedAt: new Date(clock)
  })
}

/**
 * Write one hand.
 *
 * `null` in `pre` is a slot the engine read but could not name. `swapped` is
 * per slot and is what this channel reads - the post hand is written too, the
 * way the engine writes it, precisely so that a test cannot pass by accident on
 * post-membership.
 */
async function hand(
  matchId: number,
  pre: (number | null)[],
  opts: { swapped?: boolean[] } = {}
): Promise<void> {
  const rows: Record<string, unknown>[] = []
  pre.forEach((cardId, slot) => {
    rows.push({
      matchId,
      stage: 'pre',
      slot,
      cardId,
      confidence: cardId == null ? null : 0.9,
      swapped: opts.swapped?.[slot] ? 1 : 0,
      decidedBy: cardId == null ? null : 'art-portal',
      artVector: null,
      artAlgoVersion: null
    })
  })
  pre.forEach((cardId, slot) => {
    // A swapped slot comes back as some other card; 900+ is nothing this file
    // ever asks about.
    const replaced = opts.swapped?.[slot] ? 900 + slot : cardId
    rows.push({
      matchId,
      stage: 'post',
      slot,
      cardId: replaced,
      confidence: replaced == null ? null : 0.9,
      swapped: null,
      decidedBy: replaced == null ? null : 'art-portal',
      artVector: null,
      artAlgoVersion: null
    })
  })
  await testDb()
    .insertInto('MatchOpeningCard')
    .values(rows as never)
    .execute()
}

/** A card master row, so `name` and `cost` resolve - and so the hand can be banded. */
async function card(cardId: number, cost: number): Promise<void> {
  await testDb()
    .insertInto('Card')
    .values({
      cardId,
      name: `card-${cardId}`,
      cost,
      type: 1,
      class: 3,
      rarity: 3,
      isToken: 0,
      lang: 'cht',
      updatedAt: Date.now()
    } as never)
    .execute()
}

const byId = (result: MulliganResult, cardId: number) =>
  result.cards.find((c) => c.cardId === cardId)

/**
 * `n` hands holding `subject` in slot 0 beside `companions`, kept or swapped,
 * `wins` of them won.
 */
async function hands(opts: {
  n: number
  wins: number
  subject: number
  companions: number[]
  kept: boolean
  oppoClass?: string
  playOrder?: string
}): Promise<void> {
  for (let i = 0; i < opts.n; i++) {
    const id = await match({
      won: i < opts.wins,
      oppoClass: opts.oppoClass,
      playOrder: opts.playOrder
    })
    await hand(id, [opts.subject, ...opts.companions], {
      swapped: [!opts.kept, false, false, false]
    })
  }
}

/** Three one-drops: mean cost 1, the cheapest band. */
const CHEAP = [201, 202, 203]
/** Three eight-drops: mean cost 8, the most expensive band. */
const COSTLY = [801, 802, 803]

async function seedCompanions(): Promise<void> {
  for (const id of CHEAP) await card(id, 1)
  for (const id of COSTLY) await card(id, 8)
}

beforeEach(async () => {
  electronMock.handlers.clear()
  clock = Date.UTC(2026, 0, 1)
  db = await createMigratedTestDb()
  registerMulliganIpc()
})

afterEach(async () => {
  await removeTestDb(db)
  db = undefined
})

describe('cards:mulligan the difference', () => {
  it('reads a card kept in wins and swapped in losses as better kept', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 16, wins: 16, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 16, wins: 0, subject: 100, companions: CHEAP, kept: false })

    const stat = byId(await mulligan(), 100)!
    expect(stat.dealt).toBe(32)
    expect(stat.kept).toBe(16)
    expect(stat.keepRate?.rate).toBeCloseTo(50, 5)
    expect(stat.basis).toBe('stratified')
    expect(stat.keptWr?.rate).toBeCloseTo(100, 5)
    expect(stat.swappedWr?.rate).toBeCloseTo(0, 5)
    expect(stat.diff).toBeGreaterThan(0)
    // Shrunk, so nowhere near the raw 100 points the arms describe.
    expect(stat.diff!).toBeLessThan(100)
    // `toBeLessThanOrEqual`, and the slack is not laziness. Every kept game was
    // won and every swapped one lost, so within each arm there is no variation
    // at all and the Greenland-Robins variance is exactly zero: the interval
    // collapses to the point 100..100. That is a real property of the
    // estimator at the boundary - the same degeneracy `stats.ts` rejects Wald
    // intervals for - and it is recorded here rather than asserted as desirable.
    // The fixture two describes below is the realistic one, and there the
    // interval is 65 points wide.
    expect(stat.diffLo).toBeLessThanOrEqual(stat.diffHi!)
  })

  it('reads a card kept in losses and swapped in wins as better swapped', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 16, wins: 0, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 16, wins: 16, subject: 100, companions: CHEAP, kept: false })

    const stat = byId(await mulligan(), 100)!
    expect(stat.keptWr?.rate).toBeCloseTo(0, 5)
    expect(stat.swappedWr?.rate).toBeCloseTo(100, 5)
    expect(stat.diff).toBeLessThan(0)
  })
})

describe('cards:mulligan a copy is the observation', () => {
  it('splits a hand holding two copies, one kept and one thrown back, across both arms', async () => {
    // The case post-membership cannot see: the card is still in the post hand,
    // so membership scores this as a clean keep and the swap disappears. The
    // swap flag is per slot and says what really happened.
    await card(100, 5)
    await seedCompanions()
    for (let i = 0; i < 14; i++) {
      const id = await match({ won: true })
      await hand(id, [100, 100, CHEAP[0], CHEAP[1]], { swapped: [false, true, false, false] })
    }

    const stat = byId(await mulligan(), 100)!
    expect(stat.dealt).toBe(28)
    expect(stat.kept).toBe(14)
    expect(stat.keepRate?.rate).toBeCloseTo(50, 5)
    // One observation in each arm, from each hand.
    expect(stat.keptWr?.total).toBe(14)
    expect(stat.swappedWr?.total).toBe(14)
  })
})

describe('cards:mulligan both arms', () => {
  it('shows nothing for a card that is almost always kept, however many times it was dealt', async () => {
    // Twenty keeps and two swaps. The sum is 22, comfortably past every
    // threshold on the page; the swapped arm is two matches and knows nothing.
    // This is the shape of the lie the page exists to avoid - a card with a 91%
    // keep rate has no control group, and the sum is what would wave it through.
    await card(100, 2)
    await seedCompanions()
    await hands({ n: 20, wins: 20, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 2, wins: 0, subject: 100, companions: CHEAP, kept: false })

    const stat = byId(await mulligan(), 100)!
    expect(stat.dealt).toBe(22)
    expect(stat.kept).toBe(20)
    // The descriptive half survives; it is the half that needs no control group.
    expect(stat.keepRate?.rate).toBeCloseTo(90.91, 1)
    expect(stat.confidence).toBe('hidden')
    expect(stat.keptWr).toBeNull()
    expect(stat.swappedWr).toBeNull()
    expect(stat.diff).toBeNull()
    // The interval goes with the estimate. On its own it would be the most
    // confident-looking thing on the least supported row.
    expect(stat.diffLo).toBeNull()
    expect(stat.diffHi).toBeNull()
    expect(stat.bands).toEqual([])
    expect(stat.missing).toBe('low-sample')
  })

  it('needs both arms at the threshold, not one of them twice over', async () => {
    await card(100, 2)
    await seedCompanions()
    const short = KEEP_THRESHOLDS.show - 1
    await hands({ n: 30, wins: 30, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: short, wins: 0, subject: 100, companions: CHEAP, kept: false })
    expect(byId(await mulligan(), 100)!.confidence).toBe('hidden')

    // One more swap, and the same data becomes showable.
    await hands({ n: 1, wins: 0, subject: 100, companions: CHEAP, kept: false })
    const stat = byId(await mulligan(), 100)!
    expect(stat.confidence).toBe('shown')
    expect(stat.swappedWr?.total).toBe(KEEP_THRESHOLDS.show)
  })
})

describe('cards:mulligan the stratified estimate', () => {
  it('combines the bands instead of pooling them, and parts company with the crude gap', async () => {
    // The confounding this page was built for, in its purest form: the card is
    // kept when the rest of the hand is cheap (a hand that wins anyway) and
    // thrown back when the rest is expensive (a hand that loses anyway). Inside
    // each band keeping it is worth five points. Pooled, it looks worth forty.
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 20, wins: 16, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 4, wins: 3, subject: 100, companions: CHEAP, kept: false })
    await hands({ n: 4, wins: 1, subject: 100, companions: COSTLY, kept: true })
    await hands({ n: 20, wins: 4, subject: 100, companions: COSTLY, kept: false })

    const stat = byId(await mulligan(), 100)!
    expect(stat.basis).toBe('stratified')
    // The arms printed beside the card stay crude - they are what the reader
    // checks against `dealt` - and they are miles apart.
    expect(stat.keptWr?.total).toBe(24)
    expect(stat.keptWr?.rate).toBeCloseTo(70.83, 1)
    expect(stat.swappedWr?.total).toBe(24)
    expect(stat.swappedWr?.rate).toBeCloseTo(29.17, 1)
    // Mantel-Haenszel says five points, and shrinkage takes it to 5·24/64.
    // The crude gap would have shrunk to about 15.6, so this is not a rounding
    // difference - it is the whole confounding.
    expect(stat.diff).toBeCloseTo(1.88, 2)
    expect(stat.diff!).toBeLessThan(stat.keptWr!.rate - stat.swappedWr!.rate)

    // The interval belongs to the MH estimate, not to the crude gap beside it.
    // Greenland-Robins puts it at 5.00 ± 32.47, so it contains the adjusted
    // five points and EXCLUDES the crude 41.67 - which is the entire argument
    // for computing it this way. A Newcombe interval on the crude arms would be
    // centred near 41.7 and would not contain the estimate it was printed next
    // to, which is the failure this pins.
    const crude = stat.keptWr!.rate - stat.swappedWr!.rate
    expect(crude).toBeCloseTo(41.66, 1)
    expect(stat.diffLo).toBeCloseTo(-27.47, 1)
    expect(stat.diffHi).toBeCloseTo(37.47, 1)
    expect(stat.diffLo!).toBeLessThan(5)
    expect(stat.diffHi!).toBeGreaterThan(5)
    expect(stat.diffHi!).toBeLessThan(crude)
    // Shrunk point, unshrunk bounds: the dot sits inside its whisker, never in
    // the middle of it. Deliberate, and the same relationship the 起手 page has.
    expect(stat.diff!).toBeGreaterThan(stat.diffLo!)
    expect(stat.diff!).toBeLessThan(stat.diffHi!)

    // The drill-down carries both bands with their own crude arms, which is how
    // a suspicious reader checks that the two agree.
    expect(stat.bands.map((b) => b.band)).toEqual([0, 2])
    expect(stat.bands[0].keptWr?.total).toBe(20)
    expect(stat.bands[0].keptWr?.rate).toBeCloseTo(80, 5)
    expect(stat.bands[0].swappedWr?.rate).toBeCloseTo(75, 5)
    expect(stat.bands[1].keptWr?.rate).toBeCloseTo(25, 5)
    expect(stat.bands[1].swappedWr?.rate).toBeCloseTo(20, 5)
  })

  it('keeps a hand whose companions have no known cost out of the bands but not out of the pool', async () => {
    // No `Card` rows for the companions, which is a cache miss rather than a
    // recognition failure: the hand was read in full, we just cannot say how
    // expensive it was. Banding it on two of three costs would put it in the
    // wrong band, so it only contributes where the band is not used.
    await card(100, 5)
    await hands({ n: 14, wins: 14, subject: 100, companions: [701, 702, 703], kept: true })
    await hands({ n: 14, wins: 0, subject: 100, companions: [701, 702, 703], kept: false })

    const stat = byId(await mulligan(), 100)!
    expect(stat.dealt).toBe(28)
    expect(stat.basis).toBe('turn-order')
    expect(stat.bands).toEqual([])
    expect(stat.keptWr?.total).toBe(14)
    expect(stat.swappedWr?.total).toBe(14)
  })
})

describe('cards:mulligan the fallback ladder', () => {
  it('falls to the turn order when no band holds both a keep and a swap', async () => {
    // Kept only in cheap hands, thrown back only in expensive ones. Every band
    // is one-armed, so there is no within-band comparison to combine and the
    // stratified rung has nothing to offer however much data there is.
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 14, wins: 14, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 14, wins: 0, subject: 100, companions: COSTLY, kept: false })

    const stat = byId(await mulligan({ oppoClass: 'dragon' }), 100)!
    expect(stat.basis).toBe('turn-order')
    // The bands are empty at every rung but the stratified one, so the page
    // cannot draw a drill-down that its number did not come from.
    expect(stat.bands).toEqual([])
    expect(stat.keptWr?.total).toBe(14)
    expect(stat.swappedWr?.total).toBe(14)
    // And this is exactly the number the bands would have corrected, which is
    // why the basis has to be on the row.
    expect(stat.diff).toBeGreaterThan(0)
  })

  it('pools the turn orders and says so when one side of the coin is too thin', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 6, wins: 6, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 6, wins: 0, subject: 100, companions: CHEAP, kept: false })
    await hands({
      n: 10,
      wins: 10,
      subject: 100,
      companions: CHEAP,
      kept: true,
      playOrder: 'second'
    })
    await hands({
      n: 10,
      wins: 0,
      subject: 100,
      companions: CHEAP,
      kept: false,
      playOrder: 'second'
    })

    const stat = byId(await mulligan({ oppoClass: 'dragon', playOrder: 'first' }), 100)!
    expect(stat.basis).toBe('opponent')
    expect(stat.dealt).toBe(12)
    expect(stat.keptWr?.total).toBe(16)
    expect(stat.swappedWr?.total).toBe(16)
  })

  it('pools the opponents in defiance of the filter, and reports that it did', async () => {
    await card(100, 5)
    await seedCompanions()
    // Six of each against dragon - not enough at any level that respects the
    // filter - and ten of each against haven.
    await hands({ n: 6, wins: 6, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 6, wins: 0, subject: 100, companions: CHEAP, kept: false })
    await hands({
      n: 10,
      wins: 10,
      subject: 100,
      companions: CHEAP,
      kept: true,
      oppoClass: 'haven'
    })
    await hands({
      n: 10,
      wins: 0,
      subject: 100,
      companions: CHEAP,
      kept: false,
      oppoClass: 'haven'
    })

    const stat = byId(await mulligan({ oppoClass: 'dragon' }), 100)!
    expect(stat.basis).toBe('all-opponents')
    // `dealt` still describes the filter the user set; the estimate does not.
    // That divergence is the whole reason `basis` is on the row.
    expect(stat.dealt).toBe(12)
    expect(stat.keptWr?.total).toBe(16)
    expect(stat.swappedWr?.total).toBe(16)
  })

  it('hides the whole comparison when even the widest level is too thin', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 4, wins: 4, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 4, wins: 0, subject: 100, companions: CHEAP, kept: false })

    const stat = byId(await mulligan({ oppoClass: 'dragon' }), 100)!
    expect(stat.confidence).toBe('hidden')
    expect(stat.keptWr).toBeNull()
    expect(stat.diff).toBeNull()
    expect(stat.diffLo).toBeNull()
    expect(stat.bands).toEqual([])
    expect(stat.missing).toBe('low-sample')
  })
})

describe('cards:mulligan completeness', () => {
  it('excludes a hand with an unread slot, and takes it once a retry names the card', async () => {
    await card(100, 5)
    await seedCompanions()
    const id = await match({ won: true })
    await hand(id, [100, CHEAP[0], null, CHEAP[2]])

    const before = await mulligan()
    expect(before.matches).toBe(0)
    expect(before.baseline).toBeNull()
    const cold = byId(before, 100)!
    expect(cold.dealt).toBe(0)
    // The card was seen; it is the hand that could not be counted, and the row
    // has to say which of those two it is.
    expect(cold.missing).toBe('unidentified')

    // Exactly what `Command::RetryUnnamedCards` does. Nothing else is touched,
    // because there is no completeness flag to update.
    await testDb()
      .updateTable('MatchOpeningCard')
      .set({ cardId: CHEAP[1], decidedBy: 'art-observed' })
      .where('matchId', '=', id)
      .where('stage', '=', 'pre')
      .where('slot', '=', 2)
      .execute()

    const after = await mulligan()
    expect(after.matches).toBe(1)
    expect(byId(after, 100)!.dealt).toBe(1)
    expect(byId(after, 100)!.missing).not.toBe('unidentified')
  })
})

describe('cards:mulligan the baseline', () => {
  it('reports the win rate of the matches the filter selected', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 6, wins: 6, subject: 100, companions: CHEAP, kept: true })
    await hands({ n: 4, wins: 0, subject: 100, companions: CHEAP, kept: false })

    const result = await mulligan()
    expect(result.matches).toBe(10)
    expect(result.baseline?.total).toBe(10)
    expect(result.baseline?.wins).toBe(6)
    expect(result.baseline?.rate).toBeCloseTo(60, 5)
  })

  it('counts the filtered matches once, not once per card in the hand', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 3, wins: 3, subject: 100, companions: CHEAP, kept: true })

    expect((await mulligan()).matches).toBe(3)
  })
})

describe('cards:mulligan filters', () => {
  it('narrows to one matchup', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 5, wins: 5, subject: 100, companions: CHEAP, kept: true })
    await hands({
      n: 7,
      wins: 0,
      subject: 100,
      companions: CHEAP,
      kept: true,
      oppoClass: 'haven'
    })

    const all = await mulligan()
    expect(all.matches).toBe(12)
    expect(byId(all, 100)!.dealt).toBe(12)

    const dragon = await mulligan({ oppoClass: 'dragon' })
    expect(dragon.matches).toBe(5)
    expect(dragon.baseline?.rate).toBeCloseTo(100, 5)
    expect(byId(dragon, 100)!.dealt).toBe(5)

    const haven = await mulligan({ oppoClass: 'haven' })
    expect(haven.matches).toBe(7)
    expect(haven.baseline?.rate).toBeCloseTo(0, 5)
  })

  it('narrows to one turn order', async () => {
    await card(100, 5)
    await seedCompanions()
    await hands({ n: 5, wins: 5, subject: 100, companions: CHEAP, kept: true })
    await hands({
      n: 3,
      wins: 3,
      subject: 100,
      companions: CHEAP,
      kept: true,
      playOrder: 'second'
    })

    expect((await mulligan({ playOrder: 'first' })).matches).toBe(5)
    expect((await mulligan({ playOrder: 'second' })).matches).toBe(3)
    expect(byId(await mulligan({ playOrder: 'second' }), 100)!.dealt).toBe(3)
  })
})
