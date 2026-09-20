import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { ThemeProvider, createTheme, styled } from '@mui/material/styles'
import CircularProgress from '@mui/material/CircularProgress'
import CssBaseline from '@mui/material/CssBaseline'
import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'
// import Switch from '@mui/material/Switch'
import Drawer from '@mui/material/Drawer'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'

import TimelineIcon from '@mui/icons-material/Timeline'
import SettingsIcon from '@mui/icons-material/Settings'
import ListAltIcon from '@mui/icons-material/ListAlt'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import StyleOutlinedIcon from '@mui/icons-material/StyleOutlined'
// 起手頁停用期間一起註解，見下方 OpeningPage。
// import BackHandOutlinedIcon from '@mui/icons-material/BackHandOutlined'
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined'
// import AutoAwesomeMotionOutlinedIcon from '@mui/icons-material/AutoAwesomeMotionOutlined'
// import HomeIcon from '@mui/icons-material/Home'
// import Sun from '@mui/icons-material/Brightness4'
// import Moon from '@mui/icons-material/Brightness7'

// import Disclaimer from './components/Disclaimer'
import GameStatus from './components/GameStatus'
import Settings from './components/Settings/Settings'
import BattleStatus from './components/BattleStatus/BattleStatus'
import UpdateProvider from './components/Update/UpdateProvider'
import SidebarVersion from './components/Update/SidebarVersion'
import DeckManagerControl from './components/DeckManager/DeckManagerControl'
import About from './components/About/About'
import SupportPrompt from './components/Common/SupportPrompt'
import TelemetryPrompt from './components/Common/TelemetryPrompt'
const Analyzer = lazy(() => import('./components/Analyzer/Analyzer'))
const MatchList = lazy(() => import('./components/MatchList/MatchList'))
const DeckPerformance = lazy(() => import('./components/DeckPerformance/DeckPerformance'))
/**
 * 卡片頁暫時停用 - 一張卡的勝率單看沒什麼可以下判斷的，要等之後那個數據分析
 * 的介面做出來、能把它和牌組、對局擺在一起看，這頁才講得出東西。程式碼、
 * `cards:stats` 和資料庫那邊都原封不動留著，要開回來只要把這裡、選單項目和
 * `PAGE_KEYS`、下面的 render 分支這四處的註解拿掉。
 */
// const CardsPage = lazy(() => import('./components/Cards/CardsPage'))
/**
 * 起手頁在這一版不上側邊欄，但**資料照收**。
 *
 * 收資料的是引擎（`tools/engine/src/store.rs` 直接寫 `MatchOpeningCard`），
 * 和這個檔案、和整個 renderer 都沒有關係，所以把入口藏起來不會讓任何一場對局
 * 少記一筆。這正是這樣做的目的：換牌建議要能講話需要**每個對位幾百場**，而
 * 那些場次只能靠時間累積。先發一版安靜地收，下一版把頁面打開時，使用者看到的
 * 是已經有幾週歷史的資料，而不是一頁空的。
 *
 * 頁面本身、`cards:openingStats`、`cards:mulligan`、`matches:openingHand*`
 * 全部原封不動留著；對局列表那條每一場的手牌帶也留著，它是使用者（和你）唯一
 * 能看出辨識到底有沒有在跑的地方。
 *
 * 要開回來：把這裡、選單項目、`PAGE_KEYS`、下面的 render 分支這四處的註解拿掉，
 * 和 `CardsPage` 同一個作法。
 */
// const OpeningPage = lazy(() => import('./components/Opening/OpeningPage'))
/**
 * 環境：唯一一頁畫的不是本機資料的頁面，資料來自公開的統計端點。lazy 在這裡
 * 比其他頁更划算 - 沒點進去的人連那段程式碼都不會抓，也不會發出任何請求。
 */
const MetaPage = lazy(() => import('./components/Meta/MetaPage'))
// import Statistics from './components/Statistics'

const DRAWER_COLLAPSED_WIDTH = 92

/**
 * 主內容區是一欄 flex：工具列佔掉固定的一段，剩下的高度整個交給頁面。
 *
 * 頁面因此不必自己算 `100vh - 某個數字` - 那個數字得把這裡的 padding 和工具列
 * 一起猜對，猜差了就是視窗最小時多出幾像素的捲動。頁面只要說 `flex: 1` 就會
 * 拿到剩下的高度，視窗多小都成立；內容真的塞不下時這裡仍然會捲，不會被裁掉。
 */
const Main = styled('main')(({ theme }) => ({
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  padding: theme.spacing(3),
  marginLeft: DRAWER_COLLAPSED_WIDTH,
  height: '100vh',
  overflowY: 'auto'
}))

