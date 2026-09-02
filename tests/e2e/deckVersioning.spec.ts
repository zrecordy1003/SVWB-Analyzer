/**
 * Deck versioning, end to end (docs/deck-versioning-plan.md, stage 1).
 *
 * `tests/main/deckVersioning.test.ts` proves the rules against the IPC handlers
 * with a mocked `electron`. What it cannot prove is the promise the plan calls
 * the most important one: that the SCREEN does not change when a played deck
 * is edited. That needs the real renderer reading the real handlers through the
 * real preload bridge, so this spec seeds data over the same IPC the UI uses
 * (`window.electron.ipcRenderer.invoke`) and then reads the deck-performance
 * page like a user would.
 *
 * Every test gets a fresh profile (see `./app`), so the numbers below are the
 * only numbers in the database.
 */
import { test, expect } from './app'
import type { Page } from '@playwright/test'

type Res<T> = { ok: true; data: T } | { ok: false; error: string }

type Deck = { id: number; name: string; familyId: number | null; archivedAt: string | null }
type StatsRow = { deckId: number | null; familyId: number | null; total: number; wins: number }

// Portal class id for witch (CLASS_ID_TO_NAME).
const WITCH = 3
const CARDS_V1 = [
  { cardId: 900001, count: 3 },
  { cardId: 900002, count: 3 }
]
const CARDS_V2 = [
  { cardId: 900001, count: 3 },
  { cardId: 900003, count: 3 }
]

/** Call a main-process handler the way the renderer does. */
async function invoke<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    ([ch, a]) =>
      (
        window as unknown as {
          electron: { ipcRenderer: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }
        }
      ).electron.ipcRenderer.invoke(ch as string, ...(a as unknown[])) as Promise<T>,
    [channel, args] as const
  )
}

async function invokeOk<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  const res = await invoke<Res<T>>(window, channel, ...args)
  if (!res.ok) throw new Error(`${channel} failed: ${res.error}`)
  return res.data
}

async function saveLocal(window: Page, input: Record<string, unknown>): Promise<Deck> {
  return invokeOk<Deck>(window, 'decks:saveLocal', {
    name: 'E2E法師',
    classId: WITCH,
    cards: CARDS_V1,
    ...input
  })
}

async function playMatch(window: Page, deckId: number, win: boolean): Promise<void> {
  await invoke(window, 'matches:create', {
    result: win,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    my_deckId: deckId,
    playedAt: new Date().toISOString()
  })
}

async function openDeckPerformance(window: Page): Promise<void> {
  // Bounce through another page so the list and stats are re-read from main
  // rather than served from whatever the component already held.
  await window.getByRole('button', { name: '對局列表' }).click()
  await window.getByRole('button', { name: '牌組戰績' }).click()
}

/** The one row on the deck-performance page for this family (keyed by the first version's id). */
function deckRow(window: Page, familyId: number) {
  return window.getByTestId(`deck-row-${familyId}`)
}

