import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Typography
} from '@mui/material'
import React, { useState } from 'react'
import type { ClearCounts, ClearResult, ClearSelection } from '@shared/clearData'
import { invokeIpc } from '@renderer/ipc'

/**
 * Clear recorded data: a button, and a dialog that lets the user choose what goes.
 *
 * Matches are ticked by default and the rest are opt-in, each with how many there
 * are, because the useful question here is "what exactly would this remove".
 * Nothing is removed until the confirm button is pressed, a copy of the database is
 * taken first (the result says where), and if sync is on the dialog says that the
 * deletion will reach the other devices - the one consequence people do not expect
 * from a button on a single machine.
 */
const KINDS: Array<{
  key: keyof ClearCounts
  label: string
  unit: string
  hint: string
}> = [
  {
    key: 'matches',
    label: '對局資料',
    unit: '場',
    hint: '包含每場的起手手牌與標籤關聯。'
  },
  {
    key: 'decks',
    label: '牌組',
    unit: '副',
    hint: '對局裡用過的牌組欄位會變成空白，對局本身不受影響。'
  },
  {
    key: 'tags',
    label: '標籤',
    unit: '個',
    hint: '對局上的標籤會一併拿掉。'
  },
  {
    key: 'categories',
    label: '牌組分類',
    unit: '個',
    hint: '只有你自己建立的；內建的三個分類不會被刪。牌組會變成未分類。'
  }
]

const NONE: ClearSelection = { matches: false, decks: false, tags: false, categories: false }

const ClearDataSettings: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState<ClearCounts | null>(null)
  const [selection, setSelection] = useState<ClearSelection>({ ...NONE, matches: true })
  const [syncOn, setSyncOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ClearResult | null>(null)

  const openDialog = async (): Promise<void> => {
    setError(null)
    setResult(null)
    setSelection({ ...NONE, matches: true })
    setOpen(true)
    try {
      const [c, status] = await Promise.all([invokeIpc('data:clearCounts'), window.sync.status()])
      setCounts(c)
      setSyncOn(status.enabled)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const chosen = KINDS.filter((k) => selection[k.key] && (counts?.[k.key] ?? 0) > 0)
  const total = chosen.reduce((n, k) => n + (counts?.[k.key] ?? 0), 0)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // Only what is ticked AND exists: a ticked row with none to remove is not a request.
      const toSend = { ...NONE }
      for (const k of chosen) toSend[k.key] = true
      setResult(await invokeIpc('data:clear', toSend))
      setCounts(await invokeIpc('data:clearCounts'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box display="flex" flexDirection="column" gap={1.5} maxWidth={560}>
      <Typography variant="body2" color="text.secondary">
        刪除已經記錄的對局、牌組、標籤等資料。你可以自己選要清哪些。
      </Typography>
      <Box>
        <Button color="error" variant="outlined" onClick={() => void openDialog()}>
          清除資料⋯
        </Button>
      </Box>

      <Dialog open={open} onClose={() => !busy && setOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>清除資料</DialogTitle>
        <DialogContent>
          {result ? (
            <Box display="flex" flexDirection="column" gap={1.5}>
              <Alert severity="success">
                已清除：
                {KINDS.filter((k) => result.deleted[k.key] > 0)
                  .map((k) => `${k.label} ${result.deleted[k.key]} ${k.unit}`)
                  .join('、')}
                。
              </Alert>
              <DialogContentText>
                清除前已自動備份。要退回去，可以在「跨裝置同步」區塊最下面的備份列表按「還原」。
                {result.syncs && '另外，其他裝置與雲端的對應資料也會在下次同步時一併清除。'}
              </DialogContentText>
            </Box>
          ) : (
            <>
              <DialogContentText sx={{ mb: 1 }}>選擇要清除的資料：</DialogContentText>
              {counts === null && !error && (
                <Box display="flex" justifyContent="center" py={2}>
                  <CircularProgress size={24} />
                </Box>
              )}
              {counts !== null && (
                <Box display="flex" flexDirection="column">
                  {KINDS.map((k) => {
                    const n = counts[k.key]
                    return (
                      <Box key={k.key} sx={{ py: 0.5 }}>
                        <FormControlLabel
                          disabled={n === 0 || busy}
                          control={
                            <Checkbox
                              checked={selection[k.key] && n > 0}
                              onChange={(_, checked) =>
                                setSelection((s) => ({ ...s, [k.key]: checked }))
                              }
                            />
                          }
                          label={
                            <span>
                              {k.label}
                              <Typography component="span" color="text.secondary">
                                {'　'}
                                {n} {k.unit}
                              </Typography>
                            </span>
                          }
                        />
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          display="block"
                          sx={{ ml: 4, mt: -0.5 }}
                        >
                          {k.hint}
                        </Typography>
                      </Box>
                    )
                  })}
                </Box>
              )}
              {total > 0 && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  即將刪除共 {total} 筆資料，無法在 App 內復原（會先自動備份）。
                  {syncOn && ' 你已開啟同步：其他裝置與雲端的對應資料也會一併刪除。'}
                </Alert>
              )}
            </>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error === 'NOTHING_SELECTED' ? '請至少選一項。' : error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          {result ? (
            <Button variant="contained" onClick={() => setOpen(false)}>
              完成
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                color="error"
                variant="contained"
                disabled={busy || total === 0}
                onClick={() => void confirm()}
              >
                {busy ? '清除中⋯' : '清除'}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default ClearDataSettings
