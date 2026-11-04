import { Alert, Box, Typography } from '@mui/material'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import RestoreOutlinedIcon from '@mui/icons-material/RestoreOutlined'
import React, { useCallback, useEffect, useState } from 'react'
import type { SyncBackup } from '@shared/sync'
import DataRow from './DataRow'
import SoftButton from '../Common/SoftButton'
import AppDialog from '../Common/AppDialog'
import { PANEL_SX, noteSx } from '../Common/surfaces'
import { motion } from '../Common/motion'

/**
 * The automatic local backups, and putting one back: a row in the 資料管理 card
 * that says when the latest one was taken, and a dialog to pick one.
 *
 * Backups are taken before clearing data as well as before sync rewrites
 * anything, so this belongs to data management, not to sync: a build without a
 * Google client never shows the sync section. The IPC still lives under `sync:`
 * because the backup code is sync's.
 *
 * The row is there even with no backup yet, so the safety net is visible before
 * anyone needs it. `dataVersion` changes whenever a sibling may have made one.
 */
const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

const fmtBytes = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** Why a backup exists, from the reason in its file name (`lifecycle.ts`). */
const REASON: Record<string, string> = {
  'before-clear': '清除資料前',
  'before-first-sync': '第一次同步前',
  'before-apply': '同步前',
  'before-rollback': '還原前'
}

const BackupSettings: React.FC<{ dataVersion: number; onDataChanged(): void }> = ({
  dataVersion,
  onDataChanged
}) => {
  const [backups, setBackups] = useState<SyncBackup[]>([])
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<SyncBackup | null>(null)
  const [syncOn, setSyncOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<SyncBackup | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.sync
      .backups()
      .then(setBackups)
      .catch(() => setBackups([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, dataVersion])

  const openDialog = (): void => {
    setPick(null)
    setDone(null)
    setError(null)
    setOpen(true)
    window.sync
      .status()
      .then((s) => setSyncOn(s.enabled))
      .catch(() => setSyncOn(false))
  }

  const restore = async (target: SyncBackup): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.sync.rollback(target.file)
      setDone(target)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setPick(null)
      onDataChanged()
    }
  }

  const latest = backups[0]

  return (
    <>
      <DataRow
        icon={<RestoreOutlinedIcon />}
        title="還原備份"
        caption={
          latest
            ? `最近一次：${fmtTime(latest.createdAt)}（${REASON[latest.reason] ?? '自動備份'}）`
            : '清除資料前會自動備份，目前還沒有備份'
        }
        action={
          <SoftButton disabled={!latest} onClick={openDialog}>
            還原⋯
          </SoftButton>
        }
      />

      <AppDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        maxWidth="xs"
        title="還原備份"
        icon={<RestoreOutlinedIcon fontSize="small" />}
        actions={
          done ? (
            <SoftButton tone="primary" emphasis="solid" onClick={() => setOpen(false)}>
              完成
            </SoftButton>
          ) : (
            <>
              <SoftButton disabled={busy} onClick={() => setOpen(false)}>
                取消
              </SoftButton>
              <SoftButton
                tone="warning"
                emphasis="solid"
                disabled={busy || !pick}
                onClick={() => pick && void restore(pick)}
              >
                {busy ? '還原中⋯' : '還原'}
              </SoftButton>
            </>
          )
        }
      >
        {done ? (
          <Alert severity="success" sx={noteSx('success')}>
            已還原到 {fmtTime(done.createdAt)}
          </Alert>
        ) : (
          <Box display="flex" flexDirection="column" gap={1.5}>
            {/* Pick a row, then confirm with the footer button: one step, and
                nothing happens on the click that only chooses. */}
            <Box sx={{ ...PANEL_SX, overflow: 'hidden' }} role="radiogroup" aria-label="備份">
              {backups.map((b, i) => {
                const on = pick?.file === b.file
                return (
                  <Box
                    key={b.file}
                    role="radio"
                    aria-checked={on}
                    tabIndex={0}
                    onClick={() => setPick(b)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setPick(b)
                      }
                    }}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.5,
                      px: 1.75,
                      py: 1.1,
                      cursor: 'pointer',
                      outline: 'none',
                      borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                      bgcolor: on ? 'rgba(240,180,80,0.08)' : 'transparent',
                      transition: motion(['background-color'], 'fast'),
                      '&:hover': {
                        bgcolor: on ? 'rgba(240,180,80,0.11)' : 'rgba(255,255,255,0.03)'
                      },
                      '&:focus-visible': { boxShadow: 'inset 0 0 0 2px rgba(144,202,249,0.6)' }
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography fontSize={14} fontWeight={500}>
                        {fmtTime(b.createdAt)}
                      </Typography>
                      <Typography fontSize={12} color="text.secondary">
                        {REASON[b.reason] ?? '自動備份'} · {fmtBytes(b.bytes)}
                      </Typography>
                    </Box>
                    <CheckCircleRoundedIcon
                      sx={{
                        fontSize: 18,
                        color: '#f0b450',
                        opacity: on ? 1 : 0,
                        transition: motion(['opacity'], 'fast')
                      }}
                    />
                  </Box>
                )
              })}
            </Box>
            <Typography fontSize={12.5} color="text.secondary">
              對局、牌組與標籤會還原到所選的時間點，目前的資料會先備份。
              {syncOn && '同步會關閉。'}
            </Typography>
          </Box>
        )}
        {error && (
          <Alert severity="error" sx={{ ...noteSx('error'), mt: 2 }}>
            {error}
          </Alert>
        )}
      </AppDialog>
    </>
  )
}

export default BackupSettings
