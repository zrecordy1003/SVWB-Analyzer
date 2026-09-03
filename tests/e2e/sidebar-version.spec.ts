/**
 * The version block at the foot of the sidebar.
 *
 * Its reason for existing is the reopen test: before it, dismissing the update
 * dialog left the app looking exactly like one that was already up to date, and
 * the only way back to the update was to relaunch or go digging in Settings.
 * The badge is the standing reminder, and the way back in.
 *
 * The layout test is the other half. The block has three states and they must
 * all be the same size, because the version line is a fixed landmark at the
 * bottom of the sidebar - a status that shoved it around every time the app
 * looked for an update would be worse than no status at all.
 */
import { test, expect } from './app'

/** The version line - the one thing on screen that is always there. */
const versionLine = /^v\d+\.\d+\.\d+$/

test.describe('with an update available', () => {
  test.use({ updateScenario: 'available' })

  test('badges the sidebar under the version', async ({ window }, testInfo) => {
    // Close the dialog that opened by itself; the sidebar is the subject here.
    await window.getByRole('button', { name: '稍後' }).click()
    await expect(window.getByRole('dialog')).toHaveCount(0)

    const badge = window.getByText('有新版', { exact: true })
    await expect(badge).toBeVisible()

    // Below, not above: the version keeps the top line.
    const versionBox = (await window.getByText(versionLine).boundingBox())!
    const badgeBox = (await badge.boundingBox())!
    expect(badgeBox.y).toBeGreaterThan(versionBox.y)

    const shot = testInfo.outputPath('sidebar-update.png')
    await window.screenshot({ path: shot })
    await testInfo.attach('sidebar-update', { path: shot, contentType: 'image/png' })
  })

  test('reopens the same dialog when clicked', async ({ window }) => {
    await window.getByRole('button', { name: '稍後' }).click()
    await expect(window.getByRole('dialog')).toHaveCount(0)

    await window.getByText('有新版', { exact: true }).click()

    const dialog = window.getByRole('dialog')
    await expect(dialog.getByText('有新版本可以更新')).toBeVisible()
    // The same dialog, with the notes still in it - not a second, emptier one.
    await expect(dialog.getByText('分析器新增第二張圖表', { exact: false })).toBeVisible()
  })
})

test.describe('with nothing to update', () => {
  test('shows just the running version, near the bottom', async ({ window }, testInfo) => {
    const version = window.getByText(versionLine)
    await expect(version).toBeVisible()
    await expect(window.getByText('有新版', { exact: true })).toHaveCount(0)
    await expect(window.getByText('可安裝', { exact: true })).toHaveCount(0)

    // This is the worst case for the gap: the status slot below the version is
    // reserved but empty, and it reads as bottom padding. Everything under the
    // version - the empty slot, the block's own padding, the drawer's - has to
    // stay small enough that the version still looks anchored to the edge.
    const box = (await version.boundingBox())!
    // `globalThis`, not `window`: inside `evaluate` this runs in the page, but
    // the enclosing `window` here is Playwright's Page fixture, and reading a
    // browser property off it only looked right because nothing type-checked
    // this file. Same value at runtime, no shadowing.
    const viewportHeight = await window.evaluate(() => globalThis.innerHeight)
    const gap = viewportHeight - (box.y + box.height)
    expect(gap, `version sits ${Math.round(gap)}px above the bottom`).toBeLessThan(45)

    const shot = testInfo.outputPath('sidebar-idle.png')
    await window.screenshot({ path: shot })
    await testInfo.attach('sidebar-idle', { path: shot, contentType: 'image/png' })
  })
})

test.describe('while a check is running', () => {
  test.use({ updateScenario: 'none' })

  test('says so below the version, without moving it', async ({ window }, testInfo) => {
    const version = window.getByText(versionLine)
    await expect(version).toBeVisible()
    const before = (await version.boundingBox())!

    // The simulated background check starts two seconds after launch, so this
    // is already polling by the time the indicator appears.
    const checking = window.getByText('檢查中', { exact: true })
    await expect(checking).toBeVisible({ timeout: 10_000 })

    // The whole point: an automatic check reports itself without taking over
    // the screen.
    await expect(window.getByRole('dialog')).toHaveCount(0)

    const during = (await version.boundingBox())!
    expect(during.y, 'the version moved when 檢查中 appeared').toBe(before.y)
    expect(during.x, 'the version moved when 檢查中 appeared').toBe(before.x)

    const checkingBox = (await checking.boundingBox())!
    expect(checkingBox.y).toBeGreaterThan(during.y)

    const shot = testInfo.outputPath('sidebar-checking.png')
    await window.screenshot({ path: shot })
    await testInfo.attach('sidebar-checking', { path: shot, contentType: 'image/png' })

    // And it must go back to where it was once the check finishes.
    await expect(checking).toBeHidden({ timeout: 10_000 })
    const after = (await version.boundingBox())!
    expect(after.y, 'the version moved when 檢查中 went away').toBe(before.y)
  })
})
