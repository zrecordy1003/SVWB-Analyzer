import { useSvwbStatus } from '@renderer/hooks/useSvwbStatus'

import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import { CircularProgress, Zoom } from '@mui/material'
import type { SvgIconComponent } from '@mui/icons-material'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
import SportsEsportsOutlinedIcon from '@mui/icons-material/SportsEsportsOutlined'
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined'
import HourglassTopRoundedIcon from '@mui/icons-material/HourglassTopRounded'
import PauseCircleOutlineRoundedIcon from '@mui/icons-material/PauseCircleOutlineRounded'
import AspectRatioRoundedIcon from '@mui/icons-material/AspectRatioRounded'

import { TOOLTIP_SURFACE_SX } from './Common/tooltipSurface'
import { computeResolutionStatus } from './resolutionStatus'

interface Props {
  /**
   * The sidebar only ever renders the collapsed badge column. The expanded
   * layout this used to switch to was never reached and is gone; the prop stays
   * so the call site does not have to change with it.
   */
  open?: boolean
}

/**
 * One badge in the sidebar's status column.
 *
 * Each state has its own glyph, not one glyph in different colours: the column
 * is 92px wide and read at a glance, and "engine down - this match will not be
 * recorded" looked almost exactly like "resolution is not 16:9" when both were
 * the same warning triangle in two shades of red.
 */
type BadgeProps = {
  title: string
  icon: SvgIconComponent
  color: string
}

const Badge = ({ title, icon: Icon, color }: BadgeProps): React.JSX.Element => (
  <Tooltip
    title={title}
    placement="right"
    slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
    slots={{ transition: Zoom }}
  >
    <Box display="flex" alignItems="center" justifyContent="center" aria-label={title} role="img">
      <Icon sx={{ color }} />
    </Box>
  </Tooltip>
)

const GameStatus: React.FC<Props> = () => {
  const svwbStatus = useSvwbStatus()

  if (svwbStatus === undefined) {
    // Spinner only: the text that sat beside it did not fit the 92px column and
    // was clipped mid-word. The tooltip says what the spinner is for.
    return (
      <Tooltip title="讀取遊戲狀態中" placement="right">
        <Box display="flex" justifyContent="center" alignItems="center" role="status">
          <CircularProgress size={20} />
        </Box>
      </Tooltip>
    )
  }

  const { running, bounds, engineReady, capturing } = svwbStatus
  const isMinimized = bounds?.x === -32000 && bounds?.y === -32000
  const resolution = computeResolutionStatus(bounds)
  // Worth its own state, because "game found" and "recognition running" are
  // independent and the badge used to conflate them: the window scan runs in
  // the main process and stays green through an engine that died on startup,
  // which is exactly the case that produced no diagnostics to look at either.
  const engineDown = running && !isMinimized && engineReady === false
  const capturePending = running && !isMinimized && !engineDown && capturing === false

  return (
    <Box width="100%" display="flex" flexDirection="column" alignItems="center" gap={2}>
      {/* Not running is the normal state whenever the game is closed, so it is
          quiet rather than red - red is kept for "something is broken". */}
      {!running && (
        <Badge title="未偵測到遊戲" icon={SportsEsportsOutlinedIcon} color="text.disabled" />
      )}
      {running && !isMinimized && !engineDown && !capturePending && (
        <Badge title="畫面擷取正常" icon={SportsEsportsIcon} color="success.main" />
      )}
      {engineDown && (
        <Badge
          title="辨識引擎未啟動，這場不會被記錄。請到「設定 → 辨識診斷」匯出診斷包回報"
          icon={ReportProblemOutlinedIcon}
          color="error.main"
        />
      )}
      {capturePending && (
        <Badge
          title="已偵測到遊戲，但尚未收到擷取畫面。若持續顯示，請到「設定 → 辨識診斷」匯出診斷包回報"
          icon={HourglassTopRoundedIcon}
          color="warning.main"
        />
      )}
      {running && isMinimized && (
        <Badge
          title="遊戲最小化，擷取暫停"
          icon={PauseCircleOutlineRoundedIcon}
          color="warning.main"
        />
      )}
      {running && !resolution.ok && !isMinimized && (
        <Badge
          title={`解析度 ${resolution.label}：${resolution.hint || '建議使用 16:9 解析度，且不低於 1280×720'}`}
          icon={AspectRatioRoundedIcon}
          color="warning.main"
        />
      )}
    </Box>
  )
}

export default GameStatus
