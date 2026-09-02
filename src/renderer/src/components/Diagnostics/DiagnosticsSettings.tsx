import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  Snackbar,
  Tooltip
} from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import IosShareIcon from '@mui/icons-material/IosShare'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import React, { useCallback, useEffect, useState } from 'react'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import IOSSwitch from '../Common/IOSSwitch'

type Summary = {
  eventCount: number
  frameCount: number
  bytes: number
  latestAt: string | null
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

  const nothingRecorded = !summary || (summary.eventCount === 0 && summary.frameCount === 0)

  const statusLine = enabled
    ? summary === null
      ? '讀取中…'
      : nothingRecorded
        ? '目前沒有記錄到異常。'
        : `已記錄 ${summary.eventCount} 筆事件、${summary.frameCount} 張畫面（約 ${formatBytes(summary.bytes)}）${
            summary.latestAt ? `，最近一筆：${new Date(summary.latestAt).toLocaleString()}` : ''
          }`
    : '目前已關閉，不會產生任何紀錄。'

  return (
    <Box display="flex" flexDirection="column" gap={1.5}>
      <FormControlLabel
        control={<IOSSwitch checked={enabled} onChange={(_, checked) => onToggle(checked)} />}
        label={
          <Box display="flex" alignItems="center" gap={0.5}>
            <span>記錄辨識異常（僅存本機）</span>
            <Tooltip
              title={
                <Box display="flex" flexDirection="column" gap={0.5}>
                  <span>
                    辨識失敗大多不會有明顯症狀——例如比對分數悄悄掉到門檻邊緣、OCR
                    讀出無效內容、或結算畫面無法歸因到任何模式。開啟後，程式會把這些「自己也不確定」的情況記錄在本機，方便你回報問題時一併提供。紀錄只存在你的電腦上，不會自動上傳。
                  </span>
                  <span>{statusLine}</span>
                </Box>
              }
              placement="top"
              slotProps={{ tooltip: { sx: { ...TOOLTIP_SURFACE_SX, maxWidth: 360 } } }}
            >
              <HelpOutlineIcon
                fontSize="small"
                sx={{ display: 'block', color: 'text.secondary', cursor: 'default' }}
              />
            </Tooltip>
          </Box>
        }
      />

      <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
        <Button
          variant="contained"
          size="small"
          startIcon={busy ? <CircularProgress size={16} /> : <IosShareIcon />}
          onClick={handleExport}
          disabled={busy || nothingRecorded}
        >
          匯出診斷包
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<FolderOpenIcon />}
          onClick={() => window.diagnostics.openFolder()}
        >
          開啟資料夾
        </Button>
        <Button
          variant="outlined"
          size="small"
          color="error"
          startIcon={<DeleteSweepIcon />}
          onClick={handleClear}
          disabled={busy || nothingRecorded}
        >
          清除紀錄
        </Button>
      </Box>

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
  )
}

export default DiagnosticsSettings
