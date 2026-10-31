import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  Typography
} from '@mui/material'
import React, { useCallback, useEffect, useState } from 'react'
import type { SyncAccountInfo, SyncDevice, SyncFirstChoice, SyncStatus } from '@shared/sync'
import IOSSwitch from '../Common/IOSSwitch'

/**
 * Cross-device sync: sign in with Google, turn it on, see how it went.
 *
 * Opt-in and said plainly. This is the one place the app sends the CONTENT of a
 * user's records (matches, decks, notes, tags, and the opponent-name picture),
 * where telemetry sends counts - so the text spells out what leaves, and nothing
 * here starts by itself. Signing in does not turn it on; the switch does, and the
 * first time it can ask a question that rewrites local data (plan J-1), so it is
 * a separate step with a backup behind it.
 *
 * Failure is quiet by design: a round that goes wrong leaves one line of text
 * here and changes nothing else in the app.
 *
 * A build without a Google client renders nothing at all, heading included -
 * not a section that only says "not available". The backup list that used to
 * close this section is `BackupSettings`, under data management, because it
 * serves clearing data too and has to be there in such a build.
 *
 * `onDataChanged` is called after anything that may have backed up or rewritten
 * local data; `dataVersion` changes when a sibling section did.
 */
const fmtTime = (ms: number | null): string => (ms ? new Date(ms).toLocaleString() : '尚未同步過')

const fmtBytes = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

