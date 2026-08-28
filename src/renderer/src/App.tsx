import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { ThemeProvider, createTheme, styled } from '@mui/material/styles'
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
// import HomeIcon from '@mui/icons-material/Home'
// import Sun from '@mui/icons-material/Brightness4'
// import Moon from '@mui/icons-material/Brightness7'

// import Disclaimer from './components/Disclaimer'
import GameStatus from './components/GameStatus'
import Settings from './components/Settings/Settings'
import BattleStatus from './components/BattleStatus/BattleStatus'
import UpdateBackground from './components/Update/UpdateBackground'
import DeckManagerControl from './components/DeckManager/DeckManagerControl'
import About from './components/About/About'
import SupportPrompt from './components/Common/SupportPrompt'
const Analyzer = lazy(() => import('./components/Analyzer/Analyzer'))
const MatchList = lazy(() => import('./components/MatchList/MatchList'))
const DeckPerformance = lazy(() => import('./components/DeckPerformance/DeckPerformance'))
// import Statistics from './components/Statistics'

const DRAWER_COLLAPSED_WIDTH = 92

const Main = styled('main')(({ theme }) => ({
  flexGrow: 1,
  padding: theme.spacing(3),
  marginLeft: DRAWER_COLLAPSED_WIDTH,
  height: '100vh',
  overflowY: 'auto'
}))

type PageKey = 'Analyzer' | 'MatchList' | 'DeckPerformance' | 'Settings' | 'About'

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
    // determine scrollbar colors based on mode
    // const trackColor = mode === 'light' ? '#f0f0f0' : '#303030'
    // const thumbColor = mode === 'light' ? '#c1c1c1' : '#555'
    const trackColor = '#303030'
    const thumbColor = '#555'

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
              width: '8px',
              height: '8px'
            },
            '*::-webkit-scrollbar-track': {
              backgroundColor: trackColor,
              transition: 'background-color 0.3s'
            },
            '*::-webkit-scrollbar-thumb': {
              backgroundColor: thumbColor,
              borderRadius: '4px',
              transition: 'background-color 0.3s'
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
    { key: 'Analyzer', text: '分析器', icon: <TimelineIcon /> },
    { key: 'Settings', text: '設定', icon: <SettingsIcon /> },
    { key: 'About', text: '關於與授權', icon: <InfoOutlinedIcon /> }
  ]

  // AppBar title 根據 page
  const titles: Record<PageKey, string> = {
    Analyzer: '分析器',
    MatchList: '對局列表',
    DeckPerformance: '牌組戰績',
    Settings: '設定',
    About: '關於與授權'
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
        if (
          page === 'Analyzer' ||
          page === 'MatchList' ||
          page === 'DeckPerformance' ||
          page === 'Settings' ||
          page === 'About'
        ) {
          setCurrentPage(page)
        }
      }
    )
    return () => unsubscribe?.()
  }, [])

  const battleStatusEl = useMemo(() => <BattleStatus />, []) // 只建立一次

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <UpdateBackground />
      <SupportPrompt />
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
              pb: 3
            }}
          >
            <Box display={'flex'} justifyContent={'center'}>
              <GameStatus open={false} />
            </Box>
          </Box>
        </Box>
      </Drawer>

      {/* 主內容 */}
      <Main>
        <Toolbar />
        <Suspense fallback={<div>載入中...</div>}>
          {currentPage === 'MatchList' && <MatchList />}
          {currentPage === 'DeckPerformance' && <DeckPerformance />}
          {currentPage === 'Analyzer' && <Analyzer />}
          {currentPage === 'Settings' && <Settings />}
          {currentPage === 'About' && <About />}
        </Suspense>

        {/* Footer */}
        {/* <Box component="footer" sx={{ textAlign: 'center', mt: 2 }}> */}
        {/* <Disclaimer /> */}
        {/* </Box> */}
      </Main>
    </ThemeProvider>
  )
}

export default App
