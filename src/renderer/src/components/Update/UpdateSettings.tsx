/* UpdateSettings.tsx - 設定頁的「檢查更新」，回報使用者問到的每一種結果。 */

import React, { useEffect, useRef, useState } from 'react'
import { Box, CircularProgress } from '@mui/material'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import type { UpdateProgress, UpdateSummary } from '@shared/updates'
import UpdateDialog, { type UpdatePhase } from './UpdateDialog'
import SoftButton from '../Common/SoftButton'
import { SettingRow } from '../Settings/SettingsLayout'

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
      <SettingRow
        title="版本"
        description={
          upToDate ? (
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              <CheckCircleRoundedIcon sx={{ fontSize: 14, color: 'success.main' }} />
              已是最新版本（v{appVersion}）
            </Box>
          ) : (
            `目前版本 v${appVersion}`
          )
        }
        control={
          <SoftButton
            onClick={onCheck}
            disabled={checking}
            startIcon={
              checking ? (
                <CircularProgress size={15} thickness={5} color="inherit" />
              ) : (
                <RefreshRoundedIcon />
              )
            }
          >
            {checking ? '檢查中…' : '檢查更新'}
          </SoftButton>
        }
      />

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
