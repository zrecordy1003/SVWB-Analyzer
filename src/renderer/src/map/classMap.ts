import { ChipProps } from '@mui/material'

/**
 * The seven classes, and how they are coloured.
 *
 * # Where these colours come from
 *
 * The HUE of each is taken from the official class icon on shadowverse-wb.com
 * (`/assets/images/common/common/class/class_<id>.svg`, keyed by these very ids
 * - the path is NOT numbered by the portal's `class_id`), so the identity is the
 * game's rather than something invented here:
 *
 *   elf #439159 · royal #797b1b · witch #535fa3 · dragon #a05a12
 *   nightmare #8d1e41 · bishop #b0a98d · nemesis #5bcce3
 *
 * Those fills are drawn for a light background and are far too dark to read as
 * text on this app's near-black surfaces, so only the hue is kept: saturation is
 * normalised (otherwise bishop and royal read as grey next to the others) and
 * lightness is fixed at a single bright level, the way class names look in game.
 *
 * The result was checked for contrast against the app background (#111318)
 * rather than eyeballed - the weakest is witch at 5.3:1, comfortably past
 * WCAG AA. If you retune a colour, re-check it; a class name nobody can read is
 * worse than one that is slightly off-brand.
 *
 * The emblems themselves are now shown too, by `ClassIcon`, fetched at runtime
 * and never bundled. That is why the fills above are only ever a reference and
 * must not drift: the two sit side by side, so a hue invented here would read
 * as a mismatch against the real artwork rather than as a house colour.
 */
export const classes = [
  { id: 'elf', label: '精靈', color: '#6eed92', bgColor: '#14331d' },
  { id: 'royal', label: '皇家護衛', color: '#f3f764', bgColor: '#353512' },
  { id: 'witch', label: '巫師', color: '#6e81ed', bgColor: '#141933' },
  { id: 'dragon', label: '龍族', color: '#f8ae62', bgColor: '#362412' },
  { id: 'bishop', label: '主教', color: '#edd46e', bgColor: '#332d14' },
  { id: 'nightmare', label: '夜魔', color: '#f86392', bgColor: '#36121d' },
  { id: 'nemesis', label: '復仇者', color: '#62dff8', bgColor: '#123036' }
]

/**
 * How a class NAME should be set, as opposed to merely coloured.
 *
 * In game a class name is heavy, slightly tracked out, and carries a dark
 * outline so it stays readable over card art. The outline is the part that
 * matters most here: the same label has to work on a flat settings row and on
 * top of a 530x687 illustration, and colour alone does not survive the second.
 *
 * The game's own typeface is licensed and is not ours to ship, so this matches
 * the treatment rather than the letterforms.
 */
export function classTextSx(id: string | null | undefined): {
  color: string
  fontWeight: number
  letterSpacing: string
  textShadow: string
} {
  return {
    color: classesMap[String(id)]?.color ?? 'text.primary',
    fontWeight: 800,
    letterSpacing: '0.045em',
    // A ring rather than a single offset shadow: an offset one leaves the
    // opposite edge of each stroke sitting directly on the artwork.
    textShadow:
      '0 1px 2px rgba(0,0,0,.95), 0 -1px 1px rgba(0,0,0,.7), 1px 0 1px rgba(0,0,0,.7), -1px 0 1px rgba(0,0,0,.7)'
  }
}

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
