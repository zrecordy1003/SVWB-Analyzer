/**
 * CR 的邊界與分段，兩個頁面的 CR 篩選共用同一組。
 *
 * 段位切點是遊戲定的，不是某個畫面的設定；分析器和對局列表各存一份的時候，
 * 「1850 – 1999」在一邊改了另一邊不會跟著改，而兩邊送出去的其實是同一個查詢。
 */

export const CR_MIN_BOUND = 0
export const CR_MAX_BOUND = 3000
export const CR_STEP = 1

export type CrBand = { key: string; label: string; min: number; max: number }

export const CR_BANDS: CrBand[] = [
  { key: 'lt1650', label: '1650 以下', min: CR_MIN_BOUND, max: 1649 },
  { key: 'b1650', label: '1650 – 1749', min: 1650, max: 1749 },
  { key: 'b1750', label: '1750 – 1849', min: 1750, max: 1849 },
  { key: 'b1850', label: '1850 – 1999', min: 1850, max: 1999 },
  { key: 'gte2000', label: '2000 以上', min: 2000, max: CR_MAX_BOUND }
]

export function clampCr(value: number): number {
  return Math.min(CR_MAX_BOUND, Math.max(CR_MIN_BOUND, Math.round(value)))
}
