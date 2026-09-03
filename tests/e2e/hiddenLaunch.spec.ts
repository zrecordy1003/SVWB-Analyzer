/**
 * `--hidden` starts the app into the tray, and nothing announces itself there.
 *
 * The login item has always been registered with
 * `args: ['--hidden', '--auto-launch']` (`main/startOnBoot.ts`) and nothing
 * read them, so "start with Windows" put a window in front of the user at
 * every single login. Now it does not - and that creates a launch mode with a
 * running renderer nobody can see, which two things depended on not existing.
 *
 * The telemetry notice marks itself shown when it is handed to a window, and
 * that mark is the only thing between an install and its first upload. The
 * guard lives in `telemetry:noticeDue`, in main, deliberately: the first
 * version asked `document.hidden` in the renderer, which reads `false` inside
 * a `show: false` window - Electron does not tie document visibility to
 * whether a window has been shown - so it was inert, and it took a run of this
 * file to find that out.
 *
 * And the shortcut was the way back in. `requestSingleInstanceLock` was taken
 * and the second process quit without telling the first, so launching again
 * did nothing at all; after a hidden start that left only the tray icon.
 */
import { test, expect } from './app'
import type { Page } from '@playwright/test'

/** Call a main-process handler the way the renderer does. */
async function invoke<T>(window: Page, channel: string): Promise<T> {
  return window.evaluate(
    (ch) =>
      (
        window as unknown as {
          electron: { ipcRenderer: { invoke: (c: string) => Promise<unknown> } }
        }
      ).electron.ipcRenderer.invoke(ch) as Promise<T>,
    channel
  )
}

async function storeValue<T>(window: Page, key: string): Promise<T> {
  return window.evaluate(
    (k) =>
      (window as unknown as { settings: { get: (k: string) => Promise<unknown> } }).settings.get(
        k
      ) as Promise<T>,
    key
  )
}

test.describe('launched with --hidden', () => {
  test.use({ extraArgs: ['--hidden'] })

  test('creates the main window without showing it, and shows no splash', async ({
    app,
    window
  }) => {
    // The renderer is running - the tray, the HUD and the engine all need it.
    expect(window.url()).toContain('renderer/index.html')

    const state = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      const main = windows.find((w) => w.webContents.getURL().includes('renderer/index.html'))
      return {
        urls: windows.map((w) => w.webContents.getURL()),
        mainVisible: main?.isVisible() ?? null
      }
    })

    expect(state.mainVisible, 'the main window was shown despite --hidden').toBe(false)
    expect(
      state.urls.some((url) => url.includes('splash.html')),
      'a splash window was created despite --hidden'
    ).toBe(false)
  })

  /**
   * The guard, asserted directly rather than through the clock.
   *
   * An earlier version of this waited past the prompt's delay and polled the
   * store with `.not.toBe(true)` - which passes on the FIRST sample that is
   * not `true`, so it succeeded instantly, before the prompt had even fired,
   * and would have passed with no guard at all. Asking the handler is
   * deterministic: a refusal consumes nothing, so the test can make the call
   * itself.
   */
  test('the notice is refused, and not consumed, while the window is unseen', async ({
    window
  }) => {
    expect(await invoke<boolean>(window, 'telemetry:noticeDue')).toBe(false)
    expect(await storeValue<unknown>(window, 'telemetryPromptShown')).not.toBe(true)

    // Nothing on screen to dismiss either.
    await expect(window.getByText('已為你開啟匿名使用統計')).toHaveCount(0)
  })

  test('and with the gate shut, an upload cannot happen', async ({ window }) => {
    const status = await invoke<{ enabled: boolean; lastUploadAt: string | null }>(
      window,
      'telemetry:uploadNow'
    )
    // Default-on since 1.3.0, so this is the interesting combination: the
    // setting says yes and the notice still has not been shown to anybody.
    expect(status.enabled).toBe(true)
    expect(status.lastUploadAt, 'an upload happened before the notice was ever shown').toBeNull()
  })

  test('launching again brings the window out of the tray, and the notice with it', async ({
    app,
    window
  }) => {
    // What a second launch does, without launching a second Electron: the same
    // handler the shortcut reaches.
    await app.evaluate(({ app: electronApp }) => electronApp.emit('second-instance'))

    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) => {
            const main = BrowserWindow.getAllWindows().find((w) =>
              w.webContents.getURL().includes('renderer/index.html')
            )
            return main?.isVisible() ?? false
          }),
        { timeout: 10_000, message: 'a second launch did not reveal the window' }
      )
      .toBe(true)

    // The guard defers the notice, it does not cancel it: `window:shown` makes
    // the prompt ask again, and now the answer is yes.
    await expect(window.getByText('已為你開啟匿名使用統計')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => storeValue<unknown>(window, 'telemetryPromptShown')).toBe(true)
  })
})
