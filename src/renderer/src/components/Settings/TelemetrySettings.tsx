import { Box, FormControlLabel, Typography } from '@mui/material'
import React, { useCallback, useEffect, useState } from 'react'
import type { TelemetryStatus } from '@shared/telemetry'
import InfoHint from '@renderer/components/Common/InfoHint'
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
            <InfoHint
              title={
                <Box display="flex" flexDirection="column" gap={0.75}>
                  <span>開啟後定期上傳，內容只有這些，而且是整天合併過的計數：</span>
                  {/*
                    起手那一行在 1.4.0 曾經被拿掉，因為當時沒有在上傳它——
                    文案是照計畫先寫的，而 schema 3 還沒做。現在做了，它回來了。

                    這一行不是可選的。`docs/mulligan-advisor-plan.md` 記著：
                    加卡片資料而不重新徵求同意，是專案擁有者判斷過的決定
                    （「這本質上就是對局數據的一環」），而那個判斷成立的前提
                    就是**說明要具體到讓人知道多了什麼**。拿掉這一行，
                    那個決定就變成沒有交代。
                  */}
                  <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
                    <li>職業、對手職業、先攻或後攻、模式、分數段、勝負</li>
                    <li>起手四張的卡號，以及各自有沒有被換掉</li>
                  </Box>
                  <span>
                    不含帳號、暱稱、牌組名稱、對手名字或任何可以認出你的東西，也不會上傳
                    單場紀錄——伺服器收到的是「這一天這種組合出現幾次」。
                  </span>
                  {enabled && <span>{lastUploadLine}</span>}
                </Box>
              }
              label="說明：分享對局數據會上傳什麼"
              size={18}
              color="text.secondary"
            />
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
