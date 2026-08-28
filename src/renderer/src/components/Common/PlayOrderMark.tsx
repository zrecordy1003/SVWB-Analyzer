import React from 'react'
import { Typography } from '@mui/material'

import { playOrderOf } from '@renderer/map/playOrder'

type Props = {
  order?: string | null
  /** Smaller spacing and type for compact HUD rows. */
  dense?: boolean
}

/**
 * Play order is the one fact about a match that cannot be changed once the
 * battle starts, so it gets its own hue rather than the muted caption tone.
 *
 * The hue is the signal; an underline underneath it only repeated what the
 * colour already said and read as text decoration. A solid pill gives the
 * label a shape of its own - readable without relying on colour alone - and
 * the filled ground carries the hue far better than coloured text does at
 * this size.
 */
const PlayOrderMark: React.FC<Props> = ({ order, dense = false }) => {
  const tone = playOrderOf(order)

  return (
    <Typography
      component="span"
      sx={{
        display: 'inline-block',
        fontSize: dense ? 10 : 12,
        fontWeight: 800,
        // Both full labels remain readable in compact HUD rows.
        letterSpacing: dense ? '0.04em' : '0.08em',
        lineHeight: 1.25,
        whiteSpace: 'nowrap',
        // Both hues are light, so near-black ink keeps the contrast ratio well
        // clear of the 4.5:1 floor.
        color: '#11161c',
        bgcolor: tone.color,
        borderRadius: '999px',
        px: dense ? 0.5 : 0.75,
        py: dense ? '1px' : '2px',
        // The tracking adds a trailing gap, which would leave the text looking
        // off-centre inside the pill.
        textIndent: dense ? '0.04em' : '0.08em'
      }}
    >
      {tone.label}
    </Typography>
  )
}

export default React.memo(PlayOrderMark)
