/* UpdateSettings.tsx - 設定頁的「檢查更新」，回報使用者問到的每一種結果。 */

import React, { useEffect, useRef, useState } from 'react'
import { Button, CircularProgress, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import type { UpdateProgress, UpdateSummary } from '@shared/updates'
import UpdateDialog, { type UpdatePhase } from './UpdateDialog'

const UpdateSettings: React.FC = () => {
  const [phase, setPhase] = useState<UpdatePhase>('available')
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<UpdateSummary | null>(null)
  const [appVersion, setAppVersion] = useState('')
  /** Set when a check came back with nothing - the one result with no dialog. */
  const [upToDate, setUpToDate] = useState(false)

  const unsubs = useRef<(() => void)[]>([])

  useEffect(() => {
    window.appInfo?.getVersion?.().then((v) => setAppVersion(v ?? ''))
    return () => unsubs.current.forEach((off) => off && off())
  }, [])

  /*
   * Unlike the background surface, this one answers everything: no update, a
   * failed check, a failed download. The user pressed a button and is owed a
   * result.
   *
   * Listeners are registered once and live for the session; `source` keeps the
   * background check's traffic out. The earlier version subscribed per click
   * and unsubscribed the losing branches by hand, which left the progress and
   * downloaded listeners attached after every check that found an update.
   */
  useEffect(() => {
    const mine = <T extends { source: string }>(fn: (p: T) => void) => {
      return (p: T): void => {
        if (p.source === 'settings') fn(p)
      }
    }

    unsubs.current = [
      window.updates.onAvailable(
        mine((p) => {
          setChecking(false)
          setUpToDate(false)
          setInfo(p.info)
          setPhase('available')
          setOpen(true)
        })
      ),
      window.updates.onNone(
        mine(() => {
          setChecking(false)
          setUpToDate(true)
        })
      ),
      window.updates.onProgress(
        mine((p) => {
          setPhase('downloading')
          setProgress(p)
        })
      ),
      window.updates.onDownloaded(
        mine((p) => {
          setInfo(p.info)
          setPhase('downloaded')
        })
      ),
      window.updates.onError(
        mine((p) => {
          setChecking(false)
          setError(p.error)
          setPhase('error')
          setOpen(true)
        })
      )
    ]
    return () => unsubs.current.forEach((off) => off && off())
  }, [])

  const onCheck = async (): Promise<void> => {
    setError(null)
    setUpToDate(false)
    setChecking(true)
    const r = await window.updates.check('settings')
    if (!r.ok) {
      // The invoke itself failed, so no 'error' event is coming.
      setChecking(false)
      setError(r.error ?? 'Unknown error')
      setPhase('error')
      setOpen(true)
    }
  }

  const onDownload = async (): Promise<void> => {
    setError(null)
    setPhase('downloading')
    setProgress(null)
    const r = await window.updates.download('settings')
    if (!r.ok) {
      setError(r.error ?? 'Download failed')
      setPhase('error')
    }
  }

  return (
    <>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        {/*
          A pill with a translucent fill instead of MUI's outlined default: on a
          dark surface a 1px outline reads as a disabled control, and this button
          sits in a column of settings rows where it has to look pressable
          without shouting louder than the update dialog's primary action.
        */}
        <Button
          onClick={onCheck}
          disabled={checking}
          disableElevation
          startIcon={
            checking ? (
              <CircularProgress size={15} thickness={5} color="inherit" />
            ) : (
              <RefreshRoundedIcon sx={{ fontSize: 18 }} />
            )
          }
          sx={(t) => ({
            borderRadius: 99,
            px: 2.25,
            py: 0.9,
            textTransform: 'none',
            fontWeight: 600,
            letterSpacing: 0.2,
            lineHeight: 1.2,
            color: 'text.primary',
            border: '1px solid',
            borderColor: alpha(t.palette.common.white, 0.12),
            bgcolor: alpha(t.palette.common.white, 0.05),
            transition: t.transitions.create(
              ['background-color', 'border-color', 'transform', 'box-shadow'],
              { duration: 180 }
            ),
            '&:hover': {
              bgcolor: alpha(t.palette.primary.main, 0.14),
              borderColor: alpha(t.palette.primary.main, 0.5),
              transform: 'translateY(-1px)',
              boxShadow: `0 4px 14px ${alpha(t.palette.primary.main, 0.22)}`
            },
            '&:active': { transform: 'translateY(0)', boxShadow: 'none' },
            '&.Mui-disabled': {
              color: 'text.secondary',
              borderColor: alpha(t.palette.common.white, 0.08),
              bgcolor: alpha(t.palette.common.white, 0.03)
            },
            // The icon keeps its slot at both sizes, so swapping the refresh
            // glyph for the spinner does not nudge the label sideways.
            '& .MuiButton-startIcon': { mr: 1, width: 18, justifyContent: 'center' }
          })}
        >
          {checking ? '檢查中…' : '檢查更新'}
        </Button>
        {upToDate && (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <CheckCircleRoundedIcon fontSize="small" color="success" />
            <Typography variant="caption" color="text.secondary">
              已是最新版本（v{appVersion}）
            </Typography>
          </Stack>
        )}
      </Stack>

      <UpdateDialog
        open={open}
        phase={phase}
        info={info}
        progress={progress}
        error={error}
        appVersion={appVersion}
        onClose={() => setOpen(false)}
        onDownload={onDownload}
        onInstall={() => window.updates.install()}
      />
    </>
  )
}

export default UpdateSettings
