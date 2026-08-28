import React from 'react'
import { Tooltip, Typography } from '@mui/material'

import { formatAbsoluteTime, useRelativeTime } from '@renderer/utils/relativeTime'

type Props = {
  playedAt: Date | string | number
  dense?: boolean
}

/**
 * "3 天前" answers the question the reader actually has when scanning a list.
 * The exact timestamp is still one hover away, which is where it belongs.
 */
const PlayedAtLabel: React.FC<Props> = ({ playedAt, dense = false }) => {
  const relative = useRelativeTime(playedAt)
  if (!relative) return null

  return (
    <Tooltip title={formatAbsoluteTime(playedAt)} placement="top">
      <Typography
        component="span"
        sx={{
          fontSize: dense ? 11 : 13,
          color: 'text.secondary',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          cursor: 'help'
        }}
      >
        {relative}
      </Typography>
    </Tooltip>
  )
}

export default React.memo(PlayedAtLabel)
