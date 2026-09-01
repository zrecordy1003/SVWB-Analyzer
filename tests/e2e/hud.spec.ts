/**
 * The HUD gets a window, and that window gets its HTML.
 *
 * This is here because the HUD once picked its URL with `app.isPackaged` while
 * the main window used `is.dev && ELECTRON_RENDERER_URL`. Those are not the
 * same question: an unpackaged build with no dev server - which is what
 * `pnpm start` and this harness both run - fell through to the dev branch and
 * loaded `"undefined/hud.html"`. The only trace was a `[HUD load failed] -300
 * ERR_INVALID_URL` line in a log nobody was reading, and the HUD simply never
 * appeared.
 *
 * The assertion is deliberately about the loaded URL rather than anything
 * on screen: the HUD starts hidden and only shows itself once the game is
 * running, which no test here can arrange.
 */
import { test, expect } from './app'

test('the HUD window loads its document', async ({ app, window }) => {
  // The HUD is created a few seconds after the main window, not with it.
  await expect
    .poll(
      async () => {
        const urls: string[] = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
        )
        return urls.some((url) => url.includes('hud.html'))
      },
      { timeout: 20_000, message: 'no window ever loaded hud.html' }
    )
    .toBe(true)

  // Guard the failure mode specifically: a window that exists but never
  // resolved a document reports an empty URL.
  const urls = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
  )
  expect(urls, 'a window failed to load anything').not.toContain('')

  // Sanity: the main window fixture resolved, so both windows are real.
  expect(window.url()).toContain('renderer/index.html')
})
