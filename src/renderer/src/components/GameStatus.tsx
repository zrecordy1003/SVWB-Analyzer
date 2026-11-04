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
import { captureStateOf, type CaptureKind } from './captureState'

interface Props {
  /**
   * The sidebar only ever renders the collapsed badge column. The expanded
   * layout this used to switch to was never reached and is gone; the prop stays
   * so the call site does not have to change with it.
   */
  open?: boolean
}

/**
 * Each state has its own glyph, not one glyph in different colours: the column
 * is 92px wide and read at a glance, and "engine down - this match will not be
 * recorded" looked almost exactly like "resolution is not 16:9" when both were
 * the same warning triangle in two shades of red.
 *
 * The state itself comes from `captureStateOf`, shared with the header pill.
 */
const BADGES: Record<Exclude<CaptureKind, 'loading'>, { icon: SvgIconComponent; color: string }> = {
  // Not running is the normal state whenever the game is closed, so it is quiet
  // rather than red - red is kept for "something is broken".
  noGame: { icon: SportsEsportsOutlinedIcon, color: 'text.disabled' },
  minimized: { icon: PauseCircleOutlineRoundedIcon, color: 'warning.main' },
  engineDown: { icon: ReportProblemOutlinedIcon, color: 'error.main' },
  waitingFrames: { icon: HourglassTopRoundedIcon, color: 'warning.main' },
  badResolution: { icon: AspectRatioRoundedIcon, color: 'warning.main' },
  watching: { icon: SportsEsportsIcon, color: 'success.main' }
}

const GameStatus: React.FC<Props> = () => {
  const state = captureStateOf(useSvwbStatus())

  if (state.kind === 'loading') {
    // Spinner only: text beside it did not fit the 92px column and was clipped
    // mid-word. The tooltip says what the spinner is for.
    return (
      <Tooltip title={state.detail} placement="right">
        <Box display="flex" justifyContent="center" alignItems="center" role="status">
          <CircularProgress size={20} />
        </Box>
      </Tooltip>
    )
  }

  const { icon: Icon, color } = BADGES[state.kind]
  return (
    <Tooltip
      title={`${state.label}：${state.detail}`}
      placement="right"
      slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
      slots={{ transition: Zoom }}
    >
      <Box
        width="100%"
        display="flex"
        alignItems="center"
        justifyContent="center"
        role="img"
        aria-label={state.label}
      >
        <Icon sx={{ color }} />
      </Box>
    </Tooltip>
  )
}

export default GameStatus
