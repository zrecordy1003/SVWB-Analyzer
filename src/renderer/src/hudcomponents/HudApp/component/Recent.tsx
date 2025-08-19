import { Box, Card, Typography } from '@mui/material'
import { Match } from '@prisma/client'
import { classesMap } from '@renderer/map/classMap'
import React from 'react'

interface RecentProps {
  fetchData: Match[]
}

const Recent: React.FC<RecentProps> = ({ fetchData }) => {
  return (
    <Box
      sx={{
        flex: 1,
        overflowY: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minHeight: 'max-content'
      }}
    >
      {fetchData.length === 0 && (
        <Typography
          variant="body2"
          sx={{
            color: 'rgba(255,255,255,0.6)',
            textAlign: 'center',
            WebkitAppRegion: 'no-drag'
          }}
        >
          No matches yet.
        </Typography>
      )}
      {fetchData.map((m) => (
        <Card
          key={m.id}
          sx={{
            backgroundColor: 'rgba(255,255,255,0.06)',
            color: '#fff',
            borderLeft: `4px solid ${m.result ? '#4caf50' : '#f44336'}`,
            display: 'flex',
            alignItems: 'center',
            maxHeight: '62px'
          }}
        >
          <Box sx={{ px: 2, py: 2.5, WebkitAppRegion: 'no-drag', width: '100%' }}>
            <Box display={'flex'} justifyContent={'space-between'} width={'100%'}>
              <Box display={'flex'} flexDirection={'column'}>
                <Box display={'flex'} gap={1}>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                      color: classesMap[m.my_class]?.color
                    }}
                  >
                    {classesMap[m.my_class]?.label}
                  </Typography>
                  vs
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                      color: classesMap[m.oppo_class]?.color
                    }}
                  >
                    {classesMap[m.oppo_class]?.label}
                  </Typography>
                </Box>
                <Box>
                  {m.bp && (
                    <Typography
                      variant="caption"
                      sx={{ color: m.bp >= 0 ? '#4caf50' : '#f44336', fontWeight: 500 }}
                    >
                      BP {m.bp >= 0 ? '+' : ''}
                      {m.bp}
                    </Typography>
                  )}
                </Box>
              </Box>

              <Box display={'flex'} alignItems={'center'}>
                <Typography
                  variant="body2"
                  color={m.play_order === 'first' ? 'primary' : 'secondary'}
                  sx={{ fontWeight: 600 }}
                >
                  {m.play_order === 'first' ? '先攻' : '後攻'}
                </Typography>
              </Box>
            </Box>
            {/* <Typography variant="caption" sx={{ display: 'block', opacity: 0.7 }}>
                {new Date(m.playedAt).toLocaleString()}
              </Typography> */}
          </Box>
        </Card>
      ))}
    </Box>
  )
}

export default Recent
