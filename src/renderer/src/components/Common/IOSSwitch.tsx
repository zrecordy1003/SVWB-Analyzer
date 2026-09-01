/**
 * iOS 式的開關：一顆填滿的膠囊軌道，加一塊會滑過去的白色圓鈕。
 *
 * MUI 預設的 Switch 是 Material 的畫法——細軌道、圓鈕浮在軌道之外、外圈還有一
 * 圈漣漪，開與關的差別主要靠顏色深淺。在深色底上那個差別很弱，一排設定看下來
 * 要盯著才知道哪幾項是開的。iOS 的畫法把「開」表達成整條軌道被填滿，圓鈕滑到
 * 另一端——形狀本身就說完了狀態，掃過一眼就分得出來。
 *
 * 同一個 `Switch` 元件，只換外觀，所以 `checked` / `onChange` / `disabled` 與
 * 鍵盤操作都和原本一樣。與 [SegmentedControl] 同一套視覺語彙。
 */
import { Switch, type SwitchProps } from '@mui/material'
import { alpha, styled } from '@mui/material/styles'

/** iOS 的系統綠。刻意不用 primary：按鈕與 chip 已經是藍的，開關再用藍色，
 *  「這是可按的東西」和「這項是開著的」就會長得一樣。 */
const ON = '#34C759'

export const IOSSwitch = styled((props: SwitchProps) => (
  <Switch focusVisibleClassName=".Mui-focusVisible" disableRipple {...props} />
))(({ theme }) => ({
  width: 44,
  height: 26,
  padding: 0,
  display: 'flex',
  overflow: 'visible',
  // MUI 的 Switch 靠 12px 的內距撐出漣漪範圍，FormControlLabel 則用 -11px 的
  // 負外距把它拉回對齊。這裡內距歸零，那個負值就會讓開關凸出欄位左緣、而且和
  // 標籤黏在一起——所以把兩者一起補回來。
  margin: '0 10px 0 12px',
  '& .MuiSwitch-switchBase': {
    padding: 3,
    transitionDuration: '220ms',
    '&.Mui-checked': {
      transform: 'translateX(18px)',
      color: '#fff',
      '& + .MuiSwitch-track': {
        backgroundColor: ON,
        opacity: 1,
        border: 0
      },
      '&.Mui-disabled + .MuiSwitch-track': {
        opacity: 0.35
      }
    },
    '&.Mui-focusVisible .MuiSwitch-thumb': {
      boxShadow: `0 0 0 3px ${alpha(ON, 0.5)}`
    },
    '&.Mui-disabled .MuiSwitch-thumb': {
      color: alpha('#fff', 0.6)
    },
    '&.Mui-disabled + .MuiSwitch-track': {
      opacity: 0.25
    }
  },
  '& .MuiSwitch-thumb': {
    boxSizing: 'border-box',
    width: 20,
    height: 20,
    color: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.45)'
  },
  '& .MuiSwitch-track': {
    borderRadius: 13,
    backgroundColor: alpha(theme.palette.common.white, 0.2),
    opacity: 1,
    transition: theme.transitions.create(['background-color'], { duration: 220 })
  }
}))

export default IOSSwitch
