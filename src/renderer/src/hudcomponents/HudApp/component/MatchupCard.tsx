import React, { useEffect, useState } from 'react'
import { Box, Skeleton, Typography } from '@mui/material'
import type { ClassName, GameMode, PlayOrder } from '@shared/domain'
import type { SideStats, Stat } from '@shared/types'
import { classesMap } from '@renderer/map/classMap'
import { playOrderOf } from '@renderer/map/playOrder'

/**
 * What the player actually wants mid-battle: how this exact matchup has gone,
 * split by play order, because that is the one thing already decided and
 * unchangeable once the battle starts.
 */
type Props = {
  myClass: ClassName
  enemyClass: ClassName
  /** Highlighted, since it is the row that applies to the battle in progress. */
  playOrder: PlayOrder | null
  /** `'all'` drops the mode filter; see the HUD's mode selector. */
  gameMode: GameMode | 'all'
  /** Days back from today, or null for all recorded matches. */
  days: number | null
}

const EMPTY: Stat = { wins: 0, total: 0, winRate: 0 }

function startFor(days: number | null): Date | undefined {
  if (days == null) return undefined
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  // `days` counts today, so 7 days means today plus the six before it.
  start.setDate(start.getDate() - (days - 1))
  return start
}

function rateTone(stat: Stat): string {
  if (stat.total === 0) return 'rgba(181,192,204,0.55)'
  if (stat.winRate >= 55) return '#75E2A8'
  if (stat.winRate <= 45) return '#F28C8C'
  return '#E4E9F0'
}

/** Sample size is always shown next to the rate - see `Row`. */
function rateLabel(stat: Stat): string {
  return stat.total === 0 ? '—' : `${Math.round(stat.winRate)}%`
}

const Row: React.FC<{ order: 'first' | 'second'; stat: Stat; highlight?: boolean }> = ({
  order,
  stat,
  highlight = false
}) => {
  const tone = playOrderOf(order)
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: 0.75,
        px: 0.75,
        py: 0.4,
        borderRadius: 0.75,
        // Play order keeps its own colour here too, so the row that applies to
        // the battle in progress is recognised by hue, not just by a border.
        bgcolor: highlight ? tone.bgColor : 'transparent',
        border: `1px solid ${highlight ? tone.borderColor : 'transparent'}`,
        boxShadow: highlight ? `0 0 12px ${tone.glow}` : 'none'
      }}
    >
      <Typography variant="caption" sx={{ color: tone.color, fontWeight: highlight ? 850 : 700 }}>
        {tone.label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: 'rgba(181,192,204,0.7)',
          fontSize: 10,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {stat.total === 0 ? '無紀錄' : `${stat.wins}-${stat.total - stat.wins}`}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: rateTone(stat),
          fontWeight: 800,
          minWidth: 34,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {rateLabel(stat)}
      </Typography>
    </Box>
  )
}

const MatchupCard: React.FC<Props> = ({ myClass, enemyClass, playOrder, gameMode, days }) => {
  const [stats, setStats] = useState<SideStats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setError(null)
    void Promise.resolve(
      window.matches?.getRankedWinrate({ myClass, gameMode, start: startFor(days) })
    )
      .then((data) => {
        if (!active) return
        // A matchup with no recorded matches is absent from `byOpponent`
        // entirely, which is not an error - it is the first-encounter case.
        setStats(data?.byOpponent?.[enemyClass] ?? null)
      })
      .catch((e) => {
        if (!active) return
        console.warn('[HUD] matchup stats failed:', e)
        setError('無法讀取勝率')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [myClass, enemyClass, gameMode, days])

  const all = stats?.all ?? EMPTY
  const first = stats?.first ?? EMPTY
  const second = stats?.second ?? EMPTY

  return (
    <Box
      sx={{
        px: 1,
        py: 0.85,
        borderRadius: 1.5,
        bgcolor: 'rgba(214,226,244,0.05)',
        border: '1px solid rgba(214,226,244,0.1)',
        WebkitAppRegion: 'no-drag'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 0.5,
          mb: 0.5
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
          對此職業
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: classesMap[enemyClass]?.color, fontWeight: 800, fontSize: 11 }}
        >
          {classesMap[enemyClass]?.label ?? enemyClass}
        </Typography>
      </Box>

      {isLoading ? (
        <Skeleton variant="rounded" height={64} />
      ) : error ? (
        <Typography variant="caption" sx={{ color: '#F2A3A3' }}>
          {error}
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mb: 0.25 }}>
            <Typography
              sx={{
                fontSize: 26,
                fontWeight: 850,
                lineHeight: 1,
                color: rateTone(all),
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {rateLabel(all)}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
              {all.total === 0
                ? '尚無對戰紀錄'
                : `${all.total} 場 ${all.wins}勝${all.total - all.wins}敗`}
            </Typography>
          </Box>
          <Row order="first" stat={first} highlight={playOrder === 'first'} />
          <Row order="second" stat={second} highlight={playOrder === 'second'} />
        </>
      )}
    </Box>
  )
}

export default React.memo(MatchupCard)
