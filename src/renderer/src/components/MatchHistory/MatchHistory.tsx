import { styled, SxProps } from '@mui/material/styles'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import MuiAccordion, { AccordionProps } from '@mui/material/Accordion'
import MuiAccordionSummary, {
  AccordionSummaryProps,
  accordionSummaryClasses
} from '@mui/material/AccordionSummary'
import MuiAccordionDetails from '@mui/material/AccordionDetails'
// import Typography from '@mui/material/Typography';

import { Match } from '@prisma/client'
import { classesMap } from '@renderer/map/classMap'
import React, { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'

const MatchHistory = (): React.JSX.Element => {
  const [matchData, setMatchData] = useState<Match[]>()
  useEffect(() => {
    window.electron.ipcRenderer.invoke('matches:fetchAll').then((v) => {
      setMatchData(v)
    })

    // const unsubscribeRefetch = window.electron?.ipcRenderer.on('matches:needRefetch')
    return () => {
      //   unsubscribeRefetch()
    }
  }, [])

  const Accordion = styled((props: AccordionProps) => (
    <MuiAccordion disableGutters elevation={0} square {...props} />
  ))(({ theme }) => ({
    border: `1px solid ${theme.palette.divider}`,
    '&:not(:last-child)': {
      borderBottom: 0
    },
    '&::before': {
      display: 'none'
    }
  }))

  const AccordionSummary = styled((props: AccordionSummaryProps) => (
    <MuiAccordionSummary expandIcon={<ExpandMoreIcon />} {...props} />
  ))(({ theme }) => ({
    backgroundColor: 'rgba(0, 0, 0, .03)',
    // flexDirection: 'row-reverse',
    [`& .${accordionSummaryClasses.expandIconWrapper}.${accordionSummaryClasses.expanded}`]: {
      transform: 'rotate(180deg)'
    },
    [`& .${accordionSummaryClasses.content}`]: {
      marginLeft: theme.spacing(1)
    },
    ...theme.applyStyles('dark', {
      backgroundColor: 'rgba(255, 255, 255, .05)'
    })
  }))

  const AccordionDetails = styled(MuiAccordionDetails)(({ theme }) => ({
    padding: theme.spacing(2),
    borderTop: '1px solid rgba(0, 0, 0, .125)'
  }))

  const matchRowSx: SxProps = {}

  return (
    <Box display={'flex'} flexDirection={'column'} gap={1}>
      {matchData?.map((v) => (
        <Accordion key={v.id}>
          <AccordionSummary
            sx={{
              ...matchRowSx,
              bgcolor: v.result === true ? '#00FF0010' : '#FF000010'
            }}
          >
            <Typography color={v.result === true ? 'green' : 'red'}>
              {v.result === true ? '勝' : '敗'}
            </Typography>
            <Typography color={classesMap[v.my_class].color}>
              {classesMap[v.my_class].label}
            </Typography>
            <Typography color={classesMap[v.oppo_class].color}>
              {classesMap[v.oppo_class].label}
            </Typography>
            <Typography>{new Date(Number(v.playedAt)).toLocaleString()}</Typography>
          </AccordionSummary>
          <AccordionDetails>{/* <Box> ss</Box> */}</AccordionDetails>
        </Accordion>
      ))}
    </Box>
  )
}

export default MatchHistory
