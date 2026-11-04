import { Alert, Box, CircularProgress, Snackbar, Tooltip } from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import IosShareIcon from '@mui/icons-material/IosShare'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import React, { useCallback, useEffect, useState } from 'react'
import InfoHint from '@renderer/components/Common/InfoHint'
import { SectionRow, SwitchRow } from '../Common/SectionLayout'
import SoftButton from '../Common/SoftButton'

type Summary = {
  eventCount: number
  frameCount: number
  bytes: number
  latestAt: string | null
  /** Size of the engine's own startup log, which is written unconditionally. */
  logBytes: number
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type Props = {
  enabled: boolean
  onToggle: (checked: boolean) => void
}

/**
 * Shows what the analyzer has recorded about its own recognition failures, and
 * lets the user hand it over.
 *
 * The counters are the point: they make failures the user never noticed
 * visible, such as a template score drifting to just under its threshold.
 */
const DiagnosticsSettings: React.FC<Props> = ({ enabled, onToggle }) => {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; severity: 'success' | 'info' } | null>(null)

  const refresh = useCallback(() => {
    window.diagnostics
      .summary()
      .then(setSummary)
      .catch((e) => console.error('Failed to load diagnostics summary:', e))
  }, [])

  useEffect(() => {
    refresh()
    // The analyzer reports each new anomaly, so the counter stays live without
    // polling while the user is watching this page.
    return window.diagnostics.onRecorded(refresh)
  }, [refresh])

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    try {
      const filePath = await window.diagnostics.exportBundle()
      setToast(
        filePath
          ? { text: `已匯出至 ${filePath}`, severity: 'success' }
          : { text: '沒有可匯出的紀錄', severity: 'info' }
      )
    } catch (e) {
      console.error('Export failed:', e)
      setToast({ text: '匯出失敗，請查看主控台訊息', severity: 'info' })
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    setBusy(true)
    try {
      setSummary(await window.diagnostics.clear())
      setToast({ text: '已清除本機診斷紀錄', severity: 'success' })
    } finally {
      setBusy(false)
    }
  }

  const noAnomalies = !summary || (summary.eventCount === 0 && summary.frameCount === 0)
  // The engine log is written whatever this toggle says, so there is almost
  // always something worth handing over - and when recognition never started,
  // it is the ONLY thing worth handing over. Gating the button on anomalies
  // alone is what turned "the engine never ran" into "沒有可匯出的紀錄".
  const nothingToExport = !summary || (noAnomalies && summary.logBytes === 0)

  const statusLine = enabled
    ? summary === null
      ? '讀取中…'
      : noAnomalies
        ? summary.logBytes > 0
          ? '目前沒有記錄到異常，但已有引擎啟動記錄可供回報。'
          : '目前沒有記錄到異常。'
        : `已記錄 ${summary.eventCount} 筆事件、${summary.frameCount} 張畫面（約 ${formatBytes(summary.bytes)}）${
            summary.latestAt ? `，最近一筆：${new Date(summary.latestAt).toLocaleString()}` : ''
          }`
    : '目前已關閉，不會記錄辨識異常（引擎啟動記錄仍會保留）。'

  return (
    <>
      <SwitchRow
        title="記錄辨識異常（僅存本機）"
        checked={enabled}
        onChange={onToggle}
        adornment={
          <InfoHint
            title={
              <span>
                辨識失敗大多不會有明顯症狀——例如比對分數悄悄掉到門檻邊緣、OCR
                讀出無效內容、或結算畫面無法歸因到任何模式。開啟後，程式會把這些「自己也不確定」的情況記錄在本機，方便你回報問題時一併提供。紀錄只存在你的電腦上，不會自動上傳。
              </span>
            }
            label="說明：記錄辨識異常會記錄什麼"
            size={15}
            color="text.secondary"
          />
        }
      />
      <SectionRow
        title="診斷包"
        description={statusLine}
        control={
          <Box display="flex" gap={1} alignItems="center">
            <SoftButton
              tone="primary"
              startIcon={busy ? <CircularProgress size={15} color="inherit" /> : <IosShareIcon />}
              onClick={handleExport}
              disabled={busy || nothingToExport}
            >
              匯出
            </SoftButton>
            <Tooltip title="開啟資料夾">
              <SoftButton
                aria-label="開啟資料夾"
                onClick={() => window.diagnostics.openFolder()}
                sx={{ px: 1 }}
              >
                <FolderOpenIcon sx={{ fontSize: 17 }} />
              </SoftButton>
            </Tooltip>
            <Tooltip title="清除紀錄">
              <span>
                <SoftButton
                  tone="danger"
                  aria-label="清除紀錄"
                  onClick={handleClear}
                  disabled={busy || nothingToExport}
                  sx={{ px: 1 }}
                >
                  <DeleteSweepIcon sx={{ fontSize: 17 }} />
                </SoftButton>
              </span>
            </Tooltip>
            {/* Inside the row so the section's row separators never touch it;
                it is fixed-position and draws at the bottom of the window. */}
            <Snackbar
              open={toast !== null}
              autoHideDuration={6000}
              onClose={() => setToast(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            >
              <Alert severity={toast?.severity ?? 'info'} onClose={() => setToast(null)}>
                {toast?.text}
              </Alert>
            </Snackbar>
          </Box>
        }
      />
    </>
  )
}

export default DiagnosticsSettings
