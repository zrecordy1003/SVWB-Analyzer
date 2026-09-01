import { Box, Skeleton, Typography } from '@mui/material'
import { Match } from '@shared/domain'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import { classesMap } from '@renderer/map/classMap'
import { playOrderOf } from '@renderer/map/playOrder'
import ModeLabel from '@renderer/components/Common/ModeLabel'
import PlayOrderMark from '@renderer/components/Common/PlayOrderMark'
import PlayedAtLabel from '@renderer/components/Common/PlayedAtLabel'
import MatchScoreBlock from '@renderer/components/Common/MatchScoreBlock'
import React from 'react'

interface RecentProps {
  fetchData: Match[]
  isLoading?: boolean
  error?: string | null
  compact?: boolean
}

const Recent: React.FC<RecentProps> = ({
  fetchData,
  isLoading = false,
  error = null,
  compact = false
}) => {
  if (isLoading && fetchData.length === 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minHeight: 0 }}>
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton
            key={index}
            variant="rounded"
            height={54}
            sx={{
              borderRadius: 1.25,
              bgcolor: 'rgba(214,226,244,0.08)'
            }}
          />
        ))}
      </Box>
    )
  }

  if (compact) {
    const compactMatches = fetchData.slice(0, 5)
    const wins = compactMatches.filter((match) => match.result === true).length
    return (
      <Box sx={{ minHeight: 0, WebkitAppRegion: 'no-drag' }}>
        {error && (
          <Typography variant="caption" sx={{ display: 'block', color: '#F2A3A3', mb: 0.75 }}>
            {error}
          </Typography>
        )}
        {compactMatches.length === 0 ? (
          <Box
            sx={{
              py: 1.5,
              textAlign: 'center',
              borderRadius: 1.25,
              bgcolor: 'rgba(214,226,244,0.045)',
              border: '1px solid rgba(214,226,244,0.08)'
            }}
          >
            <Typography variant="caption" color="text.secondary">
              尚無近期對戰紀錄
            </Typography>
          </Box>
        ) : (
          <>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                mb: 0.75
              }}
            >
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                最近 {compactMatches.length} 場
              </Typography>
              <Typography variant="caption" sx={{ color: '#75E2A8', fontWeight: 750 }}>
                {wins} 勝 {compactMatches.length - wins} 敗
              </Typography>
            </Box>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(${compactMatches.length}, minmax(0, 1fr))`,
                gap: 0.5
              }}
            >
              {compactMatches.map((match) => {
                const isWin = match.result === true
                return (
                  <Box
                    key={match.id}
                    title={`${classesMap[match.my_class]?.label} vs ${classesMap[match.oppo_class]?.label}`}
                    sx={{
                      minWidth: 0,
                      py: 0.75,
                      borderRadius: 1,
                      textAlign: 'center',
                      bgcolor: isWin ? 'rgba(117,226,168,0.14)' : 'rgba(242,140,140,0.14)',
                      border: `1px solid ${isWin ? 'rgba(117,226,168,0.25)' : 'rgba(242,140,140,0.25)'}`
                    }}
                  >
                    <Typography
                      sx={{ color: isWin ? '#75E2A8' : '#F28C8C', fontWeight: 850, lineHeight: 1 }}
                    >
                      {isWin ? '勝利' : '敗北'}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: playOrderOf(match.play_order).color,
                        fontSize: 10,
                        fontWeight: 800
                      }}
                    >
                      {playOrderOf(match.play_order).label}
                    </Typography>
                  </Box>
                )
              })}
            </Box>
          </>
        )}
      </Box>
    )
  }

  return (
    <Box
      sx={{
        flex: 1,
        // No height ceiling: the caller hands over a fixed, small number of
        // rows and the window height follows the content, so a cap could only
        // ever slice the last row in half.
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        minHeight: 0,
        overflowY: 'auto',
        WebkitAppRegion: 'no-drag'
      }}
    >
      {error && (
        <Box
          sx={{
            px: 1,
            py: 0.85,
            borderRadius: 1.25,
            bgcolor: 'rgba(238,115,115,0.13)',
            border: '1px solid rgba(238,115,115,0.22)'
          }}
        >
          <Typography variant="caption" sx={{ color: '#F2A3A3', fontWeight: 650 }}>
            {error}
          </Typography>
        </Box>
      )}

      {fetchData.length === 0 && (
        <Box
          sx={{
            flex: 1,
            minHeight: 190,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            px: 2,
            borderRadius: 1.5,
            bgcolor: 'rgba(214,226,244,0.045)',
            border: '1px solid rgba(214,226,244,0.08)'
          }}
        >
          <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
            尚無近期對戰紀錄
          </Typography>
        </Box>
      )}

      {fetchData.map((m) => {
        const isWin = m.result === true
        const resultLabel = m.result == null ? '—' : isWin ? '勝' : '敗'
        const resultColor = m.result == null ? '#8A93A0' : isWin ? '#75E2A8' : '#F28C8C'
        const resultBackground =
          m.result == null
            ? 'rgba(138,147,160,0.14)'
            : isWin
              ? 'rgba(117,226,168,0.14)'
              : 'rgba(242,140,140,0.14)'

        return (
          <Box
            key={m.id}
            sx={{
              display: 'flex',
              alignItems: 'stretch',
              minHeight: 52,
              borderRadius: 1.25,
              overflow: 'hidden',
              bgcolor: 'rgba(214,226,244,0.055)',
              border: '1px solid rgba(214,226,244,0.08)',
              transition: 'background-color 160ms ease-out, border-color 160ms ease-out',
              '&:hover': {
                bgcolor: 'rgba(214,226,244,0.085)',
                borderColor: 'rgba(214,226,244,0.15)'
              },
              '@media (prefers-reduced-motion: reduce)': {
                transition: 'none'
              }
            }}
          >
            {/*
              Same anatomy as the match list card: the outcome owns a coloured
              rail on the left, with play order directly under it, so the two
              facts that decide how the row reads are found in one place.
            */}
            <Box
              sx={{
                width: 46,
                flexShrink: 0,
                px: 0.25,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.3,
                bgcolor: resultBackground,
                color: resultColor
              }}
            >
              <Typography sx={{ fontSize: 15, fontWeight: 850, lineHeight: 1 }}>
                {resultLabel}
              </Typography>
              <PlayOrderMark order={m.play_order} dense />
            </Box>

            <Box sx={{ flex: 1, minWidth: 0, px: 0.9, py: 0.6 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  minWidth: 0,
                  mb: 0.3
                }}
              >
                <ClassIcon id={m.my_class} size={14} />
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 750,
                    color: classesMap[m.my_class]?.color,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0
                  }}
                >
                  {classesMap[m.my_class]?.label}
                </Typography>
                <Typography variant="caption" sx={{ color: 'rgba(214,226,244,0.45)' }}>
                  vs
                </Typography>
                <ClassIcon id={m.oppo_class} size={14} />
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 750,
                    color: classesMap[m.oppo_class]?.color,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minWidth: 0
                  }}
                >
                  {classesMap[m.oppo_class]?.label}
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.65, minWidth: 0 }}>
                <ModeLabel mode={m.mode} dense />
                <PlayedAtLabel playedAt={m.playedAt} dense />
                <Box sx={{ flex: 1 }} />
                <MatchScoreBlock match={m} dense />
              </Box>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export default Recent
