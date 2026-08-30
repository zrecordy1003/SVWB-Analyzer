import React from 'react'
import { Box, Typography } from '@mui/material'
import SearchOffOutlinedIcon from '@mui/icons-material/SearchOffOutlined'

/**
 * 「這組條件下沒有東西」的統一畫面。
 *
 * 對局列表和分析器問的是同一個問題（篩過頭了嗎？），所以答案的長相也該一樣：
 * 同一個字形、同一句標題、同一塊虛線底。虛線加上淡淡的底色說的是「這裡本來
 * 會有東西，只是現在沒有」 - 和工作列上那顆虛線的「＋ 新增條件」同一種語彙；
 * 實線或純文字都會讀成別的意思（一個像出錯，一個像還沒載完）。
 *
 * 預設撐滿父層給的高度。兩邊的內容區都是 flex 撐開的，空狀態縮成一小條會讓
 * 下半個畫面憑空空掉。
 */
export function EmptyState({
  title = '無符合資料',
  description,
  icon
}: {
  title?: string
  /** 這一頁該怎麼把條件放寬 - 只有這句是兩邊不同的。 */
  description: string
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <Box
      sx={{
        height: '100%',
        // 只要求放得下圖示與兩行字。再高就會在小視窗把整頁頂出捲軸，
        // 而它本來就是撐滿父層的 - 高度該由那塊區域決定，不是由這裡撐出來。
        minHeight: 160,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        px: 3,
        textAlign: 'center',
        border: '1px dashed',
        borderColor: 'divider',
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.04)',
        color: 'text.disabled'
      }}
    >
      {icon ?? <SearchOffOutlinedIcon sx={{ fontSize: 40, opacity: 0.6 }} />}
      <Typography variant="subtitle1" fontWeight={700} color="text.secondary">
        {title}
      </Typography>
      <Typography variant="body2" sx={{ maxWidth: 360 }}>
        {description}
      </Typography>
    </Box>
  )
}

export default EmptyState
