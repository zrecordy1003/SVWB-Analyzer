import React from 'react'
import { Tooltip, Typography } from '@mui/material'

import { LOW_SAMPLE_GAMES } from '../matchupRows'

/**
 * 對位列首那個小標籤：這一列的數字照給，但場數太少。
 *
 * 熱圖和長條圖共用，兩種畫法看的是同一份資料，同一個警告不該長得不一樣。
 */
const LowSampleTag: React.FC = () => (
  <Tooltip title={`不到 ${LOW_SAMPLE_GAMES} 場，一場的勝負就可能讓勝率變動 10 個百分點以上。`}>
    <Typography
      component="span"
      sx={{
        flexShrink: 0,
        fontSize: 10.5,
        lineHeight: 1.6,
        px: 0.6,
        borderRadius: 0.75,
        color: 'rgba(255,255,255,0.6)',
        bgcolor: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)'
      }}
    >
      樣本少
    </Typography>
  </Tooltip>
)

export default LowSampleTag
