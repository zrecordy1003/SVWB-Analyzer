import { useSvwbStatus } from '@renderer/hooks/useSvwbStatus'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import WarningIcon from '@mui/icons-material/Warning'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
import Typography from '@mui/material/Typography'
import { CircularProgress, Fade, Zoom } from '@mui/material'

import { computeResolutionStatus } from './resolutionStatus'

interface Props {
  open: boolean
}

const GameStatus: React.FC<Props> = ({ open }: Props) => {
  const svwbStatus = useSvwbStatus()

  const isLoading = svwbStatus === undefined
  // const isLoading = true

  if (isLoading) {
    return (
      <Tooltip title="讀取遊戲狀態中" placement="right" disableHoverListener={open}>
        <Box width="100%" display="flex" justifyContent="center" alignItems="center">
          <CircularProgress size="2rem" />
          <Typography ml={2} color="info" fontWeight="bold">
            狀態讀取中
          </Typography>
        </Box>
      </Tooltip>
    )
  }

  const { running, bounds, engineReady, capturing } = svwbStatus!
  const isMinimized = bounds?.x === -32000 && bounds?.y === -32000
  const resolution = computeResolutionStatus(bounds)
  // Worth its own state, because "game found" and "recognition running" are
  // independent and the badge used to conflate them: the window scan runs in
  // the main process and stays green through an engine that died on startup,
  // which is exactly the case that produced no diagnostics to look at either.
  const engineDown = running && !isMinimized && engineReady === false
  const ENGINE_DOWN_HINT = '辨識引擎未啟動，這場不會被記錄。請到「設定 → 辨識診斷」匯出診斷包回報'
  const capturePending = running && !isMinimized && !engineDown && capturing === false
  const CAPTURE_PENDING_HINT =
    '已偵測到遊戲，但尚未收到擷取畫面。若持續顯示，請到「設定 → 辨識診斷」匯出診斷包回報'

  const TooltipStyles = {
    tooltip: {
      sx: {
        fontSize: '0.85rem',
        bgcolor: '#333',
        color: '#fff',
        px: 2,
        py: 1,
        borderRadius: 1,
        boxShadow: 3
      }
    }
  }

  if (!open) {
    return (
      <Box width="100%" display="flex" flexDirection="column" alignItems="center" gap={2}>
        {!running && (
          <Tooltip
            title="未偵測到遊戲"
            placement="right"
            slotProps={{ ...TooltipStyles }}
            slots={{
              transition: Zoom
            }}
          >
            <Box display="flex" alignItems="center" justifyContent="center">
              <SportsEsportsIcon color="error" />
            </Box>
          </Tooltip>
        )}
        {running && !isMinimized && !engineDown && !capturePending && (
          <Tooltip
            title="畫面擷取正常"
            placement="right"
            slotProps={{ ...TooltipStyles }}
            slots={{
              transition: Zoom
            }}
          >
            <Box display="flex" alignItems="center" justifyContent="center">
              <SportsEsportsIcon color="success" />
            </Box>
          </Tooltip>
        )}

        {engineDown && (
          <Tooltip
            title={ENGINE_DOWN_HINT}
            placement="right"
            slotProps={{ ...TooltipStyles }}
            slots={{
              transition: Zoom
            }}
          >
            <Box display="flex" alignItems="center" justifyContent="center">
              <WarningIcon color="error" />
            </Box>
          </Tooltip>
        )}

        {capturePending && (
          <Tooltip
            title={CAPTURE_PENDING_HINT}
            placement="right"
            slotProps={{ ...TooltipStyles }}
            slots={{
              transition: Zoom
            }}
          >
            <Box display="flex" alignItems="center" justifyContent="center">
              <WarningIcon color="warning" />
            </Box>
          </Tooltip>
        )}

        {running && isMinimized && (
          <Tooltip
            title="遊戲最小化，擷取暫停"
            placement="right"
            slotProps={{ ...TooltipStyles }}
            slots={{
              transition: Zoom
            }}
          >
            <WarningIcon color="warning" />
          </Tooltip>
        )}

        {running && !resolution.ok && !isMinimized && (
          <Tooltip
            title={resolution.hint || '建議使用 16:9 解析度，且不低於 1280×720'}
            placement="right"
            slotProps={{ ...TooltipStyles }}
            slots={{
              transition: Zoom
            }}
          >
            <WarningIcon sx={{ color: 'coral' }} />
          </Tooltip>
        )}
      </Box>
    )
  }

  return (
    <Box ml={'17.5px'} display="flex" flexDirection="column" alignItems="start" gap={2}>
      {!running && (
        <Box display="flex" alignItems="center" color={running ? 'success.main' : 'error.main'}>
          <SportsEsportsIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>未偵測到遊戲</Typography>
          </Fade>
        </Box>
      )}
      {running && !isMinimized && !engineDown && !capturePending && (
        <Box display="flex" alignItems="center" color={running ? 'success.main' : 'error.main'}>
          <SportsEsportsIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>畫面擷取正常</Typography>
          </Fade>
        </Box>
      )}

      {engineDown && (
        <Box display="flex" alignItems="center" color="error.main">
          <WarningIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>{ENGINE_DOWN_HINT}</Typography>
          </Fade>
        </Box>
      )}

      {capturePending && (
        <Box display="flex" alignItems="center" color="warning.main">
          <WarningIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>{CAPTURE_PENDING_HINT}</Typography>
          </Fade>
        </Box>
      )}

      {running && isMinimized && (
        <Box display="flex" alignItems="center" color="warning.main">
          <WarningIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>遊戲最小化，擷取已暫停</Typography>
          </Fade>
        </Box>
      )}

      {running && !resolution.ok && !isMinimized && (
        <Box display="flex" alignItems="center" color="coral">
          <WarningIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>
              解析度 {resolution.label}，{resolution.hint}
            </Typography>
          </Fade>
        </Box>
      )}

      {running && (
        <Box
          display="flex"
          alignItems="center"
          color={resolution.ok ? 'success.main' : 'text.secondary'}
        >
          <Fade in={open} timeout={200}>
            <Typography variant="body2">
              目前解析度：{resolution.label}
              {resolution.hint ? `（${resolution.hint}）` : ''}
            </Typography>
          </Fade>
        </Box>
      )}
    </Box>
  )
}

export default GameStatus
