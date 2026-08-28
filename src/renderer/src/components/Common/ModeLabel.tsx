import React from 'react'
import { Typography } from '@mui/material'

import { modesMap } from '@renderer/map/classMap'

type Props = {
  mode?: string | null
  /** Smaller type for the HUD rows. */
  dense?: boolean
}

/**
 * The mode used to be a chip, which gave it the same visual weight as the
 * result. Colour, weight and a soft glow carry the same identity without
 * competing with the outcome for attention.
 *
 * A match whose mode was never captured still renders a placeholder: a gap
 * where every other row has a label reads as a rendering bug, not as missing
 * data.
 */
const ModeLabel: React.FC<Props> = ({ mode, dense = false }) => {
  const option = mode ? modesMap[mode] : undefined

  if (!option) {
    return (
      <Typography
        component="span"
        sx={{
          fontSize: dense ? 11 : 13,
          fontWeight: 700,
          letterSpacing: '0.03em',
          lineHeight: 1.3,
          whiteSpace: 'nowrap',
          color: 'text.disabled',
          fontStyle: 'italic'
        }}
      >
        未記錄
      </Typography>
    )
  }

  return (
    <Typography
      component="span"
      sx={{
        fontSize: dense ? 11 : 13,
        fontWeight: 850,
        letterSpacing: '0.03em',
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
        color: option.tone,
        textShadow: `0 0 12px ${option.tone}59`
      }}
    >
      {option.label}
    </Typography>
  )
}

export default React.memo(ModeLabel)
