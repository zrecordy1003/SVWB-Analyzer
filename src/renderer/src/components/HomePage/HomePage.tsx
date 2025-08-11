import React from 'react'
import Box from '@mui/material/Box'
import BattleStatus from '../BattleStatus/BattleStatus'
import MatchHistory from '../MatchHistory/MatchHistory'
import UpdatePrompt from '../UpdatePrompt/UpdatePrompt'

const HomePage: React.FC = () => {
  return (
    <Box>
      <UpdatePrompt></UpdatePrompt>
      <BattleStatus />
      <MatchHistory />
    </Box>
  )
}

export default HomePage
