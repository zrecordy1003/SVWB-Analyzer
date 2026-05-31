/* UpdateBackground.tsx */

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
  Alert
} from '@mui/material'

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error'

const UpdateBackground: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<any | null>(null)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.appInfo?.getVersion?.().then((v) => setAppVersion(v ?? ''))
  }, [])

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
    const off3 = window.updates.onNone((i) => {
      setInfo(i)
      setPhase('none')
      setOpen(true)
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
        return '正在檢查更新...'
      case 'available':
        return '發現可用的更新'
      case 'downloading':
        return '更新下載中...'
      case 'downloaded':
        return '下載完成，安裝已就緒'
      case 'none':
        return '目前已是最新版本！'
      case 'error':
        return '更新失敗'
      default:
        return 'Updates'
    }
  }, [phase])

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
    await window.updates.install()
  }

  return (
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
              偵測到有新版本{info?.version ? `: v${info.version}` : ''}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              點擊更新以獲取最新版本
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
          <Typography variant="body2">更新已下載完成，請點擊「安裝並重啟」以套用更新。</Typography>
        )}

        {phase === 'none' && (
          <Stack spacing={0.5}>
            <Typography variant="body2">當前版本: v{appVersion}</Typography>
            {info?.version && <Typography variant="body2">最新版本: v{info.version}</Typography>}
            {info?.releaseDate && (
              <Typography variant="body2" color="text.secondary">
                發佈日期：{new Date(info.releaseDate).toLocaleString()}
              </Typography>
            )}
            <Typography sx={{ mt: 0.5 }} variant="body2">
              當前已經是最新版本
            </Typography>
          </Stack>
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
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={onDownload} variant="contained">
              下載
            </Button>
          </>
        )}
        {phase === 'downloading' && <Button disabled>更新檔下載中...</Button>}
        {phase === 'downloaded' && (
          <>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={onInstall} variant="contained">
              安裝並重啟
            </Button>
          </>
        )}
        {(phase === 'none' || phase === 'error' || phase === 'checking') && (
          <Button onClick={() => setOpen(false)} autoFocus>
            關閉
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

export default UpdateBackground
