/* eslint-disable @typescript-eslint/no-explicit-any */
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

type UpdatePromptProps = {
  isCheckButtonVisible?: boolean
}

const UpdatePrompt: React.FC<UpdatePromptProps> = ({ isCheckButtonVisible = true }) => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<any | null>(null)
  const [appVersion, setAppVersion] = useState<string>('')

  useEffect(() => {
    // 抓一次當前 app 版號
    window.appInfo?.getVersion?.().then((v) => setAppVersion(v ?? ''))
  }, [])

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

  const onCheck = async (): Promise<void> => {
    setError(null)
    const r = await window.updates.check()
    if (!r.ok) {
      setError(r.error ?? 'Unknown error')
      setPhase('error')
      setOpen(true)
    } else setOpen(true)
  }

  const onDownload = async (): Promise<void> => {
    setError(null)
    setPhase('downloading')
    setProgress(0)
    const r = await window.updates.download()
    if (!r.ok) {
      setError(r.error ?? 'Download failed')
      setPhase('error')
    }
  }

  const onInstall = async (): Promise<void> => {
    await window.updates.install()
  }

  const releaseDate = info?.releaseDate ? new Date(info.releaseDate).toLocaleString() : null

  return (
    <>
      {isCheckButtonVisible && (
        <Button variant="outlined" size="small" onClick={onCheck}>
          檢查更新
        </Button>
      )}

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
                {/* A new version is available */}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                點擊更新以獲取最新版本
                {/* Click “Download” to fetch the update in the background. */}
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
              更新已下載完成，請點擊「安裝並重啟」以套用更新。
              {/* The update has been downloaded. Click “Install & Restart” to apply it. */}
            </Typography>
          )}

          {phase === 'none' && (
            <Stack spacing={0.5}>
              <Typography variant="body2">當前版本: v{appVersion}</Typography>
              {info?.version && <Typography variant="body2">最新版本: v{info.version}</Typography>}
              {releaseDate && (
                <Typography variant="body2" color="text.secondary">
                  {/* Released on:  */}
                  發佈日期：{releaseDate}
                </Typography>
              )}
              <Typography sx={{ mt: 0.5 }} variant="body2">
                當前已經是最新版本
                {/* You already have the latest version. */}
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
                {/* Install & Restart */}
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
    </>
  )
}

export default UpdatePrompt