const SyncSettings: React.FC<{ dataVersion: number; onDataChanged(): void }> = ({
  dataVersion,
  onDataChanged
}) => {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [account, setAccount] = useState<SyncAccountInfo | null>(null)
  const [devices, setDevices] = useState<SyncDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await window.sync.status()
      setStatus(next)
      if (next.signedIn && next.configured) {
        // Failures here are not worth a message: the account block is a nicety.
        window.sync
          .account()
          .then(setAccount)
          .catch(() => setAccount(null))
        window.sync
          .devices()
          .then(setDevices)
          .catch(() => setDevices([]))
      } else {
        setAccount(null)
        setDevices([])
      }
    } catch (e) {
      console.error('Failed to load sync status:', e)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, dataVersion])

  // While a round is running, look again every couple of seconds.
  useEffect(() => {
    if (!status?.syncing) return
    const t = setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [status?.syncing, refresh])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } catch (e) {
      console.error('sync action failed:', e)
    } finally {
      setBusy(false)
      await refresh()
      onDataChanged()
    }
  }

  const handleSignIn = (): Promise<void> =>
    run(async () => {
      const result = await window.sync.signIn()
      if (result.needsChoice) setAsking(true)
    })

  const handleToggle = (checked: boolean): Promise<void> =>
    run(async () => {
      if (!checked) {
        await window.sync.disable()
        return
      }
      const result = await window.sync.enable()
      if (result.needsChoice) setAsking(true)
    })

  const answer = (choice: SyncFirstChoice): Promise<void> => {
    setAsking(false)
    return run(() => window.sync.enable(choice))
  }

  if (status === null || !status.configured) return null

  const statusLine = ((): React.ReactNode => {
    if (status.syncing) return '同步中⋯'
    if (status.needsUpdate) {
      return '另一台裝置的版本比這台新，請更新後再同步。你的資料沒有遺失。'
    }
    if (status.backoffUntil) return '同步服務暫時不可用，稍後會自動重試。'
    const parts = [`上次同步：${fmtTime(status.lastSyncAt)}`]
    if (status.pending > 0) parts.push(`${status.pending} 筆變更等待上傳`)
    return parts.join(' · ')
  })()

  return (
    <>
      <Divider sx={{ mt: '10px', mb: '20px' }} />
      <Box display={'flex'} flexDirection={'column'} gap={1}>
        <Typography variant="h5">跨裝置同步</Typography>
        <Box display="flex" flexDirection="column" gap={1.5} maxWidth={560}>
          {!status.signedIn ? (
            <>
              <Typography variant="body2" color="text.secondary">
                用 Google 帳號把對局紀錄、牌組、標籤與備註同步到你其他的電腦。預設關閉；
                登入後還要再按一次開關才會開始。
              </Typography>
              <Typography variant="body2" color="text.secondary">
                資料存放在你自己的 Google
                雲端硬碟裡這個應用程式專用的隱藏資料夾，不會出現在你的檔案列表，
                也不經過我們的伺服器。內容包含對局紀錄（含備註，以及從對戰畫面裁下的「對手名稱」截圖）、
                牌組與標籤，會占用你的 Google 儲存空間。這和「分享對局數據」不同：那邊只送匿名計數。
              </Typography>
              <Box>
                <Button variant="outlined" disabled={busy} onClick={() => void handleSignIn()}>
                  使用 Google 登入
                </Button>
              </Box>
            </>
          ) : (
            <>
              <Typography variant="body2">
                已登入為 <b>{status.email}</b>
                {status.memoryOnlyCredentials && (
                  <Typography component="span" variant="body2" color="warning.main">
                    {' '}
                    （這台電腦無法加密儲存登入資訊，重新開啟後需要再登入一次）
                  </Typography>
                )}
              </Typography>

              <FormControlLabel
                control={
                  <IOSSwitch
                    checked={status.enabled}
                    disabled={busy}
                    onChange={(_, checked) => void handleToggle(checked)}
                  />
                }
                label="同步對局與牌組"
              />

              {status.enabled && (
                <Typography variant="body2" color="text.secondary">
                  {statusLine}
                </Typography>
              )}
              {status.lastError && <Alert severity="warning">{status.lastError}</Alert>}

              <Box display="flex" gap={1} flexWrap="wrap">
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy || !status.enabled || status.syncing}
                  onClick={() => void run(() => window.sync.syncNow())}
                >
                  立即同步
                </Button>
                <Button
                  size="small"
                  variant="text"
                  disabled={busy}
                  onClick={() => void run(() => window.sync.signOut())}
                >
                  登出
                </Button>
              </Box>

              {account && (
                <Typography variant="body2" color="text.secondary">
                  雲端硬碟用量 {fmtBytes(account.bytesUsed)} · {account.activeDevices} 台裝置
                </Typography>
              )}

              {devices.length > 0 && (
                <Box display="flex" flexDirection="column" gap={0.5}>
                  <Typography variant="subtitle2">裝置</Typography>
                  {devices.map((d) => (
                    <Typography key={d.id} variant="body2">
                      {d.name}
                      {d.self && '（這台）'}
                      <Typography component="span" variant="caption" color="text.secondary">
                        {' · '}最後連線 {fmtTime(d.lastSeenAt)}
                        {!d.active && ' · 已閒置'}
                      </Typography>
                    </Typography>
                  ))}
                  <Typography variant="caption" color="text.secondary">
                    要讓某台裝置不能再存取，請到 Google 帳號的「第三方存取權」移除這個應用程式，
                    然後重新登入其他裝置。
                  </Typography>
                </Box>
              )}

              <Divider />

              <Box display="flex" gap={1} flexWrap="wrap">
                <Button
                  size="small"
                  variant="text"
                  disabled={busy}
                  onClick={() => void run(() => window.sync.exportAccount())}
                >
                  匯出雲端資料
                </Button>
                <Button
                  size="small"
                  variant="text"
                  color="error"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  刪除雲端資料
                </Button>
              </Box>
            </>
          )}

          {/* J-1: the one question sync asks. Two answers, no third. */}
          <Dialog open={asking} onClose={() => setAsking(false)}>
            <DialogTitle>這台電腦和雲端都已經有資料</DialogTitle>
            <DialogContent>
              <DialogContentText component="div">
                同步是雙向的：選「合併」，這台電腦的對局也會上傳並出現在你的其他裝置上，
                包括任何測試用的資料。選「以雲端為準」，這台電腦現有的對局、牌組與標籤會被雲端的取代。
                <br />
                <br />
                兩種做法都會先備份這台電腦的資料，之後可以在下方「資料備份」還原。
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setAsking(false)}>先不要</Button>
              <Button onClick={() => void answer('cloud')}>以雲端為準</Button>
              <Button variant="contained" onClick={() => void answer('merge')}>
                合併
              </Button>
            </DialogActions>
          </Dialog>

          <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
            <DialogTitle>刪除雲端資料？</DialogTitle>
            <DialogContent>
              <DialogContentText>
                會刪除這個應用程式存放在你 Google
                雲端硬碟裡的所有同步資料，並撤銷授權、登出。這台電腦上的資料不受影響，其他裝置也會保留自己的資料，
                但之後不再同步。無法復原。
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmDelete(false)}>取消</Button>
              <Button
                color="error"
                onClick={() => {
                  setConfirmDelete(false)
                  void run(() => window.sync.deleteAccount())
                }}
              >
                刪除
              </Button>
            </DialogActions>
          </Dialog>
        </Box>
      </Box>
    </>
  )
}

export default SyncSettings
