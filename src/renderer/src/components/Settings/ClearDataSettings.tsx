import { Alert, Box, ButtonBase, CircularProgress, Typography } from '@mui/material'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined'
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'
import SportsEsportsOutlinedIcon from '@mui/icons-material/SportsEsportsOutlined'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined'
import React, { useState } from 'react'
import type { ClearCounts, ClearResult, ClearSelection } from '@shared/clearData'
import { invokeIpc } from '@renderer/ipc'
import DataRow from './DataRow'
import SoftButton from '../Common/SoftButton'
import AppDialog, { DANGER_ACCENT } from '../Common/AppDialog'
import { noteSx } from '../Common/surfaces'

/**
 * Clear recorded data: a row in the 資料管理 card, and a dialog to choose what goes.
 *
 * Each kind is a tile with its own icon and how many there are, because the
 * useful question here is "what exactly would this remove" - the number is the
 * biggest thing on the tile. Matches are selected by default and the rest are
 * opt-in; a kind with none is shown but cannot be picked. What a selected kind
 * takes with it is listed under the tiles, so the consequence is read before
 * the button, and the button itself says how many records it will delete.
 *
 * The dialog is neutral; red is kept for what will actually be deleted (the
 * selected tiles and the confirm button), so the colour means something. Nothing
 * is removed until that button is pressed, a copy of the database is taken first,
 * and with sync on the dialog says the deletion reaches the other devices too.
 */
const KINDS: Array<{
  key: keyof ClearCounts
  label: string
  unit: string
  hint: string
  icon: React.ReactNode
}> = [
  {
    key: 'matches',
    label: '對局資料',
    unit: '場',
    hint: '包含每場的起手手牌',
    icon: <SportsEsportsOutlinedIcon />
  },
  {
    key: 'decks',
    label: '牌組',
    unit: '副',
    hint: '對局會保留，牌組欄位會清空',
    icon: <StyleOutlinedIcon />
  },
  {
    key: 'tags',
    label: '標籤',
    unit: '個',
    hint: '從所有對局移除',
    icon: <LocalOfferOutlinedIcon />
  },
  {
    key: 'categories',
    label: '牌組分類',
    unit: '個',
    hint: '只刪除自訂分類，牌組改為未分類',
    icon: <FolderOutlinedIcon />
  }
]

const NONE: ClearSelection = { matches: false, decks: false, tags: false, categories: false }

const RED = DANGER_ACCENT

/** One selectable kind. A real checkbox to assistive tech; a card to the eye and hand. */
const KindTile: React.FC<{
  label: string
  unit: string
  icon: React.ReactNode
  count: number | null
  checked: boolean
  disabled: boolean
  onToggle(): void
}> = ({ label, unit, icon, count, checked, disabled, onToggle }) => (
  <ButtonBase
    role="checkbox"
    aria-checked={checked}
    disabled={disabled}
    onClick={onToggle}
    disableRipple
    sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      textAlign: 'left',
      gap: 1.25,
      p: 1.5,
      borderRadius: '12px',
      border: '1px solid',
      borderColor: checked ? `${RED}8c` : 'rgba(255,255,255,0.08)',
      bgcolor: checked ? `${RED}14` : 'rgba(255,255,255,0.025)',
      transition: 'background-color 140ms, border-color 140ms, box-shadow 140ms',
      '&:hover': {
        bgcolor: checked ? `${RED}1c` : 'rgba(255,255,255,0.05)',
        borderColor: checked ? `${RED}b3` : 'rgba(255,255,255,0.16)'
      },
      '&:active': { bgcolor: checked ? `${RED}24` : 'rgba(255,255,255,0.07)' },
      '&.Mui-focusVisible': { boxShadow: `0 0 0 2px rgba(144,202,249,0.7)` },
      '&.Mui-disabled': { opacity: 0.38 }
    }}
  >
    <Box display="flex" alignItems="center" justifyContent="space-between">
      <Box
        sx={{
          display: 'grid',
          color: checked ? RED : 'text.secondary',
          transition: 'color 140ms',
          '& svg': { fontSize: 18 }
        }}
      >
        {icon}
      </Box>
      {/* The check: an empty ring, filled red when selected. */}
      <Box
        sx={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          border: '1.5px solid',
          borderColor: checked ? RED : 'rgba(255,255,255,0.28)',
          bgcolor: checked ? RED : 'transparent',
          color: '#fff',
          transition: 'background-color 140ms, border-color 140ms',
          '& svg': { fontSize: 13, opacity: checked ? 1 : 0, transition: 'opacity 140ms' }
        }}
      >
        <CheckRoundedIcon />
      </Box>
    </Box>
    <Box>
      <Typography fontSize={13} color="text.secondary" lineHeight={1.3}>
        {label}
      </Typography>
      <Typography
        component="div"
        sx={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}
      >
        {count ?? '—'}
        <Typography component="span" fontSize={13} color="text.secondary" ml={0.5}>
          {unit}
        </Typography>
      </Typography>
    </Box>
  </ButtonBase>
)

