/* UpdateDialog.tsx - the presentation shared by both update surfaces. */

import React, { useMemo } from 'react'
import AppDialog from '@renderer/components/Common/AppDialog'
import { Alert, Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SystemUpdateAltRoundedIcon from '@mui/icons-material/SystemUpdateAltRounded'
import type { ReleaseNote, UpdateProgress, UpdateSummary } from '@shared/updates'

export type UpdatePhase = 'available' | 'downloading' | 'downloaded' | 'error'

const MB = 1024 * 1024

const formatBytes = (n: number): string =>
  n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

const formatRate = (n: number): string => (n > 0 ? `${(n / MB).toFixed(1)} MB/s` : '—')

/** Seconds left at the current rate, or null when that cannot be said yet. */
const eta = (p: UpdateProgress): string | null => {
  if (!p.bytesPerSecond || !p.total || p.transferred >= p.total) return null
  const s = Math.round((p.total - p.transferred) / p.bytesPerSecond)
  if (s < 60) return `約 ${s} 秒`
  return `約 ${Math.round(s / 60)} 分`
}

/**
 * Release notes are plain text by the time they get here (main flattens the
 * HTML), so lines that came from list items are the ones starting with `• `.
 * Rendering them as real rows rather than one blob is most of what makes the
 * notes readable.
 */
const Notes: React.FC<{ notes: ReleaseNote[]; currentVersion: string }> = ({
  notes,
  currentVersion
}) => {
  if (notes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        這個版本沒有提供更新說明。
      </Typography>
    )
  }
  return (
    <Stack spacing={2}>
      {notes.map((note) => (
        <Stack key={note.version} spacing={0.75}>
          {notes.length > 1 && (
            <Typography
              variant="overline"
              color="text.secondary"
              // `overline` uppercases, which would render the version as V1.3.0
              // while the chips beside it say v1.3.0.
              sx={{ lineHeight: 1.6, textTransform: 'none', letterSpacing: 0.4 }}
            >
              v{note.version}
              {note.version === currentVersion ? '（最新）' : ''}
            </Typography>
          )}
          {note.body.split('\n').map((line, i) => {
            const trimmed = line.trim()
            if (!trimmed) return null
            const isBullet = trimmed.startsWith('• ')
            return (
              <Typography
                key={i}
                variant="body2"
                sx={{
                  color: isBullet ? 'text.primary' : 'text.secondary',
                  fontWeight: isBullet ? 400 : 600,
                  pl: isBullet ? 1.5 : 0,
                  lineHeight: 1.7
                }}
              >
                {trimmed}
              </Typography>
            )
          })}
        </Stack>
      ))}
    </Stack>
  )
}

/**
 * One colour per update state, as hex rather than palette keys.
 *
 * `AppDialog` takes a colour so it can build the surface wash and the icon
 * tile from it; these are the theme's own primary/success/error, spelled out.
 */
const ACCENTS = {
  primary: '#7aa2f7',
  success: '#6ecf9a',
  error: '#f2545b'
} as const

export type UpdateDialogProps = {
  open: boolean
  phase: UpdatePhase
  info: UpdateSummary | null
  progress: UpdateProgress | null
  error: string | null
  appVersion: string
  onClose: () => void
  onDownload: () => void
  onInstall: () => void
}

