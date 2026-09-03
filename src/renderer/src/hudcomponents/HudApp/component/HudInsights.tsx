import React, { lazy, Suspense, useMemo } from 'react'
import { Box, Typography } from '@mui/material'
import type { Match } from '@shared/domain'

import RecentCountSelect from './RecentCountSelect'
import type { RecentCount } from './recentCount'
import ModeFilterSelect from './ModeFilterSelect'
import type { ModeFilter } from './modeFilter'

/**
 * The ring is the app's only user of `chart.js`. Loading it on demand keeps
 * 128KB out of both entries' eager graph - see the file's own header and the
 * `manualChunks` comment in `electron.vite.config.ts`.
 */
const HudDonut = lazy(() => import('./HudDonut'))

type Props = {
  matches: Match[]
  /** Size of the sample below - the selector sits over the tally it governs. */
  recentCount: RecentCount
  onRecentCountChange: (count: RecentCount) => void
  /** Scopes this tally, the list below it and the mid-battle matchup card. */
  modeFilter: ModeFilter
  onModeFilterChange: (mode: ModeFilter) => void
}

const WIN = '#75E2A8'
const LOSS = '#F28C8C'

/** Shared line box for the sample-size row; see the comment at its usage. */
const ROW_HEIGHT = 18
const captionSx = {
  color: 'text.secondary',
  fontWeight: 700,
  lineHeight: `${ROW_HEIGHT}px`
} as const

/**
 * Win/loss split of the recent matches shown below it. Deliberately just the
 * one figure: a HUD is read at a glance, and the sample is small enough that
 * anything more precise would be over-claiming.
 */
const HudInsights: React.FC<Props> = ({
  matches,
  recentCount,
  onRecentCountChange,
  modeFilter,
  onModeFilterChange
}) => {
  const completed = useMemo(() => matches.filter((match) => match.result != null), [matches])
  const wins = completed.filter((match) => match.result === true).length
  const losses = completed.length - wins

  if (!completed.length) return null

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '96px minmax(0, 1fr)',
        alignItems: 'center',
        gap: 1,
        px: 0.75,
        py: 0.5,
        borderRadius: 1.5,
        border: '1px solid rgba(214,226,244,0.1)',
        bgcolor: 'rgba(214,226,244,0.045)',
        WebkitAppRegion: 'no-drag'
      }}
    >
      {/*
        The fallback is the ring's own box, empty. It is on screen for the one
        frame it takes to resolve a local chunk, and reserving the space means
        the rest of the row does not reflow when it arrives.
      */}
      <Box sx={{ height: 74 }}>
        <Suspense fallback={null}>
          <HudDonut wins={wins} losses={losses} winColor={WIN} lossColor={LOSS} />
        </Suspense>
      </Box>
      <Box sx={{ minWidth: 0 }}>
        {/*
          A caption's line box and a form control's line box do not agree, so
          all three items are pinned to one row of the same explicit height and
          centred in it - baseline alignment across an input is not reliable.
        */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, height: ROW_HEIGHT }}>
          <Typography variant="caption" sx={captionSx}>
            近期
          </Typography>
          <RecentCountSelect value={recentCount} onChange={onRecentCountChange} />
          <Typography variant="caption" sx={captionSx}>
            場
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mt: 0.25 }}>
          <Typography sx={{ color: WIN, fontWeight: 850, fontSize: 17, lineHeight: 1 }}>
            {wins}
            <Typography
              component="span"
              variant="caption"
              sx={{ color: 'text.secondary', ml: 0.25 }}
            >
              勝
            </Typography>
          </Typography>
          <Typography sx={{ color: LOSS, fontWeight: 850, fontSize: 17, lineHeight: 1 }}>
            {losses}
            <Typography
              component="span"
              variant="caption"
              sx={{ color: 'text.secondary', ml: 0.25 }}
            >
              敗
            </Typography>
          </Typography>
        </Box>

        {/*
          Its own line: mode labels run to five characters, and squeezing one
          next to the sample size would mean truncating the very thing the
          reader needs to identify.
        */}
        <Box sx={{ display: 'flex', alignItems: 'center', height: ROW_HEIGHT, mt: 0.4 }}>
          <ModeFilterSelect value={modeFilter} onChange={onModeFilterChange} />
        </Box>
      </Box>
    </Box>
  )
}

export default React.memo(HudInsights)
