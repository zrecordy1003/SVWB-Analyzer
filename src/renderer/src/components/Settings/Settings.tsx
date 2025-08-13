import { Box, Switch, FormControlLabel, Select, MenuItem, Divider, Typography } from '@mui/material'
import React, { useEffect, useState } from 'react'
import UpdatePrompt from '../UpdatePrompt/UpdatePrompt'

type OnCloseBehavior = 'minimize' | 'exit'
type ThemeType = 'system' | 'light' | 'dark'

interface AppSettings {
  enableNotifications: boolean
  onCloseBehavior: OnCloseBehavior
  askBeforeExit: boolean
  startOnBoot: boolean
  reduceAnimations: boolean
  autoCheckUpdates: boolean
  autoInstallUpdates: boolean
  theme: ThemeType
}

// 預設設定
const DEFAULT_SETTINGS: AppSettings = {
  enableNotifications: true,
  onCloseBehavior: 'minimize',
  askBeforeExit: true,
  startOnBoot: false,
  reduceAnimations: false,
  autoCheckUpdates: false,
  autoInstallUpdates: false,
  theme: 'system'
}

const Settings: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  // 載入設定
  useEffect(() => {
    window.settings
      .getAll()
      .then((saved) => {
        setSettings({ ...DEFAULT_SETTINGS, ...saved })
      })
      .catch((err) => {
        console.error('Failed to load settings:', err)
      })
  }, [])

  // 只要有更動就存檔（或是每個 Switch/Select 都呼叫 set）
  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      window.settings.set(key, value)
      return next
    })
  }

  return (
    <Box>
      {/* <h2 style={{ marginTop: 0 }}>一般</h2> */}

      {/* <FormControlLabel
        control={
          <Switch
            checked={settings.reduceAnimations}
            onChange={(_, checked) => handleChange('reduceAnimations', checked)}
          />
        }
        label="Reduce Animations"
      /> */}

      {/* <Box mt={1}>
        <label>Theme: </label>
        <Select
          value={settings.theme}
          onChange={(e) => handleChange('theme', e.target.value as ThemeType)}
          size="small"
        >
          <MenuItem value="system">System</MenuItem>
          <MenuItem value="light">Light</MenuItem>
          <MenuItem value="dark">Dark</MenuItem>
        </Select>
      </Box> */}

      {/* <Divider /> */}
      <Box display={'flex'} flexDirection={'column'} width={'max-content'} gap={1}>
        <Typography variant="h5">通知</Typography>
        <FormControlLabel
          control={
            <Switch
              checked={settings.enableNotifications}
              onChange={(_, checked) => handleChange('enableNotifications', checked)}
            />
          }
          label="開啟應用通知"
        />
      </Box>

      <Divider sx={{ mt: '10px', mb: '20px' }} />
      <Box display={'flex'} flexDirection={'column'} width={'max-content'} gap={1}>
        <Typography variant="h5">啟動與關閉</Typography>
        <FormControlLabel
          control={
            <Switch
              checked={settings.startOnBoot}
              onChange={(_, checked) => {
                handleChange('startOnBoot', checked)
                window.electron.ipcRenderer.send('settings:startOnBoot', checked)
              }}
            />
          }
          label="開機時自動啟動"
        />

        <Box>
          <label>應用關閉時動作: </label>
          <Select
            value={settings.onCloseBehavior}
            onChange={(e) => handleChange('onCloseBehavior', e.target.value as OnCloseBehavior)}
            size="small"
          >
            <MenuItem value="minimize">最小化至系統匣</MenuItem>
            <MenuItem value="exit">關閉應用</MenuItem>
          </Select>
        </Box>

        <FormControlLabel
          control={
            <Switch
              checked={settings.askBeforeExit}
              onChange={(_, checked) => handleChange('askBeforeExit', checked)}
            />
          }
          label="關閉應用前詢問"
        />
      </Box>

      <Divider sx={{ mt: '10px', mb: '20px' }} />

      <Box display={'flex'} flexDirection={'column'} width={'max-content'} gap={1}>
        <Typography variant="h5">更新</Typography>
        <UpdatePrompt />
        <FormControlLabel
          control={
            <Switch
              checked={settings.autoCheckUpdates}
              onChange={(_, checked) => handleChange('autoCheckUpdates', checked)}
            />
          }
          label="自動檢查更新"
        />
        <FormControlLabel
          control={
            <Switch
              checked={settings.autoInstallUpdates}
              onChange={(_, checked) => handleChange('autoInstallUpdates', checked)}
            />
          }
          label="自動安裝更新"
        />
      </Box>
    </Box>
  )
}

export default Settings
