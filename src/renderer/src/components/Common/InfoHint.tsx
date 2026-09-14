/**
 * 一個 ⓘ，滑過去才說話。
 *
 * 這個元件存在的理由是：**解釋文字不該佔版面**。一頁統計如果每個數字底下都
 * 掛一行說明，讀者第一眼看到的是散文不是資料；但把說明拿掉，數字又會被誤讀
 * ——尤其這個 app 的數字有一半在講「這個數字為什麼不能相信」。折衷是把說明
 * 收進 hover：**畫面上只剩一顆 15px 的圖示，需要的人才付出一次滑鼠移動。**
 *
 * 為什麼是共用元件而不是各自寫：這個組合原本在六個檔案裡各寫了一次，
 * 而且已經開始長歪——設定頁與診斷頁用的是 `HelpOutline`（圓圈裡一個問號），
 * 其他頁用 `InfoOutlined`（圓圈裡一個 i）。同一個手勢在同一個 app 裡有兩種
 * 圖示，使用者就得學兩次。這裡定一種：**ⓘ**。
 *
 * 無障礙：`title` 之外一定要有 `label`，因為圖示本身沒有文字。鍵盤使用者
 * tab 得到它（MUI 的 Tooltip 對 focus 也會開），所以 `tabIndex` 是預設行為
 * 的一部分而不是額外的裝飾。
 */
import { Box, Tooltip, type TooltipProps } from '@mui/material'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import React from 'react'

import { TOOLTIP_SURFACE_SX } from './tooltipSurface'

export type InfoHintProps = {
  /** 說明本體。可以是一段字，也可以是排好的節點——tooltip 的底夠大。 */
  title: React.ReactNode
  /** 給讀螢幕軟體的一句話，說明這顆圖示在解釋什麼。 */
  label: string
  /**
   * 圖示大小。
   *
   * 15 是內文旁邊的尺寸，也是這個 app 既有的慣例；`'inherit'` 讓它跟著
   * 旁邊的字一起縮放，用在標題列。刻意不開放任意數字：一頁裡出現三種大小的
   * ⓘ 會讀成三種不同的東西。
   */
  size?: 15 | 18 | 'inherit'
  placement?: TooltipProps['placement']
  /** 罕見情況：要讓圖示比周圍的字更暗或更亮時。 */
  color?: string
  sx?: React.ComponentProps<typeof Box>['sx']
}

/**
 * 說明用的 ⓘ，附一個 hover 才出現的 tooltip。
 *
 * 用在「這個數字是什麼意思」「為什麼這裡是空的」這種**讀者不一定需要、但需要
 * 的時候一定要在**的文字。不要拿它來放讀者非看不可的資訊：藏在 hover 後面的
 * 東西，在觸控螢幕上等於不存在。
 */
const InfoHint: React.FC<InfoHintProps> = ({
  title,
  label,
  size = 15,
  placement = 'top',
  color = 'text.disabled',
  sx
}) => (
  <Tooltip title={title} placement={placement} slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}>
    <Box
      component="span"
      role="img"
      aria-label={label}
      tabIndex={0}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        color,
        cursor: 'help',
        // 這顆圖示常常貼在一行字的尾巴，預設的 baseline 對齊會讓它掉下去半格。
        verticalAlign: 'middle',
        // 對齊用的外距歸呼叫端管，但 focus 環不能被裁掉，所以留一點餘裕。
        borderRadius: '50%',
        outlineOffset: 2,
        ...sx
      }}
    >
      <InfoOutlinedIcon sx={{ fontSize: size }} />
    </Box>
  </Tooltip>
)

export default InfoHint
