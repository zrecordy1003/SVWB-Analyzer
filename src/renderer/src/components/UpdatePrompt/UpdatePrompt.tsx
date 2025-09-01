/* eslint-disable @typescript-eslint/no-explicit-any */
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

type UpdatePromptProps = {
  /** 是否顯示「檢查更新」按鈕（設定頁可顯示；背景版可隱藏） */
  isCheckButtonVisible?: boolean
  /** 是否自動彈出對話框（背景/全域建議 true；設定頁建議 false） */
  autoPopup?: boolean
}

// --- cross-component flags (mutex-like) ---
const getDialogOpen = (): boolean => Boolean((globalThis as any).__updateDialogOpen)
const setDialogOpen = (v: boolean): boolean => ((globalThis as any).__updateDialogOpen = v)

const getUserChecking = (): boolean => Boolean((globalThis as any).__updateUserChecking)
const setUserChecking = (v: boolean): boolean => ((globalThis as any).__updateUserChecking = v)

const UpdatePrompt: React.FC<UpdatePromptProps> = ({
  isCheckButtonVisible = true,
  autoPopup = true
}) => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<any | null>(null)
  const [appVersion, setAppVersion] = useState<string>('')

  // 區分「使用者主動點擊」與「背景自動事件」
  const userTriggeredRef = useRef(false)

  const maybeOpen = (next: Phase): void => {
    // 主頁（autoPopup=false）：只在有意義的結果才開（排除 checking/none）
    const allowByUser =
      userTriggeredRef.current && next !== 'checking' && next !== 'none' && !getDialogOpen()

    // 背景（autoPopup=true）：平常自動開，但若使用者正在主動檢查，就不要搶視窗
    const allowByAuto = autoPopup && !getUserChecking() && !getDialogOpen()

    if (allowByUser || allowByAuto) {
      setOpen(true)
      setDialogOpen(true)
    }
  }

  const closeDialog = (): void => {
    setOpen(false)
    setDialogOpen(false)
    userTriggeredRef.current = false
    // 若是主動檢查的流程結束，也重置全域旗標
    if (getUserChecking()) setUserChecking(false)
  }

  useEffect(() => {
    window.appInfo?.getVersion?.().then((v) => setAppVersion(v ?? ''))
  }, [])

  // 訂閱 updater 事件
  useEffect(() => {
    const off1 = window.updates.onChecking(() => {
      setPhase('checking')
      // 主頁不開；背景若非使用者流程則可開
      maybeOpen('checking')
    })
    const off2 = window.updates.onAvailable((i) => {
      setInfo(i)
      setPhase('available')
      maybeOpen('available')
    })
    const off3 = window.updates.onNone((i) => {
      setInfo(i)
      setPhase('none')
      // 主頁不開；背景可開（維持原行為）
      maybeOpen('none')
    })
    const off4 = window.updates.onError((err) => {
      setError(err)
      setPhase('error')
      maybeOpen('error')
    })
    const off5 = window.updates.onProgress((p) => {
      setPhase('downloading')
      setProgress(p.percent ?? 0)
      maybeOpen('downloading')
    })
    const off6 = window.updates.onDownloaded((i) => {
      setInfo(i)
      setPhase('downloaded')
      maybeOpen('downloaded')
    })
    return () => [off1, off2, off3, off4, off5, off6].forEach((off) => off && off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPopup])

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
    userTriggeredRef.current = true
    setUserChecking(true)

    // 主頁需求：不要先開 Dialog，等事件回來（available / error / downloaded）再由 maybeOpen 判斷
    setPhase('checking')

    const r = await window.updates.check()
    if (!r.ok) {
      setError(r.error ?? 'Unknown error')
      setPhase('error')
      // 若檢查 API 直接回錯，仍需讓 UI 有機會顯示錯誤
      maybeOpen('error')
    }
  }

  const onDownload = async (): Promise<void> => {
    setError(null)
    userTriggeredRef.current = true
    setUserChecking(true)
    setPhase('downloading')
    setProgress(0)
    const r = await window.updates.download()
    if (!r.ok) {
      setError(r.error ?? 'Download failed')
      setPhase('error')
      maybeOpen('error')
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
          if (phase !== 'downloading') closeDialog()
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
            <>
              <Typography variant="body2">
                更新已下載完成，請點擊「安裝並重啟」以套用更新。
              </Typography>
              <Typography variant="caption">
                過程若遭遇 SVWB Analyzer 正在執行中，請點擊重試
              </Typography>
            </>
          )}

          {phase === 'none' && (
            <Stack spacing={0.5}>
              <Typography variant="body2">當前版本: v{appVersion}</Typography>
              {info?.version && <Typography variant="body2">最新版本: v{info.version}</Typography>}
              {releaseDate && (
                <Typography variant="body2" color="text.secondary">
                  發佈日期：{releaseDate}
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
              <Button onClick={closeDialog}>取消</Button>
              <Button onClick={onDownload} variant="contained">
                下載
              </Button>
            </>
          )}
          {phase === 'downloading' && <Button disabled>更新檔下載中...</Button>}
          {phase === 'downloaded' && (
            <>
              <Button onClick={closeDialog}>取消</Button>
              <Button onClick={onInstall} variant="contained">
                安裝並重啟
              </Button>
            </>
          )}
          {(phase === 'none' || phase === 'error' || phase === 'checking') && (
            <Button onClick={closeDialog} autoFocus>
              關閉
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  )
}

export default UpdatePrompt
