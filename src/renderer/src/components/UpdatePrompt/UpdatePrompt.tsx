// src/renderer/src/components/UpdatePrompt.tsx
import React, { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  LinearProgress,
  Stack,
  Typography,
  Snackbar,
  Alert
} from '@mui/material'

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error'

export default function UpdatePrompt() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<any | null>(null)

  // 訂閱 updater 事件
  useEffect(() => {
    const off1 = window.updates.onChecking(() => {
      setPhase('checking')
      setOpen(true)
    })
    const off2 = window.updates.onAvailable((i) => {
      setInfo(i)
      setPhase('available')
      setOpen(true)
    })
    const off3 = window.updates.onNone((_i) => {
      setPhase('none')
      setOpen(false)
    })
    const off4 = window.updates.onError((err) => {
      setError(err)
      setPhase('error')
      setOpen(true)
    })
    const off5 = window.updates.onProgress((p) => {
      setPhase('downloading')
      setProgress(p.percent ?? 0)
      setOpen(true)
    })
    const off6 = window.updates.onDownloaded((i) => {
      setInfo(i)
      setPhase('downloaded')
      setOpen(true)
    })
    return () => [off1, off2, off3, off4, off5, off6].forEach((off) => off && off())
  }, [])

  const title = useMemo(() => {
    switch (phase) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return 'Update available'
      case 'downloading':
        return 'Downloading update…'
      case 'downloaded':
        return 'Update ready to install'
      case 'error':
        return 'Update error'
      default:
        return 'Updates'
    }
  }, [phase])

  const onCheck = async () => {
    setError(null)
    const r = await window.updates.check()
    if (!r.ok) {
      setError(r.error ?? 'Unknown error')
      setPhase('error')
      setOpen(true)
    } else setOpen(true)
  }

  const onDownload = async () => {
    setError(null)
    setPhase('downloading')
    setProgress(0)
    const r = await window.updates.download()
    if (!r.ok) {
      setError(r.error ?? 'Download failed')
      setPhase('error')
    }
  }

  const onInstall = async () => {
    await window.updates.install() // app will quit and restart
  }

  // 也可以把這個元件放到設定頁；我這邊加一個快捷按鈕方便人工觸發
  return (
    <>
      <Button variant="outlined" size="small" onClick={onCheck}>
        Check for Updates
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (phase !== 'downloading') setOpen(false)
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogContent dividers>
          {phase === 'available' && (
            <Stack spacing={1}>
              <Typography variant="body2">
                A new version is available{info?.version ? `: v${info.version}` : ''}.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Click “Download” to fetch the update in the background.
              </Typography>
            </Stack>
          )}

          {phase === 'downloading' && (
            <Stack spacing={1} sx={{ minWidth: 320 }}>
              <LinearProgress variant="determinate" value={progress} />
              <Typography variant="caption" color="text.secondary">
                {progress.toFixed(1)}%
              </Typography>
            </Stack>
          )}

          {phase === 'downloaded' && (
            <Typography variant="body2">
              The update has been downloaded. Click “Install & Restart” to apply it.
            </Typography>
          )}

          {phase === 'error' && (
            <Alert severity="error" variant="outlined">
              {error}
            </Alert>
          )}
        </DialogContent>

        <DialogActions>
          {phase === 'available' && (
            <>
              <Button onClick={() => setOpen(false)}>Later</Button>
              <Button onClick={onDownload} variant="contained">
                Download
              </Button>
            </>
          )}

          {phase === 'downloading' && (
            <>
              <Button disabled>Downloading…</Button>
            </>
          )}

          {phase === 'downloaded' && (
            <>
              <Button onClick={() => setOpen(false)}>Later</Button>
              <Button onClick={onInstall} variant="contained">
                Install & Restart
              </Button>
            </>
          )}

          {phase === 'error' && <Button onClick={() => setOpen(false)}>Close</Button>}

          {phase === 'checking' && <Button disabled>Checking…</Button>}
        </DialogActions>
      </Dialog>

      <Snackbar
        open={phase === 'none'}
        autoHideDuration={2500}
        onClose={() => setPhase('idle')}
        message="You're up to date"
      />
    </>
  )
}
