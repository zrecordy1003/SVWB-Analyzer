import { Avatar, CircularProgress, IconButton, Menu, MenuItem, Tooltip } from '@mui/material'
import GoogleIcon from '@mui/icons-material/Google'
import React, { useCallback, useEffect, useState } from 'react'
import type { SyncStatus } from '@shared/sync'

/**
 * The account button at the top-left of the title bar.
 *
 * Signed out it is a Google sign-in button; signed in it is an avatar with the
 * account's initial and a small menu. It only starts the sign-in - the one
 * question sync can ask afterwards (merge or take the cloud's copy, plan J-1)
 * is answered in Settings, so when that comes up this sends the user there
 * instead of duplicating the dialog.
 *
 * In a build with no sync server it stays visible but disabled and says why,
 * rather than vanishing: a missing button would be indistinguishable from a
 * feature that does not exist.
 */
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

  if (status === null) return null

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
    const title = !status.configured
      ? '同步尚未開放（這個版本沒有設定同步伺服器）'
      : busy
        ? '請在瀏覽器完成 Google 登入⋯'
        : '使用 Google 登入'
    return (
      <Tooltip title={title}>
        <span>
          <IconButton
            color="inherit"
            size="small"
            aria-label="使用 Google 登入"
            disabled={busy || !status.configured}
            onClick={() => void signIn()}
            sx={{ mr: 1.5 }}
          >
            {busy ? <CircularProgress size={20} color="inherit" /> : <GoogleIcon />}
          </IconButton>
        </span>
      </Tooltip>
    )
  }

  const initial = (status.displayName ?? status.email ?? '?').charAt(0).toUpperCase()
  return (
    <>
      <Tooltip
        title={
          status.displayName ? `${status.displayName}（${status.email}）` : (status.email ?? '')
        }
      >
        <IconButton
          size="small"
          aria-label="帳號"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ mr: 1.5, p: 0.25 }}
        >
          <Avatar
            src={status.avatar ?? undefined}
            alt={status.displayName ?? status.email ?? ''}
            sx={{ width: 28, height: 28, fontSize: 15 }}
          >
            {initial}
          </Avatar>
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem disabled>{status.email}</MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            onOpenSettings()
          }}
        >
          同步設定
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAnchor(null)
            void window.sync.signOut().then(refresh)
          }}
        >
          登出
        </MenuItem>
      </Menu>
    </>
  )
}

export default AccountButton
