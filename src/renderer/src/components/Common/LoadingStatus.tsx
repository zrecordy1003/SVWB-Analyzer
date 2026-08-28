import { Box, CircularProgress, Typography } from '@mui/material'

type Props = { label?: string }

/** A non-layout-affecting progress hint for data refreshes. */
const LoadingStatus = ({ label = '更新中' }: Props): React.JSX.Element => (
  <Box
    aria-live="polite"
    role="status"
    sx={{
      position: 'absolute',
      top: 12,
      right: 12,
      zIndex: 2,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 0.75,
      px: 1,
      py: 0.5,
      borderRadius: 1,
      bgcolor: 'rgba(30, 33, 39, 0.88)',
      color: 'text.secondary',
      pointerEvents: 'none'
    }}
  >
    <CircularProgress size={14} thickness={5} />
    <Typography variant="caption">{label}</Typography>
  </Box>
)

export default LoadingStatus