const UpdateDialog: React.FC<UpdateDialogProps> = ({
  open,
  phase,
  info,
  progress,
  error,
  appVersion,
  onClose,
  onDownload,
  onInstall
}) => {
  const { icon, title, caption, accent } = useMemo(() => {
    switch (phase) {
      case 'available':
        return {
          icon: <SystemUpdateAltRoundedIcon color="primary" />,
          title: '有新版本可以更新',
          caption: info?.size ? `完整安裝檔約 ${formatBytes(info.size)}` : null,
          accent: ACCENTS.primary
        }
      case 'downloading':
        return {
          icon: <DownloadRoundedIcon color="primary" />,
          title: '正在下載更新',
          caption: '只會下載與目前版本不同的部分',
          accent: ACCENTS.primary
        }
      case 'downloaded':
        return {
          icon: <CheckCircleRoundedIcon color="success" />,
          title: '更新已就緒',
          caption: '重新啟動後套用',
          accent: ACCENTS.success
        }
      case 'error':
        return {
          icon: <ErrorOutlineRoundedIcon color="error" />,
          title: '更新失敗',
          caption: null,
          accent: ACCENTS.error
        }
    }
  }, [phase, info?.size])

  const busy = phase === 'downloading'

  const actions = (
    <>
      {phase === 'available' && (
        <>
          <Button onClick={onClose} color="inherit" sx={{ textTransform: 'none' }}>
            稍後
          </Button>
          <Button
            onClick={onDownload}
            variant="contained"
            disableElevation
            startIcon={<DownloadRoundedIcon />}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
          >
            下載更新
          </Button>
        </>
      )}
      {phase === 'downloading' && (
        <Button
          disabled
          variant="contained"
          disableElevation
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
        >
          下載中…
        </Button>
      )}
      {phase === 'downloaded' && (
        <>
          <Button onClick={onClose} color="inherit" sx={{ textTransform: 'none' }}>
            稍後再說
          </Button>
          <Button
            onClick={onInstall}
            variant="contained"
            disableElevation
            startIcon={<RestartAltRoundedIcon />}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
          >
            安裝並重啟
          </Button>
        </>
      )}
      {phase === 'error' && (
        <Button onClick={onClose} autoFocus color="inherit" sx={{ textTransform: 'none' }}>
          關閉
        </Button>
      )}
    </>
  )

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      busy={busy}
      maxWidth="xs"
      title={title}
      subtitle={caption}
      icon={icon}
      accent={accent}
      headerExtra={
        info?.version && phase !== 'error' ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip size="small" variant="outlined" label={`v${appVersion || '—'}`} />
            <ArrowForwardRoundedIcon fontSize="small" sx={{ color: 'text.disabled' }} />
            <Chip size="small" color="primary" label={`v${info.version}`} />
          </Stack>
        ) : undefined
      }
      actions={actions}
    >
      {phase === 'error' ? (
        <Alert severity="error" variant="outlined" sx={{ borderRadius: 2 }}>
          {error}
        </Alert>
      ) : (
        <Stack spacing={2.5}>
          {/*
              Before the first progress event there is nothing to measure, and
              the real gap is not short: electron-updater has to fetch both
              blockmaps and work out which blocks it needs. An indeterminate bar
              covers it - without one the dialog says 正在下載更新 above an empty
              box, which reads as hung.
            */}
          {busy && !progress && (
            <Stack spacing={1}>
              <LinearProgress
                sx={(t) => ({
                  height: 8,
                  borderRadius: 99,
                  bgcolor: alpha(t.palette.primary.main, 0.15),
                  '& .MuiLinearProgress-bar': { borderRadius: 99 }
                })}
              />
              <Typography variant="caption" color="text.secondary">
                正在準備下載…
              </Typography>
            </Stack>
          )}

          {busy && progress && (
            <Stack spacing={1}>
              <LinearProgress
                variant="determinate"
                value={Math.min(100, Math.max(0, progress.percent))}
                sx={(t) => ({
                  height: 8,
                  borderRadius: 99,
                  bgcolor: alpha(t.palette.primary.main, 0.15),
                  '& .MuiLinearProgress-bar': { borderRadius: 99 }
                })}
              />
              <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                <Typography variant="body2" fontWeight={700}>
                  {progress.percent.toFixed(0)}%
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
                  {' · '}
                  {formatRate(progress.bytesPerSecond)}
                  {eta(progress) ? ` · 剩餘${eta(progress)}` : ''}
                </Typography>
              </Stack>
            </Stack>
          )}

          <Box
            sx={{
              maxHeight: 260,
              overflowY: 'auto',
              pr: 0.5
            }}
          >
            <Typography variant="subtitle2" sx={{ mb: 1.25 }}>
              更新內容
            </Typography>
            <Notes notes={info?.releaseNotes ?? []} currentVersion={info?.version ?? ''} />
          </Box>
        </Stack>
      )}
    </AppDialog>
  )
}

export default UpdateDialog
