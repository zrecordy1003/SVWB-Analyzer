import { Box, Chip, Skeleton, Typography } from '@mui/material'
import { Match } from '@prisma/client'
import { classesMap, modesMap } from '@renderer/map/classMap'
import React from 'react'

interface RecentProps {
  fetchData: Match[]
  isLoading?: boolean
  error?: string | null
}

function formatPlayedAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const Recent: React.FC<RecentProps> = ({ fetchData, isLoading = false, error = null }) => {
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

  return (
    <Box
      sx={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        minHeight: 0,
        pr: 0.25,
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

      {fetchData.map((m) => (
        <Box
          key={m.id}
          sx={{
            px: 1,
            py: 0.85,
            borderRadius: 1.25,
            bgcolor: 'rgba(214,226,244,0.055)',
            border: '1px solid rgba(214,226,244,0.08)',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            alignItems: 'center',
            gap: 1,
            minHeight: 56,
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
          <Box sx={{ minWidth: 0 }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.65,
                minWidth: 0,
                mb: 0.35
              }}
            >
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

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.65, flexWrap: 'wrap' }}>
              {m.mode && (
                <Typography
                  variant="caption"
                  color={m.mode ? `${modesMap[m.mode]?.color}.main` : 'text.secondary'}
                  sx={{ fontWeight: 650, lineHeight: 1.2 }}
                >
                  {modesMap[m.mode]?.label}
                </Typography>
              )}
              {typeof m.bp === 'number' && (
                <Typography
                  variant="caption"
                  sx={{
                    color: m.bp >= 0 ? '#75E2A8' : '#F28C8C',
                    fontWeight: 700,
                    lineHeight: 1.2
                  }}
                >
                  BP {m.bp >= 0 ? '+' : ''}
                  {m.bp}
                </Typography>
              )}
              <Typography variant="caption" sx={{ color: 'rgba(214,226,244,0.55)' }}>
                {formatPlayedAt(m.playedAt)}
              </Typography>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
            <Chip
              size="small"
              label={m.result ? '勝' : '敗'}
              sx={{
                height: 22,
                minWidth: 38,
                borderRadius: 1,
                fontWeight: 800,
                bgcolor: m.result ? 'rgba(117,226,168,0.14)' : 'rgba(242,140,140,0.14)',
                color: m.result ? '#75E2A8' : '#F28C8C',
                border: `1px solid ${m.result ? 'rgba(117,226,168,0.24)' : 'rgba(242,140,140,0.24)'}`,
                '& .MuiChip-label': { px: 0.85 }
              }}
            />
            <Typography
              variant="caption"
              sx={{
                color: m.play_order === 'first' ? '#66D8F5' : '#E87AC5',
                fontWeight: 750,
                lineHeight: 1
              }}
            >
              {m.play_order === 'first' ? '先攻' : '後攻'}
            </Typography>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export default Recent
