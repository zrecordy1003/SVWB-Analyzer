/**
 * The version, at the foot of the sidebar - and where an available update goes
 * to wait.
 *
 * Without somewhere persistent to live, a found update existed only for as long
 * as its dialog was on screen: dismiss it and the app went back to looking
 * identical to one that was up to date, until the next launch. So this is the
 * standing answer to 「我在跑哪一版」, and when there is something newer it
 * turns into the way back to the dialog.
 *
 * Two rules about the layout, both load-bearing:
 *
 * The version sits on a line of its own and never moves. Everything else - the
 * check that runs on launch, the update that turns up - is said on a second
 * line **below** it, in a slot whose height is reserved whether or not there is
 * anything to put in it. A status that shoves the version around every time the
 * app looks for an update is worse than no status.
 *
 * That slot holds exactly one thing at a time: 檢查中, or the update badge, or
 * nothing. The drawer is 92px wide, which rules out sentences - the badge says
 * which state it is in with a word and a colour, and the tooltip carries the
 * version it would take you to.
 */
import React from 'react'
import { Box, ButtonBase, CircularProgress, Stack, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import { useUpdateStatus } from './updateContext'

/** Reserved for the status line, so the version above it cannot be nudged. */
const STATUS_SLOT_HEIGHT = 20

const SidebarVersion: React.FC = () => {
  const { appVersion, pending, checking, show } = useUpdateStatus()

  const version = appVersion ? `v${appVersion}` : '—'
  const ready = pending?.ready ?? false
  const tone = ready ? 'success' : 'primary'

  const status = ((): React.ReactNode => {
    // Checking wins while it runs: it is the more recent fact, and it lasts
    // under a second.
    if (checking) {
      return (
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <CircularProgress size={11} thickness={6} sx={{ color: 'text.disabled' }} />
          <Typography sx={{ fontSize: 10, color: 'text.disabled', lineHeight: 1.3 }}>
            檢查中
          </Typography>
        </Stack>
      )
    }
    if (!pending) return null
    return (
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.5}
        sx={(t) => ({
          px: 0.75,
          py: 0.25,
          borderRadius: 99,
          bgcolor: alpha(t.palette[tone].main, 0.16),
          color: t.palette[tone].main
        })}
      >
        {ready ? (
          <RestartAltRoundedIcon sx={{ fontSize: 13 }} />
        ) : (
          <DownloadRoundedIcon sx={{ fontSize: 13 }} />
        )}
        <Typography sx={{ fontSize: 10.5, fontWeight: 700, lineHeight: 1.4 }}>
          {ready ? '可安裝' : '有新版'}
        </Typography>
      </Stack>
    )
  })()

  const clickable = !!pending && !checking

  const body = (
    <ButtonBase
      onClick={clickable ? show : undefined}
      disabled={!clickable}
      component="div"
      sx={(t) => ({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
        width: '100%',
        px: 0.5,
        py: 0.5,
        borderRadius: 1.5,
        cursor: clickable ? 'pointer' : 'default',
        transition: t.transitions.create(['background-color'], { duration: 160 }),
        // A disabled ButtonBase dims itself; the geometry has to stay identical
        // across all three states, and so does the text.
        '&.Mui-disabled': { opacity: 1 },
        '&:hover': clickable ? { bgcolor: alpha(t.palette[tone].main, 0.12) } : undefined
      })}
    >
      <Typography
        sx={{
          fontSize: 11,
          letterSpacing: 0.3,
          lineHeight: 1.3,
          color: 'text.disabled'
        }}
      >
        {version}
      </Typography>
      <Box
        sx={{
          height: STATUS_SLOT_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {status}
      </Box>
    </ButtonBase>
  )

  if (!clickable) return body

  return (
    <Tooltip
      title={
        ready
          ? `v${pending!.version} 已下載完成，點擊以安裝並重新啟動`
          : `有新版本 v${pending!.version}，點擊以查看更新內容`
      }
      placement="right"
    >
      {body}
    </Tooltip>
  )
}

export default SidebarVersion
