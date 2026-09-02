import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Collapse,
  FormControlLabel,
  Snackbar,
  Typography
} from '@mui/material'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import CodeIcon from '@mui/icons-material/Code'
import React, { useCallback, useEffect, useState } from 'react'
import type { TelemetryPayload, TelemetryStatus } from '@shared/telemetry'
import IOSSwitch from '../Common/IOSSwitch'

/**
 * The switch for anonymous usage statistics, and the proof of what it sends.
 *
 * The proof is the point, and more so since 1.3.0 made this on by default: a
 * privacy paragraph asks to be believed, while the 「檢視會送出的內容」 button
 * shows the actual JSON that the next upload would carry, built by the same
 * code that builds the real one. Anyone can read it and see there is no deck
 * name, note, tag or timestamp in it - and then turn it off in one click.
 *
 * The switch is inert - and says so - when the build has no endpoint. A switch
 * that silently sends nothing would be a worse lie than no switch.
 */
const TelemetrySettings: React.FC = () => {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [preview, setPreview] = useState<TelemetryPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; severity: 'success' | 'error' } | null>(null)

  const refresh = useCallback(() => {
    window.telemetry
      .status()
      .then(setStatus)
      .catch((e) => console.error('Failed to load telemetry status:', e))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleToggle = async (checked: boolean): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.telemetry.setEnabled(checked))
    } catch (e) {
      console.error('Failed to change telemetry setting:', e)
    } finally {
      setBusy(false)
    }
  }

  const handlePreview = async (): Promise<void> => {
    if (preview) {
      setPreview(null)
      return
    }
    setBusy(true)
    try {
      setPreview(await window.telemetry.preview())
    } catch (e) {
      console.error('Failed to build telemetry preview:', e)
    } finally {
      setBusy(false)
    }
  }

  const handleUpload = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.telemetry.uploadNow()
      setStatus(next)
      setToast(
        next.lastError
          ? { text: `上傳失敗：${next.lastError}`, severity: 'error' }
          : { text: '已上傳', severity: 'success' }
      )
    } finally {
      setBusy(false)
    }
  }

  const enabled = status?.enabled === true
  const configured = status?.configured === true

  const matchesInPreview = preview
    ? preview.days.reduce(
        (sum, day) => sum + day.buckets.reduce((inner, bucket) => inner + bucket.count, 0),
        0
      )
    : 0

  return (
    <Box display="flex" flexDirection="column" gap={1.5}>
      <FormControlLabel
        control={
          <IOSSwitch
            checked={enabled}
            disabled={busy || status === null || !configured}
            onChange={(_, checked) => void handleToggle(checked)}
          />
        }
        label="分享匿名使用統計"
      />

      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 560 }}>
        這項預設是開啟的，關掉之後就不會再送出任何東西。開啟時，程式會定期送出：目前版本、作業系統，
        以及最近 14 天每日對局的<strong>計數</strong>
        （依模式、雙方職業、先後攻、勝負分組）。
        這些數字會和其他使用者的彙總成環境統計，之後在程式內與網頁上公開。
        <Box component="span" sx={{ display: 'block', mt: 0.5, fontWeight: 600 }}>
          不會送出牌組名稱、備註、標籤、對局時間、BP／MP／CR、帳號或任何可識別你的資料。
        </Box>
      </Typography>

      {status !== null && !configured && (
        <Typography variant="body2" color="warning.main">
          這個版本沒有設定統計伺服器，開關暫時無法使用。
        </Typography>
      )}

      {enabled && (
        <Typography variant="body2">
          {status?.lastError ? (
            <>
              最近一次上傳失敗：{status.lastError}
              {status.lastUploadAt
                ? `（上次成功：${new Date(status.lastUploadAt).toLocaleString()}）`
                : ''}
            </>
          ) : status?.lastUploadAt ? (
            <>上次上傳：{new Date(status.lastUploadAt).toLocaleString()}</>
          ) : (
            '尚未上傳過；啟動後幾秒內會送出第一次。'
          )}
        </Typography>
      )}

      <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
        <Button
          variant="outlined"
          size="small"
          startIcon={busy && !preview ? <CircularProgress size={16} /> : <CodeIcon />}
          onClick={handlePreview}
          disabled={busy || status === null}
        >
          {preview ? '收起' : '檢視會送出的內容'}
        </Button>
        <Button
          variant="contained"
          size="small"
          startIcon={<CloudUploadIcon />}
          onClick={handleUpload}
          disabled={busy || !enabled || !configured}
        >
          立即上傳
        </Button>
      </Box>

      <Collapse in={preview !== null} unmountOnExit>
        <Box display="flex" flexDirection="column" gap={0.5}>
          <Typography variant="caption" color="text.secondary">
            這就是下一次上傳的完整內容：{preview?.days.length ?? 0} 天、共 {matchesInPreview}{' '}
            場對局的計數。
          </Typography>
          <Box
            component="pre"
            sx={(t) => ({
              m: 0,
              p: 1.5,
              maxHeight: 320,
              maxWidth: 720,
              overflow: 'auto',
              fontSize: 12,
              lineHeight: 1.45,
              borderRadius: 1,
              bgcolor: t.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
              border: `1px solid ${t.palette.divider}`
            })}
          >
            {preview ? JSON.stringify(preview, null, 2) : ''}
          </Box>
        </Box>
      </Collapse>

      <Snackbar
        open={toast !== null}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.severity ?? 'success'} onClose={() => setToast(null)}>
          {toast?.text}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default TelemetrySettings