test('editing a played deck forks a version and the screen does not change', async ({ window }) => {
  const v1 = await saveLocal(window, {})
  const FAMILY = v1.id
  await playMatch(window, v1.id, true)
  await playMatch(window, v1.id, true)
  await playMatch(window, v1.id, false)

  await openDeckPerformance(window)
  const rowBefore = deckRow(window, FAMILY)
  await expect(rowBefore).toHaveCount(1)
  await expect(rowBefore).toContainText('2勝 1敗 ・ 3 場')
  await expect(rowBefore).toContainText('66.7%')
  const textBefore = await rowBefore.innerText()

  // The edit. To the user this is "I changed two cards".
  const v2 = await saveLocal(window, { deckId: v1.id, cards: CARDS_V2 })
  expect(v2.id).not.toBe(v1.id)
  expect(v2.familyId).toBe(v1.id)

  // Underneath: two rows, one family, only the current one listed.
  const listed = await invokeOk<Deck[]>(window, 'decks:all')
  expect(listed.map((d) => d.id)).toEqual([v2.id])
  const all = await invokeOk<Deck[]>(window, 'decks:all', { scope: 'all' })
  expect(all.map((d) => d.id).sort()).toEqual([v1.id, v2.id].sort())

  // The old version keeps the games it was played with; the new one has none.
  const perDeck = await invokeOk<StatsRow[]>(window, 'decks:stats', {
    rangeKey: 'all',
    groupBy: 'deck'
  })
  expect(perDeck.find((r) => r.deckId === v1.id)).toMatchObject({ total: 3, wins: 2 })
  expect(perDeck.find((r) => r.deckId === v2.id)).toBeUndefined()

  // And the screen: same single row, same record, same rate. The one thing
  // allowed to differ is the version badge stage 2 adds once a family has
  // more than one version - it was absent before and says v2 now.
  await openDeckPerformance(window)
  const rowAfter = deckRow(window, FAMILY)
  await expect(rowAfter).toHaveCount(1)
  await expect(rowAfter).toContainText('2勝 1敗 ・ 3 場')
  await expect(rowAfter).toContainText('66.7%')
  const badge = rowAfter.getByTestId('deck-row-version-badge')
  await expect(badge).toHaveText('v2')
  const badgeText = await badge.innerText()
  const textAfter = (await rowAfter.innerText()).replace(badgeText, '')
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
  expect(normalize(textAfter)).toBe(normalize(textBefore))
})

test('an unplayed deck is edited in place and deleted for real', async ({ window }) => {
  const deck = await saveLocal(window, {})
  const edited = await saveLocal(window, { deckId: deck.id, cards: CARDS_V2 })
  expect(edited.id).toBe(deck.id)
  expect((await invokeOk<Deck[]>(window, 'decks:all', { scope: 'all' })).length).toBe(1)

  const impact = await invokeOk<{ matches: number; versions: number }>(
    window,
    'decks:deleteImpact',
    {
      id: deck.id
    }
  )
  expect(impact).toEqual({ matches: 0, versions: 1 })

  const res = await invokeOk<{ deleted: number; archived: number }>(window, 'decks:delete', {
    id: deck.id
  })
  expect(res).toMatchObject({ deleted: 1, archived: 0 })
  expect(await invokeOk<Deck[]>(window, 'decks:all', { scope: 'all' })).toEqual([])
})

test('deleting a played deck archives it: gone from the list, still in the numbers', async ({
  window
}) => {
  const deck = await saveLocal(window, {})
  const FAMILY = deck.id
  await playMatch(window, deck.id, true)
  await playMatch(window, deck.id, false)

  await openDeckPerformance(window)
  await expect(deckRow(window, FAMILY)).toHaveCount(1)

  const impact = await invokeOk<{ matches: number; versions: number }>(
    window,
    'decks:deleteImpact',
    {
      id: deck.id
    }
  )
  expect(impact).toEqual({ matches: 2, versions: 1 })

  const res = await invokeOk<{ deleted: number; archived: number }>(window, 'decks:delete', {
    id: deck.id
  })
  expect(res).toMatchObject({ deleted: 0, archived: 1 })

  // Hidden from the pickers and the list...
  expect(await invokeOk<Deck[]>(window, 'decks:all')).toEqual([])
  await openDeckPerformance(window)
  await expect(deckRow(window, FAMILY)).toHaveCount(0)

  // ...but the two games did not lose their deck.
  const stats = await invokeOk<StatsRow[]>(window, 'decks:stats', { rangeKey: 'all' })
  expect(stats.find((r) => r.deckId === deck.id)).toMatchObject({ total: 2, wins: 1 })
  const archived = await invokeOk<Deck[]>(window, 'decks:all', { scope: 'all' })
  expect(archived).toHaveLength(1)
  expect(archived[0].archivedAt).not.toBeNull()

  // Stage 2: the archived family comes back on request, marked as such.
  await window.getByTestId('deck-performance-show-archived').getByRole('checkbox').check()
  const row = deckRow(window, FAMILY)
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('data-archived', 'true')
  await expect(row.getByTestId('deck-archived-badge')).toBeVisible()
  await expect(row).toContainText('1勝 1敗 ・ 2 場')
})

