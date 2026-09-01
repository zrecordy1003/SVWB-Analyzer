import { Box, FormControlLabel, Divider, Typography, RadioGroup, Radio } from '@mui/material'
import React, { useEffect, useState } from 'react'
import Disclaimer from '../Disclaimer'
import UpdateSettings from '../Update/UpdateSettings'
import DiagnosticsSettings from '../Diagnostics/DiagnosticsSettings'
import IOSSwitch from '../Common/IOSSwitch'
import CardImageSettings from './CardImageSettings'

type OnCloseBehavior = 'minimize' | 'exit'
type ThemeType = 'system' | 'light' | 'dark'
type PortalLang = 'ja' | 'en' | 'cht' | 'chs' | 'ko'

interface AppSettingsInner {
  hudShow: boolean
  hudFollowGame: boolean
  enableNotifications: boolean
  onCloseBehavior: OnCloseBehavior
  askBeforeExit: boolean
  startOnBoot: boolean
  reduceAnimations: boolean
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
  autoInstallUpdates: boolean
  theme: ThemeType
  /** Opt-out: local-only recording of recognition anomalies. */
  diagnostics: boolean
  /** Default on; turning it off makes the whole card-art path a no-op. */
  cardImages: boolean
  cardLang: PortalLang
}

interface AppSettings {
  settings: AppSettingsInner
}

// 預設設定
const DEFAULT_SETTINGS: AppSettings = {
  settings: {
    hudShow: true,
    hudFollowGame: true,
    enableNotifications: true,
    onCloseBehavior: 'minimize',
    askBeforeExit: true,
    startOnBoot: false,
    reduceAnimations: false,
    autoCheckUpdates: false,
    autoDownloadUpdates: false,
    autoInstallUpdates: false,
    theme: 'system',
    diagnostics: true,
    cardImages: true,
    cardLang: 'cht'
  }
}

