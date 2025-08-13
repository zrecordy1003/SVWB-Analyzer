import { ChipProps } from '@mui/material'

export const classes = [
  { name: 'elf', label: '精靈', color: '#6FD6A8', bgColor: '#28473b' },
  { name: 'royal', label: '皇家護衛', color: '#FFD54F', bgColor: '#5e4c1b' },
  { name: 'witch', label: '巫師', color: '#9181F3', bgColor: '#32294a' },
  { name: 'dragon', label: '龍族', color: '#F2A14A', bgColor: '#553a1b' },
  { name: 'bishop', label: '主教', color: '#E6D18C', bgColor: '#50492f' },
  { name: 'nightmare', label: '夜魔', color: '#E87AC5', bgColor: '#471d38' },
  { name: 'nemesis', label: '復仇者', color: '#66D8F5', bgColor: '#1b3441' }
]

export type ChipColor = Exclude<NonNullable<ChipProps['color']>, 'default'>

export interface ModeOption {
  value: string
  label: string
  color: ChipColor
}

export const modes: ModeOption[] = [
  { value: 'ranked', label: '階級對戰', color: 'info' },
  { value: 'twoPick', label: '2Pick', color: 'error' },
  { value: 'weekendPlaza', label: '週末廣場賽', color: 'secondary' },
  { value: 'unranked', label: '自由對戰', color: 'primary' },
  { value: 'cpu', label: '練習模式', color: 'success' },
  { value: 'custom', label: '自訂對戰', color: 'warning' }
]

export const classesMap = Object.fromEntries(classes.map((c) => [c.name, c] as [string, typeof c]))
