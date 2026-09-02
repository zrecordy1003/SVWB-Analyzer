import { useSvwbStatus } from '@renderer/hooks/useSvwbStatus'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import WarningIcon from '@mui/icons-material/Warning'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
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

/**
 * 每一幀都會先正規化成 1280×720 再比對，所以真正的條件是「16:9」與
 * 「不小於 1280×720」，而不是某兩組特定數字 —— 2560×1440 之類的畫面同樣可用
 * （見 `tools/vision-native/CALIBRATION.md`）。原本只認 1280×720 與 1920×1080，
 * 2K 使用者因此永遠看到「解析度不支援」的警告。
 */
const MIN_WIDTH = 1280

/**
 * 視窗模式回報的是整個視窗，含標題列與邊框；遊戲畫面是底下那塊 16:9 的
 * 工作區。實測標題列 1920×1080 視窗為 30px、1276×754 視窗為 36px。
 */
const WINDOW_CHROME_ALLOWANCE = 60

const computeResolutionStatus = (bounds?: {
  width?: number
  height?: number
}): ResolutionStatus => {
  const width = bounds?.width
  const height = bounds?.height
  if (!width || !height) return { ok: false, label: '未知', hint: '無法偵測解析度' }

  const label = `${width}×${height}`
  // 視窗高度必須是「16:9 的工作區」再加上最多一條標題列。負的容許值只留給
  // 捨入誤差：比 16:9 還矮代表畫面本身不是 16:9。
  const extra = height - Math.round((width * 9) / 16)
  if (extra < -8 || extra > WINDOW_CHROME_ALLOWANCE) {
    return {
      ok: false,
      label,
      width,
      height,
      hint: '建議使用 16:9 解析度（例如 1280×720、1920×1080、2560×1440）'
    }
  }
  if (width < MIN_WIDTH) {
    return { ok: false, label, width, height, hint: '低於 1280×720，辨識準確度會下降' }
  }

  return { ok: true, label, width, height }
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
              <SportsEsportsIcon color="success" />
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
      {running && !isMinimized && (
        <Box display="flex" alignItems="center" color={running ? 'success.main' : 'error.main'}>
          <SportsEsportsIcon sx={{ mr: 1 }} />
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
