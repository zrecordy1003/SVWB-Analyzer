import { useEffect, useState } from 'react'
import { Alert, Box, Snackbar, Typography } from '@mui/material'

/**
 * The one time the app says that it shares anonymous statistics.
 *
 * This used to ask. It tells now, because a buried opt-in switch gets
 * single-digit participation and a matchup table built from single digits is
 * worse than no table at all - see `settings.telemetry` in main/store.ts.
 *
 * What it must never become is silent. Main blocks every upload until this has
 * been handed to a window (`telemetryPromptShown`), so this component is the
 * gate: nothing leaves a machine that has not seen this text. That is why the
 * text says what is sent rather than linking to somewhere that does.
 *
 * It carried three buttons until 1.3.0 - 知道了, 看會送出什麼, 關閉統計 - which
 * were removed on request, along with the payload view they pointed at
 * (`Settings/TelemetrySettings.tsx`). So this is now text and a close button,
 * and the switch in Settings is the only opt-out. Nothing about the gate
 * changed: this still has to be shown before anything is sent.
 *
 * Shown once per install, like `SupportPrompt`: main marks it on the way out,
 * so a reload cannot replay it and an ignored toast still counts as told.
 */

/**
 * The fallback ask, for a `window:shown` that arrived before this mounted.
 *
 * Measured, because the name used to claim otherwise: in a packaged 1.3.0 the
 * notice appears ~1.45s after launch (1.44 / 1.47 / 1.46 over three runs), so
 * the `window:shown` ask below is what fires in practice and this timer never
 * gets there first. It is still the only thing covering the other order - main
 * broadcasting before this component subscribed - and since the notice is the
 * upload gate, an install that missed the broadcast would otherwise be told
 * nothing at all. So it stays, as a backstop rather than as the schedule.
 *
 * The old comment here said the delay put this after the support prompt's slot
 * «so the two cannot land together». That reasoning was wrong twice over: the
 * two are anchored at opposite corners (bottom-left here, bottom-right there),
 * and the ask that actually fires does not wait at all.
 */
const FALLBACK_ASK_DELAY_MS = 12_000

const TelemetryPrompt = (): React.JSX.Element => {
  const [open, setOpen] = useState(false)

  /**
   * Ask when the window is shown, and once more on a timer in case that was
   * missed.
   *
   * Whether the notice may be marked as shown is main's decision, not this
   * component's - `telemetry:noticeDue` refuses, without consuming anything,
   * while the window it was asked from is invisible. That matters because
   * `--hidden` starts the app into the tray with this renderer running behind
   * it.
   *
   * Which is why the ask is tied to `window:shown` rather than to anything
   * here: `document.visibilityState` reads `visible` even in a window that has
   * never been shown, so there is no local signal to wait on.
   */
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const ask = (): void => {
      window.telemetry
        .noticeDue()
        .then((due) => {
          if (!cancelled && due) setOpen(true)
        })
        .catch(() => {
          /* A failed check simply means no notice - and no upload either. */
        })
    }

    const arm = (): void => {
      if (cancelled || timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        if (!cancelled) ask()
      }, FALLBACK_ASK_DELAY_MS)
    }

    const unsubscribe = window.electron?.ipcRenderer.on('window:shown', () => {
      if (!cancelled) ask()
    })

    arm()

    return () => {
      cancelled = true
      unsubscribe?.()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const close = (): void => setOpen(false)

  return (
    <Snackbar open={open} onClose={close} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
      <Alert severity="info" icon={false} onClose={close} sx={{ maxWidth: 400 }}>
        <Box>
          <Typography variant="body2">已開啟數據統計</Typography>
          <Typography variant="body2" color="text.secondary">
            只送出版本、作業系統，以及每日對局依職業與勝負的<strong>計數</strong>
            ——沒有牌組名稱、備註、時間或任何能識別你的資料。彙總環境數據後，公開給所有人看。隨時可以關閉。
          </Typography>
        </Box>
      </Alert>
    </Snackbar>
  )
}

export default TelemetryPrompt
