/**
 * 時間區間怎麼稱呼，以及它現在有沒有在縮小查詢。
 *
 * 分析器和牌組戰績都把時間區間收成一顆進階條件 chip，兩邊的 chip 必須讀起來
 * 一模一樣 - 「7 天內」和「自訂：a – b」各寫一份，第一次改文案就會分岔。
 */
import type { RangeKey } from '@shared/types'

/** Labels for the quick ranges, shared by the range buttons and the summary. */
export const RANGE_LABELS: Record<RangeKey, string> = {
  today: '今天',
  '7d': '7 天內',
  '30d': '30 天內',
  all: '生涯',
  custom: '自訂'
}

/**
 * 這個區間的 chip 文字，或 `null` 代表它沒有在縮小任何東西。
 *
 * `all` 回 null 而不是「生涯」：chip 這一列講的是「關著的條件正在對查詢做什麼」，
 * 一顆寫著「全部」的 chip 只會讓人以為自己被篩掉了什麼。
 */
export function rangeChipLabel(
  rangeKey: RangeKey,
  startDate: Date | null,
  endDate: Date | null
): string | null {
  if (rangeKey === 'custom') {
    const fmt = (d: Date | null): string => (d ? d.toLocaleDateString() : '—')
    return `${fmt(startDate)} – ${fmt(endDate)}`
  }
  return rangeKey === 'all' ? null : RANGE_LABELS[rangeKey]
}
