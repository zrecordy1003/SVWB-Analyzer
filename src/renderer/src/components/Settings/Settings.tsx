import { Box, Switch, FormControlLabel, Select, MenuItem } from '@mui/material'
import React, { useEffect, useState } from 'react'

type OnCloseBehavior = 'minimize' | 'exit'
type ThemeType = 'system' | 'light' | 'dark'

interface AppSettings {
  enableNotifications: boolean
  onCloseBehavior: OnCloseBehavior
  askBeforeExit: boolean
  startOnBoot: boolean
  reduceAnimations: boolean
  autoCheckUpdates: boolean
  theme: ThemeType
}

// 預設設定
const DEFAULT_SETTINGS: AppSettings = {
  enableNotifications: true,
  onCloseBehavior: 'minimize',
  askBeforeExit: true,
  startOnBoot: false,
  reduceAnimations: false,
  autoCheckUpdates: true,
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
      <h2 style={{ marginTop: 0 }}>General</h2>
      <FormControlLabel
        control={
          <Switch
            checked={settings.reduceAnimations}
            onChange={(_, checked) => handleChange('reduceAnimations', checked)}
          />
        }
        label="Reduce Animations"
      />
      <Box mt={1}>
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
      </Box>

      <h2>Notifications</h2>
      <FormControlLabel
        control={
          <Switch
            checked={settings.enableNotifications}
            onChange={(_, checked) => handleChange('enableNotifications', checked)}
          />
        }
        label="Enable Notifications"
      />

      <h2>Startup & Exit</h2>
      <FormControlLabel
        control={
          <Switch
            checked={settings.startOnBoot}
            onChange={(_, checked) => handleChange('startOnBoot', checked)}
          />
        }
        label="Start at System Boot"
      />
      <Box mt={1}>
        <label>On Close: </label>
        <Select
          value={settings.onCloseBehavior}
          onChange={(e) => handleChange('onCloseBehavior', e.target.value as OnCloseBehavior)}
          size="small"
        >
          <MenuItem value="minimize">Minimize to Tray</MenuItem>
          <MenuItem value="exit">Exit App</MenuItem>
        </Select>
      </Box>
      <FormControlLabel
        control={
          <Switch
            checked={settings.askBeforeExit}
            onChange={(_, checked) => handleChange('askBeforeExit', checked)}
          />
        }
        label="Ask Before Exit"
      />

      <h2>Updates</h2>
      <FormControlLabel
        control={
          <Switch
            checked={settings.autoCheckUpdates}
            onChange={(_, checked) => handleChange('autoCheckUpdates', checked)}
          />
        }
        label="Auto Check for Updates"
      />
    </Box>
  )
}

export default Settings
