import { Box, Typography } from '@mui/material'
import React from 'react'

/**
 * One line of the 資料管理 card: a bare icon, a title with a one-line
 * explanation, and the action on the right. The icon stays grey for every row -
 * the action's own button carries any warning - so the card reads as one calm
 * list. The detail lives in the dialog the action opens.
 */
const DataRow: React.FC<{
  icon: React.ReactNode
  title: string
  caption: React.ReactNode
  action: React.ReactNode
}> = ({ icon, title, caption, action }) => (
  <Box display="flex" alignItems="center" gap={1.75} px={2} py={1.5}>
    <Box
      sx={{
        width: 24,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        color: 'text.secondary',
        '& svg': { fontSize: 20 }
      }}
    >
      {icon}
    </Box>
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography fontSize={14} fontWeight={500} lineHeight={1.4}>
        {title}
      </Typography>
      <Typography fontSize={12.5} color="text.secondary" lineHeight={1.45} noWrap>
        {caption}
      </Typography>
    </Box>
    {action}
  </Box>
)

export default DataRow
