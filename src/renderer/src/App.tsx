import React, { lazy, Suspense, useMemo, useState } from 'react'

import { ThemeProvider, createTheme, keyframes, styled } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import AppBar from '@mui/material/AppBar'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Box from '@mui/material/Box'
// import Switch from '@mui/material/Switch'
import Drawer from '@mui/material/Drawer'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import useMediaQuery from '@mui/material/useMediaQuery'
import Tooltip from '@mui/material/Tooltip'
import { Zoom } from '@mui/material'

import TimelineIcon from '@mui/icons-material/Timeline'
import MenuIcon from '@mui/icons-material/Menu'
import BarChartIcon from '@mui/icons-material/BarChart'
import SettingsIcon from '@mui/icons-material/Settings'
import ListAltIcon from '@mui/icons-material/ListAlt'
import HomeIcon from '@mui/icons-material/Home'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
// import Sun from '@mui/icons-material/Brightness4'
// import Moon from '@mui/icons-material/Brightness7'
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'

import Disclaimer from './components/Disclaimer'
import GameStatus from './components/GameStatus'
import HomePage from './components/HomePage/HomePage'
import Settings from './components/Settings/Settings'
// const Analyzer = lazy(() => import('./components/Analyzer'))
const MatchList = lazy(() => import('./components/MatchList/MatchList'))
const MatchAnalytics = lazy(() => import('./components/MatchAnalytics/MatchAnalytics'))
const ChartBuilder = lazy(() => import('./components/ChartBuilder/ChartBuilder'))
// import Statistics from './components/Statistics'

const shakeAnimation = keyframes`
  0%   { transform: translateX(0); }
  20%  { transform: translateX(-4px); }
  40%  { transform: translateX(4px); }
  60%  { transform: translateX(-4px); }
  80%  { transform: translateX(4px); }
  100% { transform: translateX(0); }
`
// drawer width
const DRAWER_WIDTH = 240
const DRAWER_COLLAPSED_WIDTH = 60

// 為 Main Content 加上 margin-left
const Main = styled('main', {
  shouldForwardProp: (prop) => prop !== 'open'
})<{ open: boolean }>(({ theme, open }) => ({
  flexGrow: 1,
  padding: theme.spacing(3),
  // paddingBottom: 0,
  transition: theme.transitions.create('margin', {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen
  }),
  marginLeft: DRAWER_COLLAPSED_WIDTH,
  ...(open && {
    marginLeft: DRAWER_WIDTH
  }),
  height: '100vh',
  overflowY: 'auto'
}))

type PageKey = 'Home' | 'Analyzer' | 'MatchList' | 'MatchAnalytics' | 'Settings'

