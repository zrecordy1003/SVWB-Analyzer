import React from 'react'
import Box from '@mui/material/Box'
// import BattleStatus from '../BattleStatus/BattleStatus'
import MatchHistory from '../MatchHistory/MatchHistory'

const HomePage: React.FC = () => {
  return (
    <Box>
      {/* <BattleStatus /> */}
      <MatchHistory />
    </Box>
  )
}

export default HomePage
