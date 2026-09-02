import { useEffect, useState } from 'react'
import { Alert, Box, Button, Snackbar, Stack, Typography } from '@mui/material'

/**
 * The one time the app says that it shares anonymous statistics.
 *
 * This used to ask. It tells now, because a buried opt-in switch gets
 * single-digit participation and a matchup table built from single digits is
 * worse than no table at all - see `settings.telemetry` in main/store.ts.
 *
 * What it must never become is silent. Main blocks every upload until this has
 * been handed to a window (`telemetryPromptShown`), so this component is the
 * gate: nothing leaves a machine that has not seen this text. That is why it
 * says what is sent, in the toast itself, and puts 「關閉」 first among equals
 * rather than hiding it in Settings.
 *
 * Shown once per install, like `SupportPrompt`: main marks it on the way out,
 * so a reload cannot replay it and an ignored toast still counts as told.
 */

/** After the support prompt's slot, so the two cannot land together. */
const APPEAR_DELAY_MS = 12_000

type Props = {
  onOpenSettings: () => void
}

const TelemetryPrompt = ({ onOpenSettings }: Props): React.JSX.Element => {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      window.telemetry
        .noticeDue()
        .then((due) => {
          if (!cancelled && due) setOpen(true)
        })
        .catch(() => {
          /* A failed check simply means no notice - and no upload either. */
        })
    }, APPEAR_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const close = (): void => setOpen(false)

  const handleDisable = (): void => {
    void window.telemetry.setEnabled(false)
    close()
  }

  return (
    <Snackbar open={open} onClose={close} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
      <Alert severity="info" icon={false} onClose={close} sx={{ maxWidth: 400 }}>
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="body2">已為你開啟匿名使用統計</Typography>
            <Typography variant="body2" color="text.secondary">
              只送出版本、作業系統，以及每日對局依職業與勝負的<strong>計數</strong>
              ——沒有牌組名稱、備註、時間或任何能識別你的資料。彙總後的環境數據之後會公開給所有人看。隨時可以關閉。
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button size="small" variant="contained" onClick={close}>
              知道了
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                onOpenSettings()
                close()
              }}
            >
              看會送出什麼
            </Button>
            <Button size="small" color="inherit" onClick={handleDisable}>
              關閉統計
            </Button>
          </Stack>
        </Stack>
      </Alert>
    </Snackbar>
  )
}

export default TelemetryPrompt
