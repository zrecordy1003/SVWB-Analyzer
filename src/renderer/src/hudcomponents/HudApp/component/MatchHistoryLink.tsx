import React from 'react'
import { Box } from '@mui/material'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'

/**
 * The list is deliberately only five rows, so it has to say where the rest
 * lives. Underlined text plus a nudging arrow, because a bare caption in a HUD
 * full of captions does not read as something you can click.
 */
const MatchHistoryLink: React.FC = () => (
  <Box
    component="button"
    type="button"
    onClick={() => void window.hud?.openMatchHistory?.()}
    sx={{
      WebkitAppRegion: 'no-drag',
      appearance: 'none',
      background: 'none',
      border: 'none',
      p: 0,
      alignSelf: 'center',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 0.35,
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 11,
      fontWeight: 700,
      color: 'text.secondary',
      textDecoration: 'underline',
      textDecorationColor: 'rgba(181,192,204,0.4)',
      textUnderlineOffset: '3px',
      transition: 'color 160ms ease-out',
      '&:hover, &:focus-visible': {
        color: '#66D8F5',
        textDecorationColor: '#66D8F5'
      },
      '&:hover svg, &:focus-visible svg': { transform: 'translateX(2px)' },
      '& svg': { fontSize: 13, transition: 'transform 160ms ease-out' },
      '@media (prefers-reduced-motion: reduce)': {
        transition: 'none',
        '& svg': { transition: 'none' }
      }
    }}
  >
    完整對戰歷史
    <ArrowForwardRoundedIcon />
  </Box>
)

export default MatchHistoryLink