/* ================================
 * Stage 2 - the version UI
 * ================================ */

test('the family row expands into versions with their own records and a card diff', async ({
  window
}) => {
  const v1 = await saveLocal(window, {})
  const FAMILY = v1.id
  await playMatch(window, v1.id, true)
  await playMatch(window, v1.id, true)
  await playMatch(window, v1.id, false)
  const v2 = await saveLocal(window, { deckId: v1.id, cards: CARDS_V2 })
  await playMatch(window, v2.id, true)

  await openDeckPerformance(window)
  const row = deckRow(window, FAMILY)
  // Family level: the sum of both versions.
  await expect(row).toContainText('3勝 1敗 ・ 4 場')
  await expect(row.getByTestId('deck-row-version-badge')).toHaveText('v2')

  await window.getByTestId(`deck-row-expand-${FAMILY}`).click()
  const panel = window.getByTestId(`deck-versions-panel-${FAMILY}`)
  await expect(panel).toBeVisible()

  // Version level: each keeps only the games played with that exact list, and
  // the sample size is on screen (the plan insists on this - thirty games per
  // version is noise, and the user has to be able to see that).
  const row1 = panel.getByTestId(`deck-version-row-${v1.id}`)
  const row2 = panel.getByTestId(`deck-version-row-${v2.id}`)
  await expect(row1).toHaveAttribute('data-version', '1')
  await expect(row2).toHaveAttribute('data-version', '2')
  await expect(row1.getByTestId('deck-version-record')).toContainText('3')
  await expect(row2.getByTestId('deck-version-record')).toContainText('1')
  await expect(panel.getByTestId('deck-versions-caveat')).toBeVisible()

  // The diff is the thing the user actually came for: which cards changed. It
  // is inline on the row (the changed cards as chips) and the full dialog is
  // one click away in the row menu.
  await expect(row2.getByTestId('deck-version-change-added-900003')).toBeVisible()
  await expect(row2.getByTestId('deck-version-change-removed-900002')).toBeVisible()
  await expect(row2.getByTestId('deck-version-span')).toBeVisible()
  await row2.getByTestId(`deck-version-menu-${v2.id}`).click()
  await window.getByTestId(`deck-version-diff-${v2.id}`).click()
  await expect(window.getByTestId('deck-diff-added')).toContainText('900003')
  await expect(window.getByTestId('deck-diff-removed')).toContainText('900002')
  await window.keyboard.press('Escape')
  await expect(window.getByTestId('deck-diff-body')).toHaveCount(0)
})

test('discarding an unplayed version falls back to the previous one', async ({ window }) => {
  const v1 = await saveLocal(window, {})
  const FAMILY = v1.id
  await playMatch(window, v1.id, true)
  const v2 = await saveLocal(window, { deckId: v1.id, cards: CARDS_V2 })

  await openDeckPerformance(window)
  await window.getByTestId(`deck-row-expand-${FAMILY}`).click()
  await window.getByTestId(`deck-version-menu-${v2.id}`).click()
  await window.getByTestId(`deck-version-discard-${v2.id}`).click()
  await expect(window.getByTestId('deck-version-discard-text')).toBeVisible()
  await window.getByTestId('deck-version-discard-confirm').click()

  // v2 had no games, so it is really gone; v1 is the current version again and
  // the family is a single version - no badge.
  await expect
    .poll(async () => (await invokeOk<Deck[]>(window, 'decks:all')).map((d) => d.id))
    .toEqual([v1.id])
  expect(await invokeOk<Deck[]>(window, 'decks:all', { scope: 'all' })).toHaveLength(1)
  await openDeckPerformance(window)
  const row = deckRow(window, FAMILY)
  await expect(row).toContainText('1勝 0敗 ・ 1 場')
  await expect(row.getByTestId('deck-row-version-badge')).toHaveCount(0)
})

