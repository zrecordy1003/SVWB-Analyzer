import {
  Avatar,
  Box,
  ButtonBase,
  CircularProgress,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography
} from '@mui/material'
import GoogleIcon from '@mui/icons-material/Google'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import SyncIcon from '@mui/icons-material/Sync'
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined'
import LogoutIcon from '@mui/icons-material/Logout'
import React, { useCallback, useEffect, useState } from 'react'
import type { SyncStatus } from '@shared/sync'
import { motion } from '../Common/motion'

/**
 * The account card at the top-left of the title bar.
 *
 * A small translucent card, so it reads as one control on any title-bar colour:
 * signed out it offers Google sign-in; signed in it shows the avatar, name and
 * email and opens a small menu. It only starts the sign-in - the one
 * question sync can ask afterwards (merge or take the cloud's copy, plan J-1)
 * is answered in Settings, so when that comes up this sends the user there
 * instead of duplicating the dialog.
 *
 * In a build with no sync server it stays visible but disabled and says why,
 * rather than vanishing: a missing button would be indistinguishable from a
 * feature that does not exist.
 */
/** The card itself. Translucent white, so it works on whatever colour the title bar is. */
const cardSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 1.25,
  mr: 2,
  px: 1.25,
  py: 0.5,
  minWidth: 0,
  maxWidth: 260,
  textAlign: 'left',
  color: 'inherit',
  borderRadius: 2,
  bgcolor: 'rgba(255,255,255,0.12)',
  border: '1px solid rgba(255,255,255,0.22)',
  transition: motion(['background-color', 'border-color'], 'fast'),
  '&:hover': { bgcolor: 'rgba(255,255,255,0.2)', borderColor: 'rgba(255,255,255,0.35)' },
  '&.Mui-disabled': { opacity: 0.6, color: 'inherit' }
} as const

/** Menu rows: inset from the card edge and rounded, so a hovered row looks like part of the card. */
const itemSx = { mx: 0.75, borderRadius: 1.5, py: 1, px: 1.25 } as const

