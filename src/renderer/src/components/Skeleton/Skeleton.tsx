import React from 'react'
import { Box, Skeleton } from '@mui/material'

export const AnalyzerSkeleton = (): React.JSX.Element => (
  <Box>
    <Skeleton variant="text" width={200} />
    <Skeleton variant="rectangular" height={300} />
  </Box>
)
