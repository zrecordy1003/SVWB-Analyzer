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
}

export const modes: ModeOption[] = [
  { id: 'ranked', label: '階級對戰', color: 'info' },
  { id: 'twoPick', label: '2Pick', color: 'error' },
  { id: 'weekendPlaza', label: '週末廣場賽', color: 'secondary' },
  { id: 'unranked', label: '自由對戰', color: 'primary' },
  { id: 'cpu', label: '練習模式', color: 'success' },
  { id: 'custom', label: '自訂對戰', color: 'warning' }
]

export const classesMap = Object.fromEntries(classes.map((c) => [c.id, c] as [string, typeof c]))

export const modesMap = Object.fromEntries(modes.map((c) => [c.id, c] as [string, typeof c]))
