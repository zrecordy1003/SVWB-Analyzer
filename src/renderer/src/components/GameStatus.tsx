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

type ResolutionStatus = {
  ok: boolean
  label: string
  width?: number
  height?: number
  hint?: string
}

const computeResolutionStatus = (bounds?: {
  width?: number
  height?: number
}): ResolutionStatus => {
  const width = bounds?.width
  const height = bounds?.height
  if (!width || !height) return { ok: false, label: '未知', hint: '無法偵測解析度' }

  const closeTo = (v: number, target: number, tolerance: number) =>
    Math.abs(v - target) <= tolerance
  const is720 = closeTo(width, 1280, 40) && closeTo(height, 720, 60)
  const is1080 = closeTo(width, 1920, 40) && closeTo(height, 1080, 60)
  const ratio = width / height
  const near169 = Math.abs(ratio - 16 / 9) < 0.03

  if (is720 || is1080) {
    return { ok: true, label: is720 ? '1280×720' : '1920×1080', width, height }
  }

  const label = `${width}×${height}`
  const hint = near169 ? '請調整為 1280×720 或 1920×1080' : '建議使用 16:9（1280×720 或 1920×1080）'

  return { ok: false, label, width, height, hint }
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
  const resolution = computeResolutionStatus(bounds)

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

        {running && !resolution.ok && !isMinimized && (
          <Tooltip
            title={resolution.hint || '建議解析度為 1280×720 或 1920×1080'}
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

      {running && !resolution.ok && !isMinimized && (
        <Box display="flex" alignItems="center" color="coral">
          <WarningIcon sx={{ mr: 1 }} />
          <Fade in={open} timeout={200}>
            <Typography>解析度 {resolution.label}，建議改為 1280×720 或 1920×1080</Typography>
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
