/**
 * The class emblems survive the whole round trip in the real app.
 *
 * Everything up to here has been tested in isolation - the cache with an
 * injected transport, the URL parser with strings. What no unit test can say is
 * whether `svwb-card://class/elf.svg` actually resolves once there is a real
 * protocol handler, a real `net.fetch`, a real CSP and a real `<img>` in front
 * of it. That is four things that have to agree, and each of them fails
 * silently: the handler answers with a transparent pixel rather than an error,
 * so a broken chain looks exactly like a class with no emblem.
 *
 * Hence the assertion on `naturalWidth`. The blank fallback is 1x1 and every
 * real emblem is at least 270px on its long edge, which is the same signal
 * `ClassIcon` uses to decide whether to keep showing its swatch.
 *
 * # Why two of these are tagged `@network`
 *
 * The download happens in the MAIN process (`net.fetch`, see
 * `data/classIcons.ts`), which is the point - the renderer's CSP forbids it.
 * That also means Playwright cannot intercept it: there is no browser request
 * to route. Making these hermetic would mean injecting a transport, which is
 * what the unit tests already do, and would test the fake instead of the four
 * things this file exists to check - handler, `net.fetch`, CSP and `<img>` -
 * actually agreeing.
 *
 * So they stay real, and they carry a tag instead. CI runs with
 * `--grep-invert @network`: hitting a third party's CDN on every push is both
 * rude and a flake source, and a green CI should not appear to cover something
 * whose result depended on Cygames being up. Locally they run by default, and
 * skip rather than fail when there is no network - a developer offline should
 * not be told their code is broken.
 */
import { test, expect } from './app'

const CLASSES = [
  'elf',
  'royal',
  'witch',
  'dragon',
  'nightmare',
  'bishop',
  'nemesis',
  'neutral'
] as const

/** Load one URL in the renderer and report what the image turned out to be. */
async function measure(
  window: import('@playwright/test').Page,
  url: string
): Promise<{ width: number; height: number; errored: boolean }> {
  return window.evaluate(
    (src) =>
      new Promise<{ width: number; height: number; errored: boolean }>((resolve) => {
        const img = new Image()
        img.onload = () =>
          resolve({ width: img.naturalWidth, height: img.naturalHeight, errored: false })
        img.onerror = () => resolve({ width: 0, height: 0, errored: true })
        img.src = src
        setTimeout(() => resolve({ width: -1, height: -1, errored: false }), 20_000)
      }),
    url
  )
}

test('every class emblem loads through svwb-card://', { tag: '@network' }, async ({ window }) => {
  const reachable = await window.evaluate(async () => {
    try {
      // The renderer cannot reach the network - that is the point of the CSP -
      // so ask the main process's side of the world by way of a cheap emblem.
      const probe = new Image()
      probe.src = 'svwb-card://class/elf.svg'
      await probe.decode().catch(() => {})
      return probe.naturalWidth > 2
    } catch {
      return false
    }
  })
  test.skip(!reachable, 'no network, or the portal is not answering')

  for (const name of CLASSES) {
    const result = await measure(window, `svwb-card://class/${name}.svg`)
    expect(result.errored, `${name} errored instead of resolving`).toBe(false)
    expect(result.width, `${name} came back as the blank fallback or timed out`).toBeGreaterThan(2)
  }
})

test('an unknown class name gets the blank pixel, not an error', async ({ window }) => {
  // The handler must never 404: an <img> that errors draws a broken-image glyph
  // and fires onerror, and half this design rests on it doing neither.
  const result = await measure(window, 'svwb-card://class/forestcraft.svg')
  expect(result.errored).toBe(false)
  expect(result.width).toBe(1)
})

test('the emblems reach the screen', { tag: '@network' }, async ({ window }) => {
  // The default-deck header at the top of every page names a class, so an
  // emblem is on screen from the first paint. Polled rather than read once: the
  // first one on a fresh profile is a cold download, not a cache hit.
  await expect
    .poll(
      () =>
        window.evaluate(
          () =>
            Array.from(document.querySelectorAll('img')).filter(
              (img) => img.src.startsWith('svwb-card://class/') && img.naturalWidth > 2
            ).length
        ),
      { timeout: 20_000, message: 'no class emblem ever rendered at its real size' }
    )
    .toBeGreaterThan(0)

  // And none of the ones that ARE mounted fell back to the blank pixel.
  const blank = await window.evaluate(
    () =>
      Array.from(document.querySelectorAll('img')).filter(
        (img) => img.src.startsWith('svwb-card://class/') && img.complete && img.naturalWidth <= 2
      ).length
  )
  expect(blank, 'some emblems rendered as the blank fallback').toBe(0)
})