const ago = (ms: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} 小時前` : `${Math.round(hours / 24)} 天前`
}

const AccountButton: React.FC<{ onOpenSettings: () => void }> = ({ onOpenSettings }) => {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const refresh = useCallback(() => {
    window.sync
      .status()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refresh()
    // Settings can sign in and out too; keep this in step without a push channel.
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  // A build without a Google client shows no account control at all, rather than
  // a sign-in card that can never be pressed.
  if (status === null || !status.configured) return null

  const signIn = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.sync.signIn()
      setStatus(result.status)
      if (result.needsChoice) onOpenSettings()
    } catch (e) {
      console.error('sign-in failed:', e)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  if (!status.signedIn) {
    const title = busy ? '請在瀏覽器完成 Google 登入⋯' : '使用 Google 登入'
    return (
      <Tooltip title={title}>
        <span>
          <ButtonBase
            aria-label="使用 Google 登入"
            disabled={busy}
            onClick={() => void signIn()}
            sx={cardSx}
          >
            <Avatar sx={{ width: 32, height: 32, bgcolor: '#fff', color: '#4285f4' }}>
              {busy ? <CircularProgress size={18} /> : <GoogleIcon fontSize="small" />}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600} noWrap lineHeight={1.25}>
                {busy ? '等待瀏覽器登入⋯' : '使用 Google 登入'}
              </Typography>
              <Typography
                variant="caption"
                noWrap
                display="block"
                sx={{ opacity: 0.8 }}
                lineHeight={1.2}
              >
                跨裝置同步
              </Typography>
            </Box>
          </ButtonBase>
        </span>
      </Tooltip>
    )
  }

  const initial = (status.displayName ?? status.email ?? '?').charAt(0).toUpperCase()

  // One line that says how sync is doing, coloured by whether it needs attention.
  const [stateLine, stateTone] = ((): [string, { bg: string; fg: string }] => {
    const calm = { bg: 'action.hover', fg: 'text.secondary' }
    const good = { bg: 'rgba(46,125,50,.14)', fg: 'success.main' }
    const warn = { bg: 'rgba(237,108,2,.14)', fg: 'warning.main' }
    if (!status.enabled) return ['同步未開啟', calm]
    if (status.syncing) return ['同步中⋯', calm]
    if (status.needsUpdate) return ['請更新以讀取另一台的資料', warn]
    if (status.lastError) return ['上次同步失敗', warn]
    if (status.pending > 0) return [`${status.pending} 筆變更待上傳`, calm]
    return [status.lastSyncAt ? `已同步 · ${ago(status.lastSyncAt)}` : '同步已開啟', good]
  })()
  return (
    <>
      <ButtonBase aria-label="帳號" onClick={(e) => setAnchor(e.currentTarget)} sx={cardSx}>
        <Avatar
          src={status.avatar ?? undefined}
          alt={status.displayName ?? status.email ?? ''}
          sx={{ width: 32, height: 32, fontSize: 16 }}
        >
          {initial}
        </Avatar>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={600} noWrap lineHeight={1.25}>
            {status.displayName ?? status.email}
          </Typography>
          <Typography
            variant="caption"
            noWrap
            display="block"
            sx={{ opacity: 0.8 }}
            lineHeight={1.2}
          >
            {status.displayName ? status.email : '已登入'}
          </Typography>
        </Box>
        <ExpandMoreIcon fontSize="small" sx={{ opacity: 0.8, flexShrink: 0 }} />
      </ButtonBase>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            elevation: 8,
            sx: {
              mt: 1,
              width: 288,
              borderRadius: 2.5,
              border: 1,
              borderColor: 'divider',
              overflow: 'hidden'
            }
          },
          list: { disablePadding: true }
        }}
      >
        {/* Who is signed in: the same avatar-and-name pairing as the card, bigger. */}
        <Box sx={{ px: 2, pt: 2, pb: 1.75, textAlign: 'center' }}>
          <Avatar
            src={status.avatar ?? undefined}
            alt={status.displayName ?? status.email ?? ''}
            sx={{ width: 56, height: 56, fontSize: 24, mx: 'auto', mb: 1 }}
          >
            {initial}
          </Avatar>
          <Typography variant="subtitle1" fontWeight={600} noWrap>
            {status.displayName ?? status.email}
          </Typography>
          {status.displayName && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {status.email}
            </Typography>
          )}
          <Box
            sx={{
              mt: 1.25,
              mx: 'auto',
              px: 1.25,
              py: 0.25,
              width: 'fit-content',
              maxWidth: '100%',
              borderRadius: 5,
              typography: 'caption',
              bgcolor: stateTone.bg,
              color: stateTone.fg
            }}
          >
            {stateLine}
          </Box>
        </Box>
        <Divider />
        <Box sx={{ py: 0.75 }}>
          {status.enabled && (
            <MenuItem
              disabled={status.syncing}
              onClick={() => {
                setAnchor(null)
                void window.sync.syncNow().then(refresh)
              }}
              sx={itemSx}
            >
              <ListItemIcon>
                <SyncIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>立即同步</ListItemText>
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              setAnchor(null)
              onOpenSettings()
            }}
            sx={itemSx}
          >
            <ListItemIcon>
              <SettingsOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>同步設定</ListItemText>
          </MenuItem>
        </Box>
        <Divider />
        <Box sx={{ py: 0.75 }}>
          <MenuItem
            onClick={() => {
              setAnchor(null)
              void window.sync.signOut().then(refresh)
            }}
            sx={{
              ...itemSx,
              color: 'error.main',
              '& .MuiListItemIcon-root': { color: 'error.main' }
            }}
          >
            <ListItemIcon>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>登出</ListItemText>
          </MenuItem>
        </Box>
      </Menu>
    </>
  )
}

export default AccountButton
