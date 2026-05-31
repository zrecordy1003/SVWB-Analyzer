/* UpdateSettings.tsx */

import React, { useEffect, useMemo, useRef, useState } from 'react'
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

const UpdateSettings: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<any | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [lastNone, setLastNone] = useState<null | { version?: string }>(null) // 用來顯示「已最新」

  const sessionUnsubs = useRef<(() => void)[]>([])

  useEffect(() => {
    window.appInfo?.getVersion?.().then((v) => setAppVersion(v ?? ''))
  }, [])

  const clearSession = () => {
    sessionUnsubs.current.forEach((off) => off && off())
    sessionUnsubs.current = []
  }

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
      case 'error':
        return '更新失敗'
      default:
        return 'Updates'
    }
  }, [phase])

  const onCheck = async () => {
    setError(null)
    setLastNone(null)
    setPhase('checking') // 不開 Dialog，等結果

    // 一次性監聽（only for this check）
    const offAvailable = window.updates.onAvailable((i) => {
      setInfo(i)
      setPhase('available')
      setOpen(true)
      // 下載進度 & 完成：在本次 session 期間有效
      const offProgress = window.updates.onProgress((p) => {
        setPhase('downloading')
        setProgress(p.percent ?? 0)
      })
      const offDownloaded = window.updates.onDownloaded((ii) => {
        setInfo(ii)
        setPhase('downloaded')
      })
      sessionUnsubs.current.push(offProgress, offDownloaded)
      ;[offNone, offError].forEach((off) => off())
    })
    const offNone = window.updates.onNone((i) => {
      setInfo(i)
      setPhase('none') // 不開 Dialog
      setLastNone({ version: i?.version })
      ;[offAvailable, offError].forEach((off) => off())
    })
    const offError = window.updates.onError((err) => {
      setError(err)
      setPhase('error')
      setOpen(true)
      ;[offAvailable, offNone].forEach((off) => off())
    })

    // 保存一次性反註冊（若使用者中途關閉設定頁）
    sessionUnsubs.current.push(offAvailable, offNone, offError)

    const r = await window.updates.check()
    if (!r.ok) {
      // IPC 直接失敗（未等到事件）
      setError(r.error ?? 'Unknown error')
      setPhase('error')
      setOpen(true)
      clearSession()
    }
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
    await window.updates.install()
  }

  const handleClose = () => {
    setOpen(false)
    clearSession()
  }

  return (
    <>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Button variant="outlined" onClick={onCheck}>
          檢查更新
        </Button>
        {/* 無更新：只在設定區塊以小字提示，不彈窗 */}
        {phase === 'none' && (
          <Typography variant="caption" color="text.secondary">
            當前已是最新版本（v{appVersion}
            {lastNone?.version ? ` / 最新 v${lastNone.version}` : ''}）
          </Typography>
        )}
      </Stack>

      <Dialog
        open={open}
        onClose={() => {
          if (phase !== 'downloading') handleClose()
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
            <Typography variant="body2">
              更新已下載完成，請點擊「安裝並重啟」以套用更新。
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
              <Button onClick={handleClose}>取消</Button>
              <Button onClick={onDownload} variant="contained">
                下載
              </Button>
            </>
          )}
          {phase === 'downloading' && <Button disabled>更新檔下載中...</Button>}
          {phase === 'downloaded' && (
            <>
              <Button onClick={handleClose}>取消</Button>
              <Button onClick={onInstall} variant="contained">
                安裝並重啟
              </Button>
            </>
          )}
          {phase === 'error' && (
            <Button onClick={handleClose} autoFocus>
              關閉
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  )
}

export default UpdateSettings
