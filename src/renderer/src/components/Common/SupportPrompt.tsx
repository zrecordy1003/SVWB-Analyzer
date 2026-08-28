import { useEffect, useState } from 'react'
import { Alert, Box, Button, Snackbar, Stack, Typography } from '@mui/material'

import { SUPPORT_LINKS, supportUrl, type SupportPromptPayload } from '@shared/support'

/**
 * The one and only time the app brings up donations by itself.
 *
 * Main decides whether a milestone is due and marks it shown on the way out, so
 * this component never has to remember anything - and an ignored toast is never
 * replayed. It is a Snackbar, not a dialog: nothing is blocked, nothing counts
 * down, and 「不再顯示」 is one click away.
 */

/** Let the window settle - startup, splash and the first analyzer tick first. */
const APPEAR_DELAY_MS = 8000

function promptText(payload: SupportPromptPayload): string {
  if (payload.reason === 'matches') {
    return `已經幫你記錄 ${payload.matchCount} 場對局了。`
  }
  return `你已經開啟 SVWB Analyzer ${payload.launchCount} 次了。`
}

const SupportPrompt = (): React.JSX.Element => {
  const [payload, setPayload] = useState<SupportPromptPayload | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      window.support
        .check()
        .then((due) => {
          if (!cancelled) setPayload(due)
        })
        .catch(() => {
          /* Decoration. A failed check simply means no prompt. */
        })
    }, APPEAR_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const close = (): void => setPayload(null)

  const handleOptOut = (): void => {
    void window.support.optOut()
    close()
  }

  return (
    <Snackbar
      open={payload !== null}
      onClose={close}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <Alert severity="info" icon={false} onClose={close} sx={{ maxWidth: 380 }}>
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="body2">{payload ? promptText(payload) : ''}</Typography>
            <Typography variant="body2" color="text.secondary">
              工具是免費的，之後也會是。如果它對你有幫助，可以考慮小額贊助支持後續維護。
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {SUPPORT_LINKS.map((link) => (
              <Button
                key={link.key}
                size="small"
                variant="outlined"
                onClick={() => {
                  window.electronAPI.openLink(supportUrl(link, 'milestone'))
                  close()
                }}
              >
                {link.label}
              </Button>
            ))}
            <Button size="small" color="inherit" onClick={handleOptOut}>
              不再顯示
            </Button>
          </Stack>
        </Stack>
      </Alert>
    </Snackbar>
  )
}

export default SupportPrompt
