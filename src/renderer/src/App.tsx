import React, { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ThemeProvider, createTheme, styled } from '@mui/material/styles'
import CircularProgress from '@mui/material/CircularProgress'
import CssBaseline from '@mui/material/CssBaseline'
import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
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
import AccountButton from './components/Sync/AccountButton'
import DeckManagerControl from './components/DeckManager/DeckManagerControl'
import About from './components/About/About'
import SupportPrompt from './components/Common/SupportPrompt'
import TelemetryPrompt from './components/Common/TelemetryPrompt'
import { preloadableLazy } from './components/Common/preloadableLazy'
const Analyzer = preloadableLazy(() => import('./components/Analyzer/Analyzer'))
const MatchList = preloadableLazy(() => import('./components/MatchList/MatchList'))
const DeckPerformance = preloadableLazy(
  () => import('./components/DeckPerformance/DeckPerformance')
)
/**
 * 卡片頁暫時停用 - 一張卡的勝率單看沒什麼可以下判斷的，要等之後那個數據分析
 * 的介面做出來、能把它和牌組、對局擺在一起看，這頁才講得出東西。程式碼、
 * `cards:stats` 和資料庫那邊都原封不動留著，要開回來只要把這裡、選單項目和
 * `PAGE_KEYS`、下面的 render 分支這四處的註解拿掉。
 */
// const CardsPage = preloadableLazy(() => import('./components/Cards/CardsPage'))
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
// const OpeningPage = preloadableLazy(() => import('./components/Opening/OpeningPage'))
/**
 * 環境：唯一一頁畫的不是本機資料的頁面，資料來自公開的統計端點。閒置時會預載
 * 它的程式碼（見 `App` 裡的預載），但請求要等頁面真的掛上去才發 - 沒點進去的人
 * 不會發出任何請求。
 */
