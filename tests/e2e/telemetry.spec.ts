/**
 * The consent flow can actually be read.
 *
 * `settings.telemetry` defaults to on since 1.3.0, so the only thing standing
 * between an install and its first upload is the notice - and the notice offers
 * a 「看會送出什麼」 button. For a while that button led to a Settings panel
 * holding a switch and a tooltip and nothing else: `telemetry:preview` was
 * wired through preload and called from nowhere. A default-on setting whose
 * disclosure is a dead end is worse than an opt-in one.
 *
 * So this asserts the disclosure end to end - the panel renders, the button
 * fetches a real payload through the real IPC, and what comes back is the
 * shape `shared/telemetry.ts` describes. `tests/main/telemetry*.test.ts`
 * already pin the payload's contents and the notice gate against the handlers;
 * what they cannot say is whether a user can get to any of it.
 *
 * Nothing here uploads. Every test gets a fresh profile, `SVWB_TELEMETRY_URL`
 * is not set for it, and the notice is never marked shown by this file - so
 * the upload gate in `performUpload` stays shut regardless.
 */
import { test, expect } from './app'

test('the settings panel shows the exact payload an upload would send', async ({ window }) => {
  // `exact`, because the deck-performance page has a 「管理預設牌組 未設定
  // 未設定」 card whose accessible name contains this one.
  await window.getByRole('button', { name: '設定', exact: true }).click()

  // The switch itself. It is `disabled` when the build has no endpoint
  // configured, which is a state this harness can be in, so the assertion is
  // about the control existing rather than about its value.
  const label = window.getByText('分享對局數據')
  await expect(label).toBeVisible()

  const disclose = window.getByRole('button', { name: '看會送出什麼' })
  if ((await disclose.count()) === 0) {
    // No endpoint compiled in: the panel says so instead, and there is nothing
    // to disclose. Assert the explanation rather than skipping silently.
    await expect(window.getByText('這個版本沒有設定統計伺服器，開關暫時無法使用。')).toBeVisible()
    return
  }

  await disclose.click()

  // The payload arrives over IPC, so poll rather than read once.
  const body = window.locator('pre')
  await expect(body).toBeVisible()
  await expect
    .poll(async () => (await body.innerText()).trim().startsWith('{'), {
      message: 'the payload block never filled with JSON'
    })
    .toBe(true)

  const parsed = JSON.parse(await body.innerText())

  // The shape `shared/telemetry.ts` declares, and nothing else. This is the
  // assertion that would fail if a field carrying a deck name, a note, a tag or
  // a timestamp ever found its way into the payload.
  expect(Object.keys(parsed).sort()).toEqual(
    ['appVersion', 'arch', 'days', 'installId', 'locale', 'platform', 'schema', 'sentAt'].sort()
  )
  expect(parsed.schema).toBe(1)
  // 14 UTC days, every one of them, empty ones included.
  expect(parsed.days).toHaveLength(14)
  for (const day of parsed.days) {
    expect(Object.keys(day).sort()).toEqual(['abandoned', 'buckets', 'date', 'manual'].sort())
    expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }

  // A fresh profile has no matches, so there is nothing to bucket - and no
  // install id, because previewing must not mint one for someone who then
  // decides against it.
  expect(parsed.days.every((d: { buckets: unknown[] }) => d.buckets.length === 0)).toBe(true)
  expect(parsed.installId).toContain('尚未產生')

  // And it collapses again, so the panel is not a one-way door.
  await window.getByRole('button', { name: '收起送出內容' }).click()
  await expect(body).toHaveCount(0)
})
