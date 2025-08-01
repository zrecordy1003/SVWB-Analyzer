import Lovesign from '../../../../resources/character/Lovesign.png'
import MarieMalisse from '../../../../resources/character/MarieMalisse.png'
import KaoriYuihara from '../../../../resources/character/KaoriYuihara.png'
import Galan from '../../../../resources/character/Galan.png'
import Esperanza from '../../../../resources/character/Esperanza.png'
import Diawl from '../../../../resources/character/Diawl.png'
import Dreizehn from '../../../../resources/character/Dreizehn.png'

export const classes = [
  { id: 1, name: 'elf', label: '精靈', code: 'Digit1', src: Lovesign },
  { id: 2, name: 'royal', label: '皇家護衛', code: 'Digit2', src: MarieMalisse },
  { id: 3, name: 'witch', label: '巫師', code: 'Digit3', src: KaoriYuihara },
  { id: 4, name: 'dragon', label: '龍族', code: 'Digit4', src: Galan },
  { id: 5, name: 'bishop', label: '主教', code: 'Digit5', src: Esperanza },
  { id: 6, name: 'nightmare', label: '夜魔', code: 'Digit6', src: Diawl },
  { id: 7, name: 'nemesis', label: '復仇者', code: 'Digit7', src: Dreizehn }
]

export const modes = ['ranked', 'unranked', 'cpu', 'plaza']

export const classesMap = Object.fromEntries(classes.map((c) => [c.name, c] as [string, typeof c]))