const MetaPage = preloadableLazy(() => import('./components/Meta/MetaPage'))
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
const PAGES: Partial<Record<PageKey, React.ReactNode>> = {
  MatchList: <MatchList />,
  DeckPerformance: <DeckPerformance />,
  // Cards: <CardsPage />,
  // Opening: <OpeningPage />,
  Analyzer: <Analyzer />,
  Meta: <MetaPage />,
  Settings: <Settings />,
  About: <About />
}
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
  /**
   * 去過的分頁留在畫面裡，只是藏起來，不再一切走就卸載。
   *
   * 卸載的代價是每次切回來都重來一遍：重抓資料、骨架閃一下、篩選和捲動位置
   * 全歸零。頁面的資料本來就靠 `matches:needRefetch` / `reference-data:changed`
   * 這些廣播保持最新，藏著的時候照樣會收到，所以留著不會顯示舊資料。
   * 沒去過的頁不掛，啟動時只付第一頁的成本。
   */
  const [visited, setVisited] = useState<ReadonlySet<PageKey>>(() => new Set([currentPage]))
  // 每一頁共用 `Main` 這一個捲動容器，所以各頁的捲動位置由這裡記、這裡還。
  const mainRef = useRef<HTMLElement>(null)
  const scrollByPage = useRef(new Map<PageKey, number>())
  const goTo = (page: PageKey): void => {
    if (mainRef.current) scrollByPage.current.set(currentPage, mainRef.current.scrollTop)
    setCurrentPage(page)
    setVisited((prev) => (prev.has(page) ? prev : new Set(prev).add(page)))
  }
  const goToRef = useRef(goTo)
  goToRef.current = goTo
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = scrollByPage.current.get(currentPage) ?? 0
  }, [currentPage])
  // 第一頁畫完、手上沒事的時候把其他頁的程式碼先抓好，第一次切過去就不會
  // 看到轉圈。只抓程式碼，不掛元件，所以不會發出任何資料請求。
  useEffect(() => {
    const id = requestIdleCallback(() => {
      for (const page of [MatchList, DeckPerformance, Analyzer, MetaPage]) void page.preload()
    })
    return () => cancelIdleCallback(id)
  }, [])
  // The sidebar's selection background is one box that slides to the selected
  // item, measured from the item itself so it follows whatever height a label
  // wraps to. Null until the first measure, so it never animates in from the top.
  const navRefs = useRef(new Map<PageKey, HTMLDivElement>())
  const [navMark, setNavMark] = useState<{ top: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const el = navRefs.current.get(currentPage)
    if (el) setNavMark({ top: el.offsetTop, height: el.offsetHeight })
  }, [currentPage])

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
        mode: 'dark',
        // A cool near-black instead of MUI's neutral #121212, matching the
        // surface ramp in `Common/surfaces.ts` that dialogs and drawers use.
        background: { default: '#0f1217', paper: '#161b23' },
        divider: 'rgba(255,255,255,0.08)',
        text: { secondary: 'rgba(255,255,255,0.62)' }
      },
      typography: {
        // Segoe UI Variable for Latin and digits (it is what Windows 11 itself
        // uses), JhengHei UI for CJK. MUI's default stack is Roboto-first, and
        // with no Roboto installed every glyph fell to whatever Chrome picked.
        fontFamily:
          '"Segoe UI Variable Text", "Segoe UI", "Microsoft JhengHei UI", "Microsoft JhengHei", "Noto Sans TC", "PingFang TC", sans-serif',
        button: { textTransform: 'none', fontWeight: 500 }
      },
      components: {
        // No ripple anywhere: the click feedback is each control's own hover
        // and pressed state. Keyboard focus gets the ring below instead.
        MuiButtonBase: { defaultProps: { disableRipple: true } },
        MuiAppBar: {
          defaultProps: { elevation: 0 },
          styleOverrides: {
            root: {
              backgroundColor: 'rgba(15,18,23,0.82)',
              backgroundImage: 'none',
              backdropFilter: 'blur(12px)',
              borderBottom: '1px solid rgba(255,255,255,0.06)'
            }
          }
        },
        MuiDrawer: {
          styleOverrides: {
            paper: {
              backgroundColor: '#0f1217',
              backgroundImage: 'none',
              borderRight: '1px solid rgba(255,255,255,0.06)'
            }
          }
        },
        MuiTooltip: {
          styleOverrides: {
            tooltip: {
              backgroundColor: '#262d3a',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
              fontSize: 12,
              padding: '6px 10px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)'
            },
            arrow: { color: '#262d3a' }
          }
        },
        MuiPopover: {
          styleOverrides: {
            paper: {
              backgroundColor: '#1b212c',
              backgroundImage: 'none',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 16px 40px rgba(0,0,0,0.55)'
            }
          }
        },
        MuiCssBaseline: {
          styleOverrides: {
            body: {
              WebkitFontSmoothing: 'antialiased'
            },
            '.MuiButtonBase-root.Mui-focusVisible': {
              outline: '2px solid rgba(144,202,249,0.6)',
              outlineOffset: 2
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
    // 「關於」而不是「贊助」：這一頁講的是工具本身，贊助只是其中一塊。
    { key: 'About', text: '關於', icon: <InfoOutlinedIcon /> }
  ]

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
        if (PAGE_KEYS.includes(page)) goToRef.current(page)
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
            <AccountButton onOpenSettings={() => goTo('Settings')} />
            {/* The page title used to sit here; the sidebar already shows where you are. */}
            <Box sx={{ flexGrow: 1 }} />
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
                right: 16,
                top: 0,
                bottom: 0,
                display: 'flex',
                alignItems: 'center'
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
            <List sx={{ px: 0.75, pt: 1, position: 'relative' }}>
              {navMark && (
                <Box
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    left: (t) => t.spacing(0.75),
                    right: (t) => t.spacing(0.75),
                    top: 0,
                    height: navMark.height,
                    transform: `translateY(${navMark.top}px)`,
                    borderRadius: 1.5,
                    bgcolor: 'rgba(144,202,249,0.1)',
                    pointerEvents: 'none',
                    transition: (t) =>
                      t.transitions.create(['transform', 'height'], {
                        duration: 250,
                        easing: t.transitions.easing.easeInOut
                      }),
                    '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
                  }}
                />
              )}
              {menuItems.map(({ key, text, icon }) => (
                <ListItemButton
                  key={key}
                  ref={(el: HTMLDivElement | null) => {
                    if (el) navRefs.current.set(key, el)
                    else navRefs.current.delete(key)
                  }}
                  selected={currentPage === key}
                  onClick={() => goTo(key)}
                  // No ripple: the sliding selection box is the click feedback.
                  // Keyboard focus gets a ring below instead of the focus ripple.
                  disableRipple
                  sx={{
                    minHeight: 64,
                    mb: 0.5,
                    px: 0.5,
                    borderRadius: 1.5,
                    flexDirection: 'column',
                    justifyContent: 'center',
                    gap: 0.25,
                    // The sliding box above draws the selection; the item itself stays clear.
                    '&.Mui-selected': { bgcolor: 'transparent' },
                    '&.Mui-selected:hover': { bgcolor: 'action.hover' },
                    '&.Mui-focusVisible': {
                      bgcolor: 'transparent',
                      outline: 'none',
                      boxShadow: 'inset 0 0 0 2px rgba(144,202,249,0.6)'
                    }
                  }}
                >
                  <ListItemIcon
                    sx={{
                      minWidth: 0,
                      color: currentPage === key ? 'primary.main' : 'text.secondary',
                      transition: (t) => t.transitions.create('color', { duration: 250 })
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
        <Main ref={mainRef}>
          <Toolbar />
          {PAGE_KEYS.filter((key) => visited.has(key)).map((key) => (
            // `contents` 讓頁面照舊當 `Main` 的直接子層排版（它們靠 `flex: 1`
            // 拿剩下的高度）；藏起來就是 `none`，狀態和 DOM 都留著。每頁各自一個
            // Suspense，新頁在抓程式碼時不會把已經在畫面上的頁一起換成轉圈。
            <Box key={key} sx={{ display: key === currentPage ? 'contents' : 'none' }}>
              <Suspense fallback={<PageLoading />}>{PAGES[key]}</Suspense>
            </Box>
          ))}

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
