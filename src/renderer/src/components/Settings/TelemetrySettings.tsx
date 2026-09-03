import { Box, FormControlLabel, Tooltip, Typography } from '@mui/material'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import React, { useCallback, useEffect, useState } from 'react'
import type { TelemetryStatus } from '@shared/telemetry'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import IOSSwitch from '../Common/IOSSwitch'

/**
 * The switch for anonymous usage statistics.
 *
 * The switch is inert - and says so - when the build has no endpoint. A switch
 * that silently sends nothing would be a worse lie than no switch.
 *
 * # What used to be here
 *
 * A 「看會送出什麼」 button that printed `telemetry.preview()` verbatim, and a
 * 「立即上傳」 that forced an upload. Both were removed on request for 1.3.0,
 * along with the notice's buttons, so this panel is the switch and its tooltip.
 *
 * Worth writing down what that costs, because the argument was made in the
 * other direction once and the code should not lose it: telemetry is default-ON
 * since 1.3.0, and reading the payload was the only way for a user to CHECK the
 * claim about what is sent rather than take it on trust. Without it the notice's
 * text is the whole disclosure. The IPC behind it is untouched
 * (`telemetry:preview`, `telemetry:uploadNow` - both still handled, still
 * covered by `tests/main/telemetry.test.ts`), so restoring the view is a UI
 * change and nothing more.
 *
 * The switch itself is the part that must not go: it is the opt-out, and it is
 * now the only one.
 */
const TelemetrySettings: React.FC = () => {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [busy, setBusy] = useState(false)

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

      {!configured && (
        <Typography variant="body2" color="warning.main">
          這個版本沒有設定統計伺服器，開關暫時無法使用。
        </Typography>
      )}
    </Box>
  )
}

export default TelemetrySettings
