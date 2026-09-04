/**
 * The notice is the disclosure, so the notice is what gets pinned.
 *
 * `settings.telemetry` defaults to on since 1.3.0, and the only thing standing
 * between an install and its first upload is this notice - main refuses every
 * upload until `telemetry:noticeDue` has answered true to a visible window.
 *
 * # What changed, and what that does to this file
 *
 * This used to drive a payload view: the notice offered 「看會送出什麼」, the
 * Settings panel printed `telemetry.preview()` verbatim, and the test walked
 * that path because a default-on setting whose disclosure was a dead end would
 * be worse than an opt-in one. Both were removed on request for 1.3.0, so the
 * walk no longer exists and the notice's own words are the entire disclosure.
 *
 * Which makes the wording load-bearing rather than cosmetic, and it is asserted
 * here literally - «沒有牌組名稱、備註、時間或任何能識別你的資料» is a promise
 * about the payload, and the second half of this file is what checks the
 * payload keeps it.
 *
 * `telemetry:preview` is still handled and still builds what an upload would
 * send through the same `rollup.ts`; it just has no button any more. Asking it
 * over IPC is therefore the same assertion as before, minus the click.
 *
 * Nothing here uploads. Every test gets a fresh profile, `SVWB_TELEMETRY_URL`
 * is not set for it, and the notice is never marked shown by this file - so
 * the upload gate in `performUpload` stays shut regardless.
 */
import { test, expect } from './app'
import { TELEMETRY_SCHEMA } from '../../src/shared/telemetry'

/** The notice's exact copy. Changing it should be a decision, not a diff. */
const TITLE = '已開啟數據統計'
const BODY_PROMISE = '沒有牌組名稱、備註、時間或任何能識別你的資料'
const BODY_PUBLIC = '彙總環境數據後，公開給所有人看'

test('the first-run notice states what is sent, and is the whole disclosure', async ({
  window
}) => {
  const notice = window.getByRole('alert').filter({ hasText: TITLE })
  await expect(notice).toBeVisible({ timeout: 30_000 })

  const text = (await notice.innerText()).replace(/\s+/g, '')
  expect(text).toContain(TITLE)
  expect(text).toContain(BODY_PROMISE)
  expect(text).toContain(BODY_PUBLIC)

  /**
   * And no buttons, which is the requested shape rather than an accident.
   *
   * Asserted after the notice is known to be on screen, so this is a real
   * count over a rendered element and not a locator that matches nothing
   * because the notice never appeared.
   */
  for (const gone of ['知道了', '看會送出什麼', '關閉統計']) {
    await expect(notice.getByRole('button', { name: gone })).toHaveCount(0)
  }
  // The close affordance is what remains, and it has to: this is the only way
  // to dismiss it.
  await expect(notice.getByRole('button', { name: /close/i })).toBeVisible()
})

test('Settings offers the switch, and no longer the payload view', async ({ window }) => {
  // `exact`, because the deck-performance page has a 「管理預設牌組 未設定
  // 未設定」 card whose accessible name contains this one.
  await window.getByRole('button', { name: '設定', exact: true }).click()

  const panel = window.getByRole('main')
  // The switch is `disabled` when the build has no endpoint configured, which
  // is a state this harness can be in, so the assertion is about the control
  // existing rather than about its value. It is also the only opt-out now.
  await expect(panel.getByText('分享對局數據')).toBeVisible()

  for (const gone of ['看會送出什麼', '收起送出內容', '立即上傳']) {
    await expect(panel.getByRole('button', { name: gone })).toHaveCount(0)
  }
  await expect(panel.locator('pre')).toHaveCount(0)
})

/** What `shared/telemetry.ts` declares a payload to be, as far as this asserts. */
type Preview = {
  schema: number
  installId: unknown
  days: { date: string; abandoned: number; manual: number; buckets: unknown[] }[]
}

/**
 * The fixture is aliased to `page` here, deliberately.
 *
 * It is called `window` everywhere else in this suite, which shadows the
 * browser global of the same name inside `evaluate` - so the callback below
 * would reach for Playwright's `Page.telemetry` and fail to compile. The
 * alternative is the cast the other specs use; renaming reads better and the
 * evaluate body then means what it says.
 */
test('the payload is still only counts, whether or not anything renders it', async ({
  window: page
}) => {
  const parsed = await page.evaluate(
    () =>
      (
        window as unknown as { telemetry: { preview(): Promise<Preview> } }
      ).telemetry.preview() as Promise<Preview>
  )

  // The shape `shared/telemetry.ts` declares, and nothing else. This is the
  // assertion that would fail if a field carrying a deck name, a note, a tag or
  // a timestamp ever found its way into the payload - and the one that keeps
  // the notice's promise honest now that no screen shows this.
  expect(Object.keys(parsed).sort()).toEqual(
    ['appVersion', 'arch', 'days', 'installId', 'locale', 'platform', 'schema', 'sentAt'].sort()
  )
  expect(parsed.schema).toBe(TELEMETRY_SCHEMA)
  // 14 UTC days, every one of them, empty ones included.
  expect(parsed.days).toHaveLength(14)
  for (const day of parsed.days) {
    expect(Object.keys(day).sort()).toEqual(['abandoned', 'buckets', 'date', 'manual'].sort())
    expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }

  // A fresh profile has no matches, so there is nothing to bucket - and no
  // install id, because previewing must not mint one for someone who then
  // decides against it.
  expect(parsed.days.every((d) => d.buckets.length === 0)).toBe(true)
  expect(String(parsed.installId)).toContain('尚未產生')
})
