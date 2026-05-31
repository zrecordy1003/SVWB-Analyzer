import { ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import React from 'react'

type Props = {
  viewTab: string
  setViewTab: (value: string) => void
}

const ModeSwitch: React.FC<Props> = ({ viewTab, setViewTab }) => {
  return (
    <>
      <ToggleButtonGroup
        size="small"
        value={viewTab}
        exclusive
        onChange={(_, v) => v && setViewTab(v)}
        sx={{ width: '100%' }}
      >
        <ToggleButton sx={{ width: '50%' }} value="ranked">
          <Typography color="primary">階級對戰</Typography>
        </ToggleButton>
        <ToggleButton sx={{ width: '50%' }} value="twoPick">
          <Typography color="error">2 Pick</Typography>
        </ToggleButton>
      </ToggleButtonGroup>
    </>
  )
}

export default ModeSwitch