test('match filters read a deck id as its whole family unless told otherwise', async ({
  window
}) => {
  const v1 = await saveLocal(window, {})
  await playMatch(window, v1.id, true)
  await playMatch(window, v1.id, false)
  const v2 = await saveLocal(window, { deckId: v1.id, cards: CARDS_V2 })
  await playMatch(window, v2.id, true)

  // The list shows v2; filtering on it must not lose the two games on v1.
  const family = await invoke<number>(window, 'matches:count', {
    myDeckIds: [v2.id],
    rangeKey: 'all'
  })
  expect(family).toBe(3)
  const exact = await invoke<number>(window, 'matches:count', {
    myDeckIds: [v2.id],
    myDeckScope: 'deck',
    rangeKey: 'all'
  })
  expect(exact).toBe(1)
})

/* ================================
 * Stage 3 - card-level statistics
 * ================================ */

type CardStatsResult = {
  coverage: { total: number; covered: number }
  groups: {
    myClass: string
    total: number
    cards: {
      cardId: number
      total: number
      wins: number
      without: { total: number; wins: number }
    }[]
  }[]
}

test('cards get their own win rates, attributed to the exact list each game was played with', async ({
  window
}) => {
  const v1 = await saveLocal(window, {})
  await playMatch(window, v1.id, true)
  await playMatch(window, v1.id, true)
  await playMatch(window, v1.id, false)
  const v2 = await saveLocal(window, { deckId: v1.id, cards: CARDS_V2 })
  await playMatch(window, v2.id, true)
  // A game with no deck at all: counted in the coverage denominator only.
  await invoke(window, 'matches:create', {
    result: false,
    play_order: 'first',
    my_class: 'witch',
    oppo_class: 'dragon',
    mode: 'ranked',
    playedAt: new Date().toISOString()
  })

  const stats = await invokeOk<CardStatsResult>(window, 'cards:stats', {
    rangeKey: 'all',
    myDeckIds: [v2.id]
  })
  expect(stats.coverage).toEqual({ total: 4, covered: 4 })
  const witch = stats.groups.find((g) => g.myClass === 'witch')!
  const card = (id: number) => witch.cards.find((c) => c.cardId === id)!
  // 900001 is in both lists: every game. 900002 only in v1, 900003 only in v2.
  expect(card(900001)).toMatchObject({ total: 4, wins: 3 })
  expect(card(900002)).toMatchObject({ total: 3, wins: 2, without: { total: 1, wins: 1 } })
  expect(card(900003)).toMatchObject({ total: 1, wins: 1, without: { total: 3, wins: 2 } })

  const all = await invokeOk<CardStatsResult>(window, 'cards:stats', { rangeKey: 'all' })
  expect(all.coverage).toEqual({ total: 5, covered: 4 })

  // On screen: the standalone 卡片 page. Cards with fewer than ten games are
  // hidden by default - everything this small profile has - so flip the one
  // switch the page offers.
  await window.getByRole('button', { name: '卡片' }).click()
  const page = window.getByTestId('cards-page')
  await expect(page).toBeVisible()
  await expect(page.getByTestId('cards-coverage')).toHaveAttribute('data-covered', '4')
  await expect(page.getByTestId('cards-coverage')).toHaveAttribute('data-total', '5')
  await expect(page.getByTestId('cards-empty')).toBeVisible()
  await page.getByTestId('cards-show-low-sample').getByRole('checkbox').check()
  await expect(page.getByTestId('cards-row-900001')).toBeVisible()
  await expect(page.getByTestId('cards-row-900003')).toHaveAttribute('data-low-sample', 'true')

  // Drill in: the card is traced back to the exact versions that carried it.
  await page.getByTestId('cards-row-900003').click()
  const drawer = window.getByTestId('cards-drilldown')
  await expect(drawer).toBeVisible()
  await expect(drawer).toHaveAttribute('data-card-id', '900003')
  await expect(drawer.getByTestId(`cards-drilldown-deck-${v2.id}`)).toBeVisible()
  await expect(drawer.getByTestId(`cards-drilldown-deck-${v1.id}`)).toHaveCount(0)
  await expect(drawer.getByTestId('cards-drilldown-without')).toBeVisible()
})
