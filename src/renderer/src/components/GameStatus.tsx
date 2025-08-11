import { useSvwbStatus } from '@renderer/hooks/useSvwbStatus'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import WarningIcon from '@mui/icons-material/Warning'
import CheckIcon from '@mui/icons-material/Check'
import ErrorIcon from '@mui/icons-material/Error'
import Typography from '@mui/material/Typography'
import { CircularProgress, Fade, Zoom } from '@mui/material'

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
        <Box ml={'13px'} display="flex" justifyContent="center" alignItems="center">
          <CircularProgress size="2rem" />
          <Typography ml={2} color="info" fontWeight="bold">
            狀態讀取中
          </Typography>
        </Box>
      </Tooltip>
    )
  }

  const { running, bounds } = svwbStatus!
  const isMinimized = bounds?.x === -32000 && bounds?.y === -32000
  const isCorrectResolution = bounds?.width === 1296 && bounds?.height === 759

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
      <Box ml={'17.5px'} display="flex" flexDirection="column" alignItems="center" gap={2}>
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
              <ErrorIcon color="error" />
            </Box>
          </Tooltip>
        )}
        {running && !isMinimized && (
          <Tooltip
            title="遊戲執行中"
            placement="right"
            slotProps={{ ...TooltipStyles }}
            slots={{
              transition: Zoom
            }}
          >
            <Box display="flex" alignItems="center" justifyContent="center">
              <CheckIcon color="success" />
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

        {running && !isCorrectResolution && !isMinimized && (
          <Tooltip
            title="建議解析度為 1280x720"
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
          <ErrorIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>未偵測到遊戲</Typography>
          </Fade>
        </Box>
      )}
      {running && !isMinimized && (
        <Box display="flex" alignItems="center" color={running ? 'success.main' : 'error.main'}>
          {running ? <CheckIcon sx={{ mr: 1 }} /> : <ErrorIcon sx={{ mr: 1 }} />}
          <Fade in={open} timeout={200}>
            <Typography>{running ? '遊戲執行中' : '未偵測到遊戲'}</Typography>
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

      {running && !isCorrectResolution && !isMinimized && (
        <Box display="flex" alignItems="center" color="coral">
          <WarningIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>建議解析度為 1280x720</Typography>
          </Fade>
        </Box>
      )}
    </Box>
  )
}

export default GameStatus
