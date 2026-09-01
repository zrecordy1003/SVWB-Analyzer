/**
 * The splash window has to be readable on anyone's desktop.
 *
 * It used to be `transparent: true` with the card relying on `backdrop-filter`
 * for its surface - but a transparent Electron window has nothing behind it to
 * blur, so the card was a few percent of white laid over the wallpaper, and its
 * text followed the OS colour scheme rather than the app's. On a light desktop
 * that put near-black text on whatever was underneath.
 *
 * Asserting on the window's own background colour is the durable form of that:
 * `#00000000` is what a transparent window reports.
 */
import { test, expect } from './app'

test('the splash window is opaque and fits its content', async ({ app }, testInfo) => {
  const splash = await app.firstWindow()
  expect(splash.url()).toContain('splash.html')

  const background = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('splash.html')
    )
    return win?.getBackgroundColor() ?? null
  })
  expect(background, 'splash window is still transparent').not.toBe('#00000000')

  // The panel should fill the window rather than float in it. Anything much
  // taller than the content is the dead band this was sized to remove.
  const contentHeight = await splash.evaluate(
    () => document.querySelector('.card')!.getBoundingClientRect().height
  )
  const windowHeight = await splash.evaluate(() => window.innerHeight)
  expect(windowHeight - contentHeight, 'too much empty window around the panel').toBeLessThan(60)

  const shot = testInfo.outputPath('splash.png')
  await splash.screenshot({ path: shot })
  await testInfo.attach('splash', { path: shot, contentType: 'image/png' })
})
