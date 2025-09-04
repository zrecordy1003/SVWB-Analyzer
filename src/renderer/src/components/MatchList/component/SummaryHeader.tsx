// src/renderer/components/matches/SummaryHeader.tsx
import React from 'react'
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'
import LooksOneTwoToneIcon from '@mui/icons-material/LooksOneTwoTone'
import LooksTwoTwoToneIcon from '@mui/icons-material/LooksTwoTwoTone'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
// import MilitaryTechIcon from '@mui/icons-material/MilitaryTech'
import type { ClassName, GameMode, PlayOrder } from '@prisma/client'
import dayjs from 'dayjs'
import { classesMap, modesMap } from '@renderer/map/classMap'

type Props = {
  result: boolean | null | undefined
  play_order: PlayOrder
  mode: GameMode | null | undefined
  my_class: ClassName
  oppo_class: ClassName
  my_deckName?: string | null
  oppo_deckName?: string | null
  bp?: number | null
  durationTime?: number | null
  playedAt?: Date | string | null
}

const SummaryHeader: React.FC<Props> = (props) => {
  const {
    result,
    play_order,
    mode,
    my_class,
    oppo_class,
    my_deckName,
    oppo_deckName,
    bp,
    durationTime,
    playedAt
  } = props

  const resultChip =
    result == null ? (
      <Typography sx={{ color: 'gray' }}>未紀錄</Typography>
    ) : result ? (
      <Typography color="success">勝</Typography>
    ) : (
      <Typography color="error">敗</Typography>
    )

  const orderChip = (
    <Typography display={'flex'} alignItems={'center'}>
      {play_order === 'first' ? (
        <LooksOneTwoToneIcon color={'primary'} />
      ) : (
        <LooksTwoTwoToneIcon color={'secondary'} />
      )}
      {play_order === 'first' ? '先攻' : '後攻'}
    </Typography>
    // <Chip
    //   size="small"
    //   variant="outlined"
    //   icon={play_order === 'first' ? <LooksOneTwoToneIcon /> : <LooksTwoTwoToneIcon />}
    //   label={play_order === 'first' ? '先攻' : '後攻'}
    // />
  )

  const modeChip = (
    <Chip
      size="small"
      variant="outlined"
      color={mode ? modesMap[mode].color : undefined}
      //   icon={<MilitaryTechIcon />}
      label={mode ? modesMap[mode].label : '未選模式'}
    />
  )

  const timeText =
    durationTime != null
      ? `${Math.floor(durationTime / 60)}:${String(durationTime % 60).padStart(2, '0')}`
      : '—'

  const playedAtText = playedAt ? dayjs(playedAt).format('YYYY/MM/DD HH:mm') : '—'

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        px: 2,
        py: 1.5,
        bgcolor: 'background.default',
        borderBottom: (t) => `1px solid ${t.palette.divider}`,
        borderLeft: `5px solid ${result === null ? 'gray' : result === true ? 'green' : 'red'}`
      }}
      useFlexGap
      flexWrap="wrap"
    >
      <Box display={'flex'} flexDirection={'column'}>
        <Box sx={{ color: classesMap[my_class]?.color }}>{classesMap[my_class]?.label}</Box>
        <Box sx={{ color: classesMap[my_class]?.color, opacity: 0.9 }}>
          {my_deckName ? `${my_deckName}` : ''}
        </Box>
      </Box>

      <Box display={'flex'} flexDirection={'column'}>
        <Box sx={{ color: classesMap[oppo_class]?.color }}>{classesMap[oppo_class]?.label}</Box>
        <Box sx={{ color: classesMap[oppo_class]?.color, opacity: 0.9 }}>
          {oppo_deckName ? `${oppo_deckName}` : ''}
        </Box>
      </Box>

      {/* <Chip
        size="small"
        variant="outlined"
        sx={{ color: classesMap[my_class]?.color }}
        label={`我方：${classesMap[my_class]?.label}${my_deckName ? `・${my_deckName}` : ''}`}
      />
      <Chip
        size="small"
        variant="outlined"
        sx={{ color: classesMap[oppo_class]?.color }}
        label={`對手：${classesMap[oppo_class]?.label}${oppo_deckName ? `・${oppo_deckName}` : ''}`}
      /> */}
      {orderChip}
      {resultChip}
      {modeChip}

      <Tooltip title="BP">
        <Chip
          size="small"
          variant="outlined"
          label={
            bp != null ? (
              <>
                <Typography component="span" fontSize={'small'}>
                  BP：
                </Typography>
                <Typography
                  component="span"
                  fontSize={'medium'}
                  color={bp === 0 ? 'gray' : bp > 0 ? 'success' : 'red'}
                  sx={{ fontFamily: 'monospace' }}
                >
                  {bp}
                </Typography>
              </>
            ) : (
              <>
                <Typography component="span" fontSize={'small'}>
                  BP：
                </Typography>
                <Typography
                  component="span"
                  fontSize={'medium'}
                  color="gray"
                  sx={{ fontFamily: 'monospace' }}
                >
                  未紀錄
                </Typography>
              </>
            )
          }
        />
      </Tooltip>

      <Tooltip title="時長">
        <Chip
          size="small"
          sx={{ fontFamily: 'monospace' }}
          variant="outlined"
          icon={<AccessTimeIcon />}
          label={timeText}
        />
      </Tooltip>

      <Tooltip title="開始時間">
        <Chip size="small" variant="outlined" icon={<CalendarMonthIcon />} label={playedAtText} />
      </Tooltip>
    </Stack>
  )
}

export default SummaryHeader