const Settings: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const s = settings.settings

  // 載入設定
  useEffect(() => {
    window.settings
      .get<AppSettingsInner>('settings')
      .then((saved) => {
        // saved 可能只有部分鍵（如你給的 JSON），要跟預設合併
        setSettings({
          settings: { ...DEFAULT_SETTINGS.settings, ...(saved ?? {}) }
        })
      })
      .catch((err) => {
        console.error('Failed to load settings:', err)
      })
  }, [])

  // 只要有更動就存檔（或是每個 Switch/Select 都呼叫 set）
  const handleChange = <K extends keyof AppSettingsInner>(
    key: K,
    value: AppSettingsInner[K]
  ): void => {
    setSettings((prev) => ({
      settings: { ...prev.settings, [key]: value }
    }))
    // 寫入 "settings.xxx"
    window.settings.set(`settings.${String(key)}`, value)
  }

  return (
    <Box>
      {/* <h2 style={{ marginTop: 0 }}>一般</h2> */}

      {/* <FormControlLabel
        control={
          <IOSSwitch
            checked={s.reduceAnimations}
            onChange={(_, checked) => handleChange('reduceAnimations', checked)}
          />
        }
        label="Reduce Animations"
      /> */}

      {/* <Box mt={1}>
        <label>Theme: </label>
        <Select
          value={s.theme}
          onChange={(e) => handleChange('theme', e.target.value as ThemeType)}
          size="small"
        >
          <MenuItem value="system">System</MenuItem>
          <MenuItem value="light">Light</MenuItem>
          <MenuItem value="dark">Dark</MenuItem>
        </Select>
      </Box> */}

      <Box display={'flex'} flexDirection={'column'} width={'max-content'} gap={1}>
        <Typography variant="h5">一般</Typography>
        <FormControlLabel
          control={
            <IOSSwitch
              checked={s.hudFollowGame}
              onChange={(_, checked) => handleChange('hudFollowGame', checked)}
            />
          }
          label="只在遊戲畫面聚焦時顯示 HUD"
        />
        <FormControlLabel
          control={
            <IOSSwitch
              checked={s.hudShow}
              disabled={s.hudFollowGame}
              onChange={(_, checked) => handleChange('hudShow', checked)}
            />
          }
          label="啟動時顯示 HUD"
        />
      </Box>

      <Divider sx={{ mt: '10px', mb: '20px' }} />

      <Box display={'flex'} flexDirection={'column'} gap={1}>
        <Typography variant="h5">辨識診斷</Typography>
        <FormControlLabel
          control={
            <IOSSwitch
              checked={s.diagnostics}
              onChange={(_, checked) => handleChange('diagnostics', checked)}
            />
          }
          label="記錄辨識異常（僅存本機）"
        />
        <DiagnosticsSettings enabled={s.diagnostics} />
      </Box>

      <Divider sx={{ mt: '10px', mb: '20px' }} />

      {/* There used to be a 「資料來源」 section here, reporting how many matches
          carried provenance and how many the user had edited. It was accurate
          and nobody wanted it: it explained an internal measurement rather than
          answering a question a player has. Recording still happens - see
          `main/data/provenance.ts` - it just has no settings surface. */}

      <CardImageSettings
        cardImages={s.cardImages}
        cardLang={s.cardLang}
        onChange={(key, value) => handleChange(key, value as never)}
      />

      <Divider sx={{ mt: '10px', mb: '20px' }} />

      <Box display={'flex'} flexDirection={'column'} width={'max-content'} gap={1}>
        <Typography variant="h5">通知</Typography>
        <FormControlLabel
          control={
            <IOSSwitch
              checked={s.enableNotifications}
              onChange={(_, checked) => handleChange('enableNotifications', checked)}
            />
          }
          label="開啟應用通知"
        />
      </Box>

      <Divider sx={{ mt: '10px', mb: '20px' }} />
      <Box display={'flex'} flexDirection={'column'} width={'max-content'} gap={1}>
        <Typography variant="h5">啟動與關閉</Typography>
        {/* <FormControlLabel
          control={
            <IOSSwitch
              checked={s.startOnBoot}
              onChange={(_, checked) => {
                handleChange('startOnBoot', checked)
                window.electron.ipcRenderer.send('s:startOnBoot', checked)
              }}
            />
          }
          label="開機時自動啟動"
        /> */}

        <Box display="flex" alignItems="center" gap={2} sx={{ minHeight: 40 }}>
          <FormControlLabel
            control={
              <IOSSwitch
                checked={s.askBeforeExit}
                onChange={(_, checked) => handleChange('askBeforeExit', checked)}
              />
            }
            label="關閉應用前詢問"
          />

          {/* 右側容器「保持掛載」，用 visibility 隱藏，避免高度變化 */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              visibility: s.askBeforeExit ? 'hidden' : 'visible'
            }}
          >
            {/* 用 FormControlLabel 做純 label，會和其他 label 高度一致 */}
            <FormControlLabel control={<></>} label="應用關閉時" sx={{ m: 0 }} />

            <RadioGroup
              row
              value={s.onCloseBehavior}
              onChange={(e) => handleChange('onCloseBehavior', e.target.value as OnCloseBehavior)}
              sx={{ m: 0 }}
            >
              <FormControlLabel
                value="minimize"
                control={<Radio size="small" />}
                label="最小化至系統匣"
                sx={{ m: 0 }}
              />
              <FormControlLabel
                value="exit"
                control={<Radio size="small" />}
                label="關閉應用"
                sx={{ m: 0 }}
              />
            </RadioGroup>
          </Box>
        </Box>
      </Box>

      <Divider sx={{ mt: '10px', mb: '20px' }} />

      <Box display={'flex'} flexDirection={'column'} width={'max-content'} gap={1}>
        <Typography variant="h5">更新</Typography>
        <UpdateSettings />
        <FormControlLabel
          control={
            <IOSSwitch
              checked={s.autoCheckUpdates}
              onChange={(_, checked) => handleChange('autoCheckUpdates', checked)}
            />
          }
          label="自動檢查更新"
        />
        <FormControlLabel
          disabled={!s.autoCheckUpdates}
          control={
            <IOSSwitch
              checked={s.autoDownloadUpdates}
              onChange={(_, checked) => handleChange('autoDownloadUpdates', checked)}
            />
          }
          label="自動下載更新"
        />
        {/* <FormControlLabel
          control={
            <IOSSwitch
              checked={s.autoInstallUpdates}
              onChange={(_, checked) => handleChange('autoInstallUpdates', checked)}
            />
          }
          label="自動安裝更新"
        /> */}
      </Box>
      <Box component={'footer'} sx={{ mt: 10 }}>
        <Disclaimer />
      </Box>
    </Box>
  )
}

export default Settings
