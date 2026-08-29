import { ChipProps } from '@mui/material'

export const classes = [
  { id: 'elf', label: '精靈', color: '#6FD6A8', bgColor: '#28473b' },
  { id: 'royal', label: '皇家護衛', color: '#FFD54F', bgColor: '#5e4c1b' },
  { id: 'witch', label: '巫師', color: '#9181F3', bgColor: '#32294a' },
  { id: 'dragon', label: '龍族', color: '#F2A14A', bgColor: '#553a1b' },
  { id: 'bishop', label: '主教', color: '#E6D18C', bgColor: '#50492f' },
  { id: 'nightmare', label: '夜魔', color: '#E87AC5', bgColor: '#471d38' },
  { id: 'nemesis', label: '復仇者', color: '#66D8F5', bgColor: '#1b3441' }
]

export type ChipColor = Exclude<NonNullable<ChipProps['color']>, 'default'>

export interface ModeOption {
  id: string
  label: string
  color: ChipColor
  /**
   * Explicit hex for the places the mode is emphasised with weight and a glow
   * instead of a chip - `color` only names a MUI palette slot, which cannot be
   * turned into a shadow.
   */
  tone: string
}

export const modes: ModeOption[] = [
  { id: 'ranked', label: '階級對戰', color: 'info', tone: '#66D8F5' },
  { id: 'twoPick', label: '2Pick', color: 'error', tone: '#F28C8C' },
  { id: 'weekendPlaza', label: '週末廣場賽', color: 'secondary', tone: '#E87AC5' },
  { id: 'unranked', label: '自由對戰', color: 'primary', tone: '#8AB4F8' },
  { id: 'cpu', label: '練習模式', color: 'success', tone: '#75E2A8' },
  { id: 'custom', label: '自訂對戰', color: 'warning', tone: '#F2C879' },
  /**
   * 模式辨識失敗的落點，不是玩家選得到的模式。刻意留在這個清單裡，因為每個
   * 篩選器都是從 `modes` 長出來的 - 使用者要能問「我有多少場沒辨識到」，也
   * 要能把它們挑出來手動更正。灰色的 `tone` 讓它在視覺上不與真正的模式競爭。
   */
  { id: 'unknown', label: '未辨識', color: 'warning', tone: '#8A8F98' }
]

/**
 * 這些模式的牌是抽出來的，沒有「牌組」可言，所以整個 UI 都不給它們牌組欄位：
 * 卡片不留那一行，編輯視窗不給選，存檔時也會把殘留的牌組清掉。
 */
const MODES_WITHOUT_DECK = new Set<string>(['twoPick'])

export const isDecklessMode = (mode: string | null | undefined): boolean =>
  !!mode && MODES_WITHOUT_DECK.has(mode)

export const classesMap = Object.fromEntries(classes.map((c) => [c.id, c] as [string, typeof c]))

export const modesMap = Object.fromEntries(modes.map((c) => [c.id, c] as [string, typeof c]))
