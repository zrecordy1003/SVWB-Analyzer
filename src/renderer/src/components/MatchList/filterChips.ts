/**
 * 對局列表的進階條件字彙：有哪幾條、各自叫什麼、生效中要怎麼描述，以及打開／
 * 關掉一條各是什麼補丁。
 *
 * 和分析器的 filterState 一樣是純函式而不是散在元件裡：chip 的文字和抽屜、＋
 * 選單講的必須是同一件事，而「一條條件現在算不算生效」這種判斷放在 render 裡
 * 會隨著版面改動而各自長歪。
 */
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined'
import SportsKabaddiOutlinedIcon from '@mui/icons-material/SportsKabaddiOutlined'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined'
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined'
import type { SvgIconComponent } from '@mui/icons-material'

import type { AdvancedChip } from '@renderer/components/Common/filters/AdvancedFilterBar'
import type { Filters } from './component/SearchBar'

/**
 * 時間範圍與模式不在這裡：那兩條是清單的主軸，常駐在工作列上，不是「收起來的
 * 進階條件」。
 */
export type MatchFilterKey = 'my' | 'oppo' | 'decks' | 'tags' | 'note' | 'cr'

export const MATCH_FILTER_LABELS: Record<MatchFilterKey, string> = {
  my: '我方職業',
  oppo: '對方職業',
  decks: '牌組',
  tags: '標籤',
  note: '備註',
  cr: 'CR 區間'
}

/** 一條條件一個字形，chip、＋ 選單、抽屜標題都用同一個。 */
export const MATCH_FILTER_ICONS: Record<MatchFilterKey, SvgIconComponent> = {
  my: ShieldOutlinedIcon,
  oppo: SportsKabaddiOutlinedIcon,
  decks: StyleOutlinedIcon,
  tags: LocalOfferOutlinedIcon,
  note: StickyNote2OutlinedIcon,
  cr: MilitaryTechOutlinedIcon
}

/** 兩個以內直接列名字，再多就只報數量 - chip 一長就沒人讀了。 */
function nameOrCount(names: string[], unit: string): string {
  if (names.length <= 2) return names.join('、')
  return `${names.length} 個${unit}`
}

/**
 * 關著的抽屜正在對查詢做什麼。
 *
 * 沒有這一列，上次開的篩選會在抽屜關上以後繼續默默縮小每一次查詢，而畫面上
 * 沒有任何東西說明。每顆 chip 都能單獨清掉，所以要退掉一條不必開抽屜。
 */
export function matchAdvancedChips(filters: Filters): AdvancedChip<MatchFilterKey>[] {
  const chips: AdvancedChip<MatchFilterKey>[] = []

  if (filters.my.length)
    chips.push({
      key: 'my',
      label: nameOrCount(
        filters.my.map((c) => c.label),
        '職業'
      )
    })
  if (filters.oppo.length)
    chips.push({
      key: 'oppo',
      label: nameOrCount(
        filters.oppo.map((c) => c.label),
        '職業'
      )
    })
  if (filters.decks.length)
    chips.push({
      key: 'decks',
      label: nameOrCount(
        filters.decks.map((d) => d.name),
        '牌組'
      )
    })
  if (filters.tags.length)
    chips.push({
      key: 'tags',
      label: nameOrCount(
        filters.tags.map((t) => t.name),
        '標籤'
      )
    })
  if (filters.note !== 'any')
    chips.push({ key: 'note', label: filters.note === 'with' ? '有備註' : '無備註' })
  if (filters.crEnabled) chips.push({ key: 'cr', label: `CR ${filters.crMin}–${filters.crMax}` })

  return chips
}

/** 把一條條件關掉的補丁。 */
export function clearMatchFilter(key: MatchFilterKey): Partial<Filters> {
  switch (key) {
    case 'my':
      return { my: [] }
    case 'oppo':
      return { oppo: [] }
    case 'decks':
      return { decks: [] }
    case 'tags':
      return { tags: [] }
    case 'note':
      return { note: 'any' }
    case 'cr':
      return { crEnabled: false }
  }
}

/**
 * 從無到有打開一條條件的補丁。
 *
 * 職業、牌組、標籤刻意回空補丁：它們要選了東西才算生效，所以「打開」就只是把
 * 編輯器開起來這個動作本身。備註預設成「有備註」，那是這條會被打開的理由。
 */
export function enableMatchFilter(key: MatchFilterKey): Partial<Filters> {
  switch (key) {
    case 'note':
      return { note: 'with' }
    case 'cr':
      return { crEnabled: true }
    default:
      return {}
  }
}

/** 一次關掉所有進階條件（時間範圍與模式不動）。 */
export function clearAllMatchFilters(): Partial<Filters> {
  return { my: [], oppo: [], decks: [], tags: [], note: 'any', crEnabled: false }
}
