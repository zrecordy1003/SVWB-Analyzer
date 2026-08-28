import React from 'react'
import { Box, Tooltip, Typography } from '@mui/material'

import {
  deltaColor,
  matchScore,
  signedNumber,
  type MatchScoreFields
} from '@renderer/utils/matchScore'

type Props = {
  match: MatchScoreFields
  /** HUD rows only have room for the delta; the totals move into a tooltip. */
  dense?: boolean
}

const MatchScoreBlock: React.FC<Props> = ({ match, dense = false }) => {
  const score = matchScore(match)
  if (!score) return null

  const delta = score.delta

  if (dense) {
    return (
      <Tooltip title={score.totals ?? ''} placement="top" disableHoverListener={!score.totals}>
        <Typography
          component="span"
          sx={{
            fontSize: 11,
            fontWeight: 800,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            color: delta ? deltaColor(delta.value) : 'text.secondary'
          }}
        >
          {delta ? `${delta.unit} ${signedNumber(delta.value)}` : score.totals}
        </Typography>
      </Tooltip>
    )
  }

  return (
    <Box sx={{ textAlign: 'right', minWidth: 0 }}>
      {delta ? (
        <Typography
          sx={{
            fontSize: 15,
            fontWeight: 800,
            lineHeight: 1.25,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            color: deltaColor(delta.value)
          }}
        >
          {delta.unit} {signedNumber(delta.value)}
        </Typography>
      ) : null}
      {score.totals ? (
        <Typography
          sx={{
            fontSize: 11,
            color: 'text.secondary',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap'
          }}
        >
          {score.totals}
        </Typography>
      ) : null}
    </Box>
  )
}

export default React.memo(MatchScoreBlock)