function App(): React.JSX.Element {
  // theme mode
  // const [mode, setMode] = useState<'light' | 'dark'>('dark')
  // const mode = 'dark'
  // const toggleTheme = (): void => {
  //   const nextMode = mode === 'light' ? 'dark' : 'light'
  //   // window.settings.set('theme', nextMode)
  //   setMode(nextMode)
  // }

  // drawer open?
  const [open, setOpen] = useState(false)
  const [lock, setLock] = useState(false)
  const [shake, setShake] = useState(false)
  const isMobile = useMediaQuery('(max-width:600px)')

  // current page
  const [currentPage, setCurrentPage] = useState<PageKey>('Home')

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
    { key: 'Home', text: '主頁', icon: <HomeIcon /> },
    { key: 'MatchList', text: '對局列表', icon: <ListAltIcon /> },
    { key: 'Analyzer', text: '分析器', icon: <TimelineIcon /> },
    { key: 'MatchAnalytics', text: '統計圖表', icon: <BarChartIcon /> },
    { key: 'Settings', text: '設定', icon: <SettingsIcon /> }
  ]

  // AppBar title 根據 page
  const titles: Record<PageKey, string> = {
    Home: '主頁',
    Analyzer: '分析器',
    MatchList: '對局列表',
    MatchAnalytics: '統計圖表',
    Settings: '設定'
  }

  const handleDrawerToggle = (): void => {
    if (!lock) {
      setOpen((prev) => !prev)
    } else {
      if (!shake) {
        setShake(true)
      }
    }
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />

      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          <IconButton color="inherit" edge="start" onClick={handleDrawerToggle} sx={{ mr: 2 }}>
            {
              open ? (
                <ChevronLeftIcon /> // 如果已展開，就顯示收合 icon
              ) : (
                <MenuIcon />
              ) // 如果收合中，就顯示展開 icon
            }
          </IconButton>
          <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
            {titles[currentPage]}
          </Typography>
          {/* <IconButton color="inherit" onClick={toggleTheme}>
            {mode === 'light' ? <Moon /> : <Sun />}
          </IconButton>
          <Switch checked={mode === 'dark'} onChange={toggleTheme} /> */}
        </Toolbar>
      </AppBar>

      {/* Drawer */}
      <Drawer
        variant="permanent"
        open={open}
        sx={{
          width: open ? DRAWER_WIDTH : DRAWER_COLLAPSED_WIDTH,
          flexShrink: 0,
          whiteSpace: 'nowrap',
          '& .MuiDrawer-paper': {
            width: open ? DRAWER_WIDTH : DRAWER_COLLAPSED_WIDTH,
            transition: theme.transitions.create('width', {
              easing: theme.transitions.easing.sharp,
              duration: theme.transitions.duration.enteringScreen
            }),
            overflowX: 'hidden',
            boxSizing: 'border-box'
          }
        }}
      >
        <Toolbar />

        <Box
          display={'flex'}
          flexDirection={'column'}
          justifyContent={'space-between'}
          height={'100%'}
        >
          <List>
            {menuItems.map(({ key, text, icon }) => (
              <Tooltip
                key={key}
                title={text}
                placement="right"
                disableHoverListener={open}
                slotProps={{
                  tooltip: {
                    sx: {
                      fontSize: '0.85rem',
                      bgcolor: '#333',
                      color: '#fff',
                      px: 2,
                      py: 1,
                      borderRadius: 1,
                      boxShadow: 3,
                      maxWidth: 200
                    }
                  }
                }}
                slots={{
                  transition: Zoom
                }}
              >
                <ListItemButton
                  key={key}
                  selected={currentPage === key}
                  onClick={() => {
                    setCurrentPage(key)
                    if (isMobile) {
                      // 手機版：選完自動收合
                      setOpen(false)
                    }
                  }}
                >
                  <ListItemIcon>{icon}</ListItemIcon>
                  <ListItemText primary={text} />
                </ListItemButton>
              </Tooltip>
            ))}
          </List>
          <Box>
            <Box display={'flex'} justifyContent={'start'}>
              <GameStatus open={open} />
            </Box>

            <Box
              display={'flex'}
              alignItems={'center'}
              justifyContent={'end'}
              height={'80px'}
              mr={'10px'}
              // bgcolor={'gray'}
            >
              <IconButton onClick={() => setLock(!lock)}>
                {lock ? (
                  <LockOutlinedIcon
                    sx={{
                      // color: ,
                      animation: shake ? `${shakeAnimation} 0.5s` : 'none'
                    }}
                    onAnimationEnd={() => setShake(false)}
                  />
                ) : (
                  <LockOpenOutlinedIcon sx={{ opacity: 0.3 }} />
                )}
              </IconButton>
            </Box>
          </Box>
        </Box>
      </Drawer>

      {/* 主內容 */}
      <Main open={open}>
        <Toolbar />
        <Suspense fallback={<div>載入中...</div>}>
          {currentPage === 'Home' && <HomePage />}
          {/* {currentPage === 'Analyzer' && <Analyzer />} */}
          {currentPage === 'MatchList' && <MatchList />}
          {currentPage === 'MatchAnalytics' && <MatchAnalytics />}
          {/* {currentPage === 'Settings' && <ChartBuilder />} */}
          {currentPage === 'Settings' && <Settings />}
        </Suspense>

        {/* Footer */}
        <Box component="footer" sx={{ textAlign: 'center', mt: 4 }}>
          <Disclaimer />
        </Box>
      </Main>
    </ThemeProvider>
  )
}

export default App
