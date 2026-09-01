/**
 * The update flow, driven through the real app.
 *
 * These cover the three things that were actually broken before, and that no
 * amount of looking at a component in isolation would have caught:
 *
 *   - the background check opened a dialog even when there was no update, so
 *     anyone with 自動檢查更新 on got a popup on every single launch;
 *   - the background dialog's own 下載 button tagged its flow as the Settings
 *     panel's, so the progress it started was delivered to the other surface;
 *   - a failed check produced an unhandled rejection.
 *
 * The fixture is `SVWB_UPDATE_SIM`, which already existed for `pnpm dev` - no
 * release has to be published, and nothing is downloaded.
 */
import { test, expect } from './app'

test.describe('background update check', () => {
  test.describe(() => {
    test.use({ updateScenario: 'available' })

    test('offers the update, with notes for every version missed', async ({ window }, testInfo) => {
      const dialog = window.getByRole('dialog')
      await expect(dialog.getByText('有新版本可以更新')).toBeVisible({ timeout: 20_000 })

      // The version pills: where the user is, and where they would land.
      await expect(dialog.getByText('v9.9.9', { exact: true })).toBeVisible()
      // fullChangelog is on, so the release the user skipped is listed too.
      await expect(dialog.getByText('v9.9.8', { exact: true })).toBeVisible()
      await expect(dialog.getByText('分析器新增第二張圖表', { exact: false })).toBeVisible()

      const shot = testInfo.outputPath('update-available.png')
      await window.screenshot({ path: shot })
      await testInfo.attach('update-available', { path: shot, contentType: 'image/png' })
    })

    test('downloads on request and then offers to install', async ({ window }, testInfo) => {
      const dialog = window.getByRole('dialog')
      await dialog.getByRole('button', { name: '下載更新' }).click()

      // Progress belongs to the surface that started it. Before `source` named
      // the surface rather than who pressed the button, this dialog started a
      // download and then never heard another word about it.
      await expect(dialog.getByText('正在下載更新')).toBeVisible()
      // There is always a bar: indeterminate until the first progress event
      // lands, determinate after. An empty box here reads as a hang, which is
      // exactly what the first screenshot of this state caught.
      await expect(dialog.locator('.MuiLinearProgress-root')).toBeVisible()
      await expect(dialog.getByText(/\d+%/)).toBeVisible()

      const mid = testInfo.outputPath('update-downloading.png')
      await window.screenshot({ path: mid })
      await testInfo.attach('update-downloading', { path: mid, contentType: 'image/png' })

      await expect(dialog.getByText('更新已就緒')).toBeVisible({ timeout: 30_000 })
      await expect(dialog.getByRole('button', { name: '安裝並重啟' })).toBeEnabled()

      const done = testInfo.outputPath('update-downloaded.png')
      await window.screenshot({ path: done })
      await testInfo.attach('update-downloaded', { path: done, contentType: 'image/png' })
    })
  })

  test.describe(() => {
    test.use({ updateScenario: 'none' })

    test('says nothing at all when there is no update', async ({ window }) => {
      // The simulated check fires two seconds after launch; wait past it and
      // then insist the screen is still untouched. This is the regression that
      // matters most, and it can only be stated as an absence.
      await window.waitForTimeout(6_000)
      await expect(window.getByRole('dialog')).toHaveCount(0)
    })
  })

  test.describe(() => {
    test.use({ updateScenario: 'error' })

    test('stays quiet when the check itself fails', async ({ window }) => {
      // A background check that failed is not something the user asked for or
      // can act on. It belongs in the log, not in front of them.
      await window.waitForTimeout(6_000)
      await expect(window.getByRole('dialog')).toHaveCount(0)
    })
  })
})
