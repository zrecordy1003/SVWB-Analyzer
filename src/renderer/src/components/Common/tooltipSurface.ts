import type { SxProps, Theme } from '@mui/material'

/**
 * 所有帶資料的 tooltip 共用的一塊底。
 *
 * MUI 預設的 tooltip 是一塊小小的深灰方塊，字級壓到 11px - 那是給「這顆按鈕
 * 叫什麼」用的，不是給一整組數字用的。這裡把它換成和下拉選單同一種材質：
 * 面板色、一條細框、夠深的陰影，字回到看得清楚的大小。
 */
export const TOOLTIP_SURFACE_SX: SxProps<Theme> = {
  maxWidth: 'none',
  px: 1.5,
  py: 1.25,
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'divider',
  // 蓋掉主題的 elevation overlay：它該讀成和工作列同一塊材質，靠陰影浮起來，
  // 而不是靠比較亮
  backgroundImage: 'none',
  backgroundColor: 'background.paper',
  color: 'text.primary',
  boxShadow: '0 16px 40px rgba(0,0,0,0.5)'
}