const ClearDataSettings: React.FC<{ onCleared(): void }> = ({ onCleared }) => {
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
    setCounts(null)
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
  const available = KINDS.filter((k) => (counts?.[k.key] ?? 0) > 0)
  const allChosen = available.length > 0 && chosen.length === available.length

  const toggleAll = (): void => {
    const next = { ...NONE }
    if (!allChosen) for (const k of available) next[k.key] = true
    setSelection(next)
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // Only what is selected AND exists: a selected kind with none to remove is not a request.
      const toSend = { ...NONE }
      for (const k of chosen) toSend[k.key] = true
      setResult(await invokeIpc('data:clear', toSend))
      onCleared()
      setCounts(await invokeIpc('data:clearCounts'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleted = result
    ? KINDS.filter((k) => result.deleted[k.key] > 0)
        .map((k) => `${k.label} ${result.deleted[k.key]} ${k.unit}`)
        .join('、')
    : ''

  return (
    <>
      <DataRow
        icon={<DeleteOutlineIcon />}
        title="清除資料"
        caption="刪除對局、牌組或標籤，刪除前會自動備份"
        action={
          <SoftButton tone="danger" onClick={() => void openDialog()}>
            清除⋯
          </SoftButton>
        }
      />

      <AppDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        maxWidth="xs"
        title={result ? undefined : '清除資料'}
        subtitle={result ? undefined : '選擇要刪除的資料'}
        actions={
          result ? (
            <SoftButton onClick={() => setOpen(false)} sx={{ width: '100%' }}>
              完成
            </SoftButton>
          ) : (
            <Box display="flex" alignItems="center" gap={1} width="100%">
              <Box
                display="flex"
                alignItems="center"
                gap={0.75}
                sx={{ flex: 1, minWidth: 0, color: 'text.secondary' }}
              >
                <VerifiedUserOutlinedIcon sx={{ fontSize: 16 }} />
                <Typography fontSize={12.5} noWrap>
                  刪除前自動備份
                </Typography>
              </Box>
              <SoftButton disabled={busy} onClick={() => setOpen(false)}>
                取消
              </SoftButton>
              <SoftButton
                tone="danger"
                emphasis="solid"
                disabled={busy || total === 0}
                onClick={() => void confirm()}
                startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
                sx={{ minWidth: 96 }}
              >
                {busy ? '刪除中' : total > 0 ? `刪除 ${total} 筆` : '刪除'}
              </SoftButton>
            </Box>
          )
        }
      >
        {result ? (
          // Done: one clear outcome, and the way back.
          <Box display="flex" flexDirection="column" alignItems="center" textAlign="center" py={1}>
            <CheckCircleRoundedIcon sx={{ fontSize: 44, color: '#5cc98a', mb: 1.5 }} />
            <Typography fontSize={17} fontWeight={600} mb={0.5}>
              已清除{deleted}
            </Typography>
            <Typography fontSize={13} color="text.secondary">
              可以在「還原備份」還原到清除前的狀態。
              {result.syncs && '其他裝置也會在下次同步時一併清除。'}
            </Typography>
          </Box>
        ) : (
          <Box display="flex" flexDirection="column" gap={1.5}>
            <Box display="grid" gridTemplateColumns="1fr 1fr" gap={1}>
              {KINDS.map((k) => {
                const n = counts?.[k.key] ?? null
                return (
                  <KindTile
                    key={k.key}
                    label={k.label}
                    unit={k.unit}
                    icon={k.icon}
                    count={n}
                    checked={selection[k.key] && (n ?? 0) > 0}
                    disabled={busy || counts === null || n === 0}
                    onToggle={() => setSelection((s) => ({ ...s, [k.key]: !s[k.key] }))}
                  />
                )
              })}
            </Box>

            <Box display="flex" alignItems="flex-start" gap={1}>
              <Box sx={{ flex: 1, minWidth: 0, minHeight: 20 }}>
                {chosen.length === 0 ? (
                  <Typography fontSize={12.5} color="text.secondary">
                    {counts === null ? '讀取中⋯' : '尚未選擇'}
                  </Typography>
                ) : (
                  chosen.map((k) => (
                    <Typography key={k.key} fontSize={12.5} color="text.secondary" lineHeight={1.6}>
                      <Box component="span" sx={{ color: 'text.primary' }}>
                        {k.label}
                      </Box>
                      ：{k.hint}
                    </Typography>
                  ))
                )}
                {syncOn && chosen.length > 0 && (
                  <Typography fontSize={12.5} color="warning.light" lineHeight={1.6}>
                    已開啟同步，其他裝置也會一併刪除
                  </Typography>
                )}
              </Box>
              {available.length > 1 && (
                <ButtonBase
                  onClick={toggleAll}
                  disabled={busy}
                  sx={{
                    fontSize: 12.5,
                    color: 'text.secondary',
                    px: 1,
                    py: 0.25,
                    borderRadius: '6px',
                    '&:hover': { color: 'text.primary', bgcolor: 'rgba(255,255,255,0.06)' },
                    '&.Mui-focusVisible': { boxShadow: '0 0 0 2px rgba(144,202,249,0.7)' }
                  }}
                >
                  {allChosen ? '取消全選' : '全選'}
                </ButtonBase>
              )}
            </Box>
          </Box>
        )}
        {error && (
          <Alert severity="error" sx={{ ...noteSx('error'), mt: 2 }}>
            {error === 'NOTHING_SELECTED' ? '請至少選擇一項。' : error}
          </Alert>
        )}
      </AppDialog>
    </>
  )
}

export default ClearDataSettings
