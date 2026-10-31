import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography
} from '@mui/material'
import React, { useCallback, useEffect, useState } from 'react'
import type { SyncBackup } from '@shared/sync'

/**
 * The automatic local backups, and putting one back.
 *
 * Backups are taken before clearing data as well as before sync rewrites
 * anything, so this list belongs to data management, not to sync: it used to sit
 * at the bottom of the sync section, which a build without a Google client never
 * shows, and the clear-data dialog was pointing users at a list they could not see.
 * The IPC still lives under `sync:` because the backup code is sync's.
 *
 * `dataVersion` changes whenever a sibling section may have made a new backup.
 */
const fmtTime = (ms: number): string => new Date(ms).toLocaleString()

const fmtBytes = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

const BackupSettings: React.FC<{ dataVersion: number; onDataChanged(): void }> = ({
  dataVersion,
  onDataChanged
}) => {
  const [backups, setBackups] = useState<SyncBackup[]>([])
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<SyncBackup | null>(null)

  const refresh = useCallback(() => {
    window.sync
      .backups()
      .then(setBackups)
      .catch(() => setBackups([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, dataVersion])

  const rollback = async (target: SyncBackup): Promise<void> => {
    setBusy(true)
    try {
      await window.sync.rollback(target.file)
    } catch (e) {
      console.error('rollback failed:', e)
    } finally {
      setBusy(false)
      onDataChanged()
    }
  }

  if (backups.length === 0) return null

  return (
    <Box display="flex" flexDirection="column" gap={0.5} maxWidth={560}>
      <Typography variant="subtitle2">資料備份</Typography>
      <Typography variant="caption" color="text.secondary">
        清除資料前、第一次同步前、套用其他裝置的變更前，都會先備份本機資料，只保留最近幾份。還原會把本機退回那個時間點。
      </Typography>
      {backups.map((b) => (
        <Box key={b.file} display="flex" alignItems="center" gap={1}>
          <Typography variant="body2" sx={{ flex: 1 }}>
            {fmtTime(b.createdAt)} · {fmtBytes(b.bytes)}
          </Typography>
          <Button size="small" disabled={busy} onClick={() => setConfirm(b)}>
            還原
          </Button>
        </Box>
      ))}

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        <DialogTitle>還原到這份備份？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            本機的對局、牌組與標籤會退回 {confirm ? fmtTime(confirm.createdAt) : ''}
            的樣子；如果開著同步，同步會關閉。還原前會再備份一次目前的狀態。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>取消</Button>
          <Button
            color="warning"
            onClick={() => {
              const target = confirm
              setConfirm(null)
              if (target) void rollback(target)
            }}
          >
            還原
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default BackupSettings
