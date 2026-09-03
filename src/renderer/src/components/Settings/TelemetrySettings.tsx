import {
  Box,
  Button,
  CircularProgress,
  Collapse,
  FormControlLabel,
  Tooltip,
  Typography
} from '@mui/material'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import CodeRoundedIcon from '@mui/icons-material/CodeRounded'
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined'
import React, { useCallback, useEffect, useState } from 'react'
import type { TelemetryPayload, TelemetryStatus } from '@shared/telemetry'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import IOSSwitch from '../Common/IOSSwitch'

/**
 * The switch for anonymous usage statistics, and the payload behind it.
 *
 * The switch is inert - and says so - when the build has no endpoint. A switch
 * that silently sends nothing would be a worse lie than no switch.
 *
 * The payload view is not a nicety. The one-time notice offers a
 * 「看會送出什麼」 button that brings the user here, and for a while this panel
 * was a switch and a tooltip - so the consent flow promised to show something
 * it then did not. `telemetry:preview` and `telemetry:uploadNow` had both been
 * wired through preload and never called from anywhere.
 *
 * It shows the real thing, verbatim: `telemetry.preview()` builds exactly what
 * an upload would send, through the same `rollup.ts` the upload uses. Reading
 * it is the only way to check the claim rather than take it - which is the
 * point of a default-on setting.
 *
 * `mintInstallId: false` on the main side, so looking does not create an
 * install id for someone who then decides against it; the placeholder in its
 * place says so.
 */
const TelemetrySettings: React.FC = () => {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPayload, setShowPayload] = useState(false)
  const [payloadText, setPayloadText] = useState<string | null>(null)
  const [payloadError, setPayloadError] = useState<string | null>(null)
  const [loadingPayload, setLoadingPayload] = useState(false)
  const [uploading, setUploading] = useState(false)

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

  /**
   * Fetched on open rather than on mount, and re-fetched every time: the
   * payload changes as matches are played, and a stale one shown as "what will
   * be sent" would be the same broken promise in a smaller form.
   */
  const togglePayload = async (): Promise<void> => {
    if (showPayload) {
      setShowPayload(false)
      return
    }
    setShowPayload(true)
    setLoadingPayload(true)
    setPayloadError(null)
    try {
      const payload: TelemetryPayload = await window.telemetry.preview()
      setPayloadText(JSON.stringify(payload, null, 2))
    } catch (e) {
      setPayloadError(`讀取失敗：${(e as Error).message}`)
    } finally {
      setLoadingPayload(false)
    }
  }

  const handleUploadNow = async (): Promise<void> => {
    setUploading(true)
    try {
      setStatus(await window.telemetry.uploadNow())
    } catch (e) {
      console.error('Failed to upload telemetry:', e)
    } finally {
      setUploading(false)
    }
  }

  const enabled = status?.enabled === true
  const configured = status?.configured === true

  const lastUploadLine = status?.lastError ? (
    <>
      最近一次上傳失敗：{status.lastError}
      {status.lastUploadAt ? `（上次成功：${new Date(status.lastUploadAt).toLocaleString()}）` : ''}
    </>
  ) : status?.lastUploadAt ? (
    <>上次上傳：{new Date(status.lastUploadAt).toLocaleString()}</>
  ) : (
    '尚未上傳過；啟動後幾秒內會送出第一次。'
  )

  if (status === null) return null

  return (
    <Box display="flex" flexDirection="column" gap={1.5}>
      <FormControlLabel
        control={
          <IOSSwitch
            checked={enabled}
            disabled={busy || !configured}
            onChange={(_, checked) => void handleToggle(checked)}
          />
        }
        label={
          <Box display="flex" alignItems="center" gap={0.5}>
            <span>分享對局數據</span>
            <Tooltip
              title={
                <Box display="flex" flexDirection="column" gap={0.5}>
                  <span>開啟後，定期上傳對戰資料，不會收集任何隱私資料，且不佔用頻寬。</span>
                  {enabled && <span>{lastUploadLine}</span>}
                </Box>
              }
              placement="top"
              slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
            >
              <HelpOutlineIcon
                fontSize="small"
                sx={{ display: 'block', color: 'text.secondary', cursor: 'default' }}
              />
            </Tooltip>
          </Box>
        }
      />

      {status !== null && !configured && (
        <Typography variant="body2" color="warning.main">
          這個版本沒有設定統計伺服器，開關暫時無法使用。
        </Typography>
      )}

      {configured && (
        <>
          <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
            <Button
              variant="outlined"
              size="small"
              startIcon={loadingPayload ? <CircularProgress size={16} /> : <CodeRoundedIcon />}
              onClick={() => void togglePayload()}
              disabled={loadingPayload}
            >
              {showPayload ? '收起送出內容' : '看會送出什麼'}
            </Button>
            {enabled && (
              <Button
                variant="outlined"
                size="small"
                startIcon={uploading ? <CircularProgress size={16} /> : <CloudUploadOutlinedIcon />}
                onClick={() => void handleUploadNow()}
                disabled={uploading}
              >
                立即上傳
              </Button>
            )}
          </Box>

          <Collapse in={showPayload} unmountOnExit>
            <Box display="flex" flexDirection="column" gap={0.75}>
              <Typography variant="caption" color="text.secondary">
                這就是下一次上傳的完整內容——「installId」是一組隨機碼，和任何帳號或裝置資訊無關；
                每一天都會送出，包含沒有對局的空白日。
              </Typography>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1.25,
                  maxHeight: 320,
                  overflow: 'auto',
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'action.hover',
                  fontFamily: 'monospace',
                  fontSize: 12,
                  lineHeight: 1.5,
                  // The payload is one long line per bucket; wrapping it would
                  // make the structure unreadable, so it scrolls instead.
                  whiteSpace: 'pre',
                  color: 'text.secondary',
                  userSelect: 'text'
                }}
              >
                {payloadError ?? payloadText ?? '讀取中…'}
              </Box>
              {status.installId === null && (
                <Typography variant="caption" color="text.secondary">
                  這台機器還沒有產生 installId——只有真的要上傳時才會建立。
                </Typography>
              )}
            </Box>
          </Collapse>
        </>
      )}
    </Box>
  )
}

export default TelemetrySettings
