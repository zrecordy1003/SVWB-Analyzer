/**
 * The "add a deck" tile.
 *
 * Deliberately the same size and shape as a deck, sitting first in the grid
 * rather than as a button in the toolbar: adding a deck is part of the same
 * activity as looking at them, and a dashed outline in the row of real tiles
 * says "there is a slot here for one more" in a way a toolbar button cannot.
 *
 * It stays quiet until hovered - it is an empty frame among tiles wearing card
 * art, and an equally loud one would compete with the data.
 */
import { Box, Stack, Typography } from '@mui/material'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import React from 'react'

export default function AddDeckTile({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      sx={{
        minHeight: 150,
        borderRadius: 2,
        cursor: 'pointer',
        display: 'grid',
        placeItems: 'center',
        color: 'text.secondary',
        border: '1px dashed rgba(255,255,255,0.22)',
        backgroundColor: 'rgba(255,255,255,0.015)',
        transition: 'border-color .14s, background-color .14s, color .14s, transform .14s',
        '&:hover': {
          transform: 'translateY(-2px)',
          color: 'primary.light',
          borderColor: 'rgba(140,180,255,0.55)',
          backgroundColor: 'rgba(122,162,247,0.08)'
        }
      }}
    >
      <Stack alignItems="center" spacing={0.5}>
        <AddRoundedIcon />
        <Typography variant="body2" fontWeight={800}>
          新增牌組
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.7 }}>
          貼上代碼，或自己組
        </Typography>
      </Stack>
    </Box>
  )
}