/**
 * `Suspense` 的 fallback，只有第一次切到某個分頁、它的程式碼區塊還沒抓下來時
 * 才會短暫出現。原本是一行沒有高度的純文字，切過去的瞬間版面先塌成一行、
 * 抓完再彈回整頁高度，看起來就像畫面抖了一下。這裡改成撐滿 `Main` 剩下的
 * 高度，換頁時的版面大小從頭到尾不變。
 */
const PageLoading = (): React.JSX.Element => (
  <Box flex={1} display="flex" alignItems="center" justifyContent="center">
    <CircularProgress size={28} />
  </Box>
)

type PageKey =
  | 'Analyzer'
  | 'MatchList'
  | 'DeckPerformance'
  | 'Cards'
  | 'Opening'
  | 'Meta'
  | 'Settings'
  | 'About'
const PAGE_KEYS: readonly PageKey[] = [
  'Analyzer',
  'MatchList',
  'DeckPerformance',
  // 'Cards', // 見上面 CardsPage 的說明
  // 'Opening', // 見上面 OpeningPage 的說明——資料照收，只是不上選單

  'Meta',
  'Settings',
  'About'
]

function App(): React.JSX.Element {
  // theme mode
  // const [mode, setMode] = useState<'light' | 'dark'>('dark')
  // const mode = 'dark'
  // const toggleTheme = (): void => {
  //   const nextMode = mode === 'light' ? 'dark' : 'light'
  //   // window.settings.set('theme', nextMode)
  //   setMode(nextMode)
  // }

  // current page
  const [currentPage, setCurrentPage] = useState<PageKey>('MatchList')

  // build theme

  // 2. memoize theme so it only rebuilds when mode changes
  const theme = useMemo(() => {
    /**
     * Scrollbars.
     *
     * The track used to be an opaque `#303030`. On a near-black page that is not
     * a scrollbar, it is a light grey stripe down the side of every scrollable
     * panel - the "white lines" in the deck builder were this, not a border.
     *
     * Transparent track, translucent thumb: the bar is now only visible where
     * there is actually something to drag, and it tints whatever is behind it
     * instead of covering it with a colour of its own.
     */
    const trackColor = 'transparent'
    const thumbColor = 'rgba(255,255,255,0.16)'
    const thumbHoverColor = 'rgba(255,255,255,0.28)'

    return createTheme({
      palette: {
        mode: 'dark'
        // primary: { main: '#1976d2' },
        // secondary: { main: '#dc004e' }
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            // Global background and text color transition
            body: {
              fontFamily: '"Noto Sans TC", "Roboto", sans-serif',
              transition: 'background-color 0.3s, color 0.3s'
            },
            // Custom scrollbar styling with transition
            '*::-webkit-scrollbar': {
              width: '10px',
              height: '10px'
            },
            '*::-webkit-scrollbar-track': {
              backgroundColor: trackColor
            },
            '*::-webkit-scrollbar-thumb': {
              backgroundColor: thumbColor,
              borderRadius: '999px',
              // Inset by a transparent border rather than by width, so the
              // groove keeps its hit area while the visible thumb stays slim.
              border: '3px solid transparent',
              backgroundClip: 'content-box',
              transition: 'background-color 0.2s'
            },
            '*::-webkit-scrollbar-thumb:hover': {
              backgroundColor: thumbHoverColor
            },
            // Nothing to draw where the two bars meet; the default is a small
            // opaque square that reads as a speck of dirt in the corner.
            '*::-webkit-scrollbar-corner': {
              backgroundColor: 'transparent'
            }
          }
        }
      }
    })
  }, [])

  // menu items
  const menuItems: Array<{ key: PageKey; text: string; icon: React.ReactNode }> = [
    { key: 'MatchList', text: '對局列表', icon: <ListAltIcon /> },
    { key: 'DeckPerformance', text: '牌組戰績', icon: <StyleOutlinedIcon /> },
    // 疊起來的幾張：牌組戰績那顆是「一副牌」，這顆是「一堆卡」。
    // { key: 'Cards', text: '卡片', icon: <AutoAwesomeMotionOutlinedIcon /> },
    // 一隻手：起手是「手上的牌」，和上面兩顆的牌組、卡片分開。
    // { key: 'Opening', text: '起手', icon: <BackHandOutlinedIcon /> },
    { key: 'Analyzer', text: '分析器', icon: <TimelineIcon /> },
    // 一顆地球：分析器看的是自己的資料，這一頁看的是所有人的。
    { key: 'Meta', text: '環境數據', icon: <PublicOutlinedIcon /> },
    { key: 'Settings', text: '設定', icon: <SettingsIcon /> },
    { key: 'About', text: '贊助', icon: <InfoOutlinedIcon /> }
  ]

  // AppBar title 根據 page
  const titles: Record<PageKey, string> = {
    Analyzer: '分析器',
    MatchList: '對局列表',
    DeckPerformance: '牌組戰績',
    Cards: '卡片',
    Opening: '起手',
    Meta: '環境數據',
    Settings: '設定',
    About: '贊助'
  }

  useEffect(() => {
    requestAnimationFrame(() => {
      window.electron.ipcRenderer.send?.('renderer:ready')
    })
  }, [])

  /**
   * The HUD can ask for a page - its "完整對戰歷史" link raises this window and
   * expects to land on the list, not on whatever page was last open.
   */
  useEffect(() => {
    const unsubscribe = window.electron?.ipcRenderer.on(
      'app:navigate',
      (_event: unknown, page: PageKey) => {
        if (PAGE_KEYS.includes(page)) setCurrentPage(page)
      }
    )
    return () => unsubscribe?.()
  }, [])

  const battleStatusEl = useMemo(() => <BattleStatus />, []) // 只建立一次

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <UpdateProvider>
        <SupportPrompt />
        <TelemetryPrompt />
        <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
          <Toolbar sx={{ position: 'relative' }}>
            <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
              {titles[currentPage]}
            </Typography>
            <Box
              sx={{
                position: 'absolute',
                left: '35%',
                height: '100%',
                transform: 'translateY(3px)'
              }}
            >
              <DeckManagerControl />
            </Box>
            <Box
              sx={{
                position: 'absolute',
                right: '25px',
                transform: 'translateY(7px)'
              }}
            >
              {battleStatusEl}
            </Box>
          </Toolbar>
        </AppBar>

        {/* Drawer */}
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_COLLAPSED_WIDTH,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            '& .MuiDrawer-paper': {
              width: DRAWER_COLLAPSED_WIDTH,
              overflowX: 'hidden',
              boxSizing: 'border-box'
            }
          }}
        >
          <Toolbar />

          <Box display={'flex'} flexDirection={'column'} height={'100%'}>
            <List sx={{ px: 0.75, pt: 1 }}>
              {menuItems.map(({ key, text, icon }) => (
                <ListItemButton
                  key={key}
                  selected={currentPage === key}
                  onClick={() => setCurrentPage(key)}
                  sx={{
                    minHeight: 64,
                    mb: 0.5,
                    px: 0.5,
                    borderRadius: 1.5,
                    flexDirection: 'column',
                    justifyContent: 'center',
                    gap: 0.25,
                    '&.Mui-selected': { bgcolor: 'action.selected' },
                    '&.Mui-selected:hover': { bgcolor: 'action.selected' }
                  }}
                >
                  <ListItemIcon
                    sx={{
                      minWidth: 0,
                      color: currentPage === key ? 'primary.main' : 'text.secondary'
                    }}
                  >
                    {icon}
                  </ListItemIcon>
                  <ListItemText
                    primary={text}
                    slotProps={{
                      primary: { fontSize: 11, textAlign: 'center' }
                    }}
                    sx={{ m: 0, whiteSpace: 'normal', lineHeight: 1.15 }}
                  />
                </ListItemButton>
              ))}
            </List>
            <Box
              sx={{
                mt: 'auto',
                // Small, because `SidebarVersion` already reserves a line below
                // the version for its status. That reserved slot reads as bottom
                // padding whenever it is empty, so anything generous here leaves
                // the version stranded well above the edge.
                pb: 1
              }}
            >
              <Box display={'flex'} justifyContent={'center'}>
                <GameStatus open={false} />
              </Box>
              <Box sx={{ px: 1, mt: 1.5 }}>
                <SidebarVersion />
              </Box>
            </Box>
          </Box>
        </Drawer>

        {/* 主內容 */}
        <Main>
          <Toolbar />
          <Suspense fallback={<PageLoading />}>
            {currentPage === 'MatchList' && <MatchList />}
            {currentPage === 'DeckPerformance' && <DeckPerformance />}
            {/* {currentPage === 'Cards' && <CardsPage />} */}
            {/* {currentPage === 'Opening' && <OpeningPage />} */}
            {currentPage === 'Analyzer' && <Analyzer />}
            {currentPage === 'Meta' && <MetaPage />}
            {currentPage === 'Settings' && <Settings />}
            {currentPage === 'About' && <About />}
          </Suspense>

          {/* Footer */}
          {/* <Box component="footer" sx={{ textAlign: 'center', mt: 2 }}> */}
          {/* <Disclaimer /> */}
          {/* </Box> */}
        </Main>
      </UpdateProvider>
    </ThemeProvider>
  )
}

export default App
