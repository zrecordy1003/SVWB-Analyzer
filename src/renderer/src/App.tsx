import React, { useMemo, useState } from 'react'
import {
  ThemeProvider,
  createTheme,
  CssBaseline,
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Box,
  Switch
} from '@mui/material'
import { Brightness4, Brightness7 } from '@mui/icons-material'
import MenuIcon from '@mui/icons-material/Menu'
import Disclaimer from './components/Disclaimer'
import ClassSelector from './components/ClassSelector'
import Analyzer from './components/Analyzer'
import MatchList from './components/MatchList'

function App(): React.JSX.Element {
  // 1. state for theme mode
  const [mode, setMode] = useState<'light' | 'dark'>('dark')

  // 2. memoize theme so it only rebuilds when mode changes
  const theme = useMemo(() => {
    // determine scrollbar colors based on mode
    const trackColor = mode === 'light' ? '#f0f0f0' : '#303030'
    const thumbColor = mode === 'light' ? '#c1c1c1' : '#555'

    return createTheme({
      palette: {
        mode,
        primary: { main: '#1976d2' },
        secondary: { main: '#dc004e' }
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
  }, [mode])

  // 3. toggle handler
  const toggleTheme = (): void => {
    setMode((prev) => (prev === 'light' ? 'dark' : 'light'))
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />

      {/* Top AppBar with theme switch */}
      <AppBar position="static">
        <Toolbar>
          <IconButton size="large" edge="start" color="inherit" aria-label="menu" sx={{ mr: 2 }}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            SV Tool
          </Typography>
          <IconButton onClick={toggleTheme}>
            {mode === 'light' ? <Brightness4 /> : <Brightness7 />}
          </IconButton>
          <Switch checked={mode === 'dark'} onChange={toggleTheme} />
        </Toolbar>
      </AppBar>
      <Box>
        {/* Main content */}
        <Box p={2}>
          <ClassSelector />
          <Analyzer />
          <MatchList />
        </Box>

        {/* Footer disclaimer */}
        <Box component="footer" sx={{ textAlign: 'center', p: 1 }}>
          <Disclaimer />
        </Box>
      </Box>
    </ThemeProvider>
  )
}

export default App
