import { Box, FormControlLabel, Divider, Typography, RadioGroup, Radio } from '@mui/material'
import React, { useEffect, useState } from 'react'
import Disclaimer from '../Disclaimer'
import UpdateSettings from '../Update/UpdateSettings'
import DiagnosticsSettings from '../Diagnostics/DiagnosticsSettings'
import TelemetrySettings from './TelemetrySettings'
import IOSSwitch from '../Common/IOSSwitch'
import type { AppSettings as SharedAppSettings, ClosePref } from '@shared/settings'

/**
 * `ClosePref` from `@shared/settings`, not a fourth spelling of it.
 *
 * This file had three local aliases restating shared types - this one,
 * `PortalLang`, and a `ThemeType` that only appeared in commented-out
 * controls. They were all invisible duplicates of declarations that already
 * existed, which is the same thing the IPC contract was cleaning up one level
 * down.
 */
type OnCloseBehavior = ClosePref

/**
 * The shared shape, not a local copy.
 *
 * There was an `interface AppSettingsInner` here, and comparing it against
 * `AppSettings` in `@shared/settings` is what turned up two things: it was
 * missing `telemetry` (harmless, because `handleChange` writes one key at a
 * time and never the whole object - had it written the object, it would have
 * cleared the flag that gates uploading), and it declared four keys the schema
 * did not have. Two of those - `startOnBoot`, `autoInstallUpdates` - are
 * written by live switches and are in the schema now. The other two,
 * `reduceAnimations` and `theme`, appear only in commented-out controls and
 * are gone.
 */
type AppSettingsInner = SharedAppSettings

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
    autoCheckUpdates: false,
    autoDownloadUpdates: false,
    autoInstallUpdates: false,
    // `reduceAnimations` and `theme` were here too, and only ever reached
    // commented-out controls - so they defaulted, persisted nothing and did
    // nothing. Gone with the local type they were declared in.
    diagnostics: true,
    telemetry: true,
    cardImages: true,
    cardLang: 'cht'
  }
}

const Settings: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const s = settings.settings
  // 存的值和 DEFAULT_SETTINGS 不一定一樣，讀檔前先用預設值畫面、讀完再整個換過
  // 去會讓開關從預設值滑到實際值，看起來像是使用者一進頁面它自己動了一下。
  // 這幾顆開關（自動檢查/下載更新）在還沒讀到實際值以前先不掛載，等讀到了
  // 就直接以正確的 checked 狀態掛上去，不會有滑動動畫。
  const [loaded, setLoaded] = useState(false)

  // 載入設定
  useEffect(() => {
    window.settings
      .get('settings')
      .then((saved) => {
        // saved 可能只有部分鍵（如你給的 JSON），要跟預設合併
        setSettings({
          settings: { ...DEFAULT_SETTINGS.settings, ...(saved ?? {}) }
        })
      })
      .catch((err) => {
        console.error('Failed to load settings:', err)
      })
      .finally(() => setLoaded(true))
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

      {/* The switch lives inside TelemetrySettings and goes through
          `window.telemetry.setEnabled`, not `handleChange`: main owns the upload
          timers and has to hear about the change, and the generic settings
          bridge tells it nothing. */}
      <Box display={'flex'} flexDirection={'column'} gap={1}>
        <Typography variant="h5">數據統計</Typography>
        <TelemetrySettings />
      </Box>

      {/* There used to be a 「資料來源」 section here, reporting how many matches
          carried provenance and how many the user had edited. It was accurate
          and nobody wanted it: it explained an internal measurement rather than
          answering a question a player has. Recording still happens - see
          `main/data/provenance.ts` - it just has no settings surface.

          The 「卡片語言」 section that followed it is gone the same way: the
          language selector and cache-clear button now have no settings
          surface. `cardLang` still exists in AppSettingsInner and still
          defaults to 'cht' - it simply has no UI any more. */}

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
                // Was `'s:startOnBoot'`, which main never listened on. Use
                // `sendIpc` from `@renderer/ipc` when re-enabling this, so the
                // name is checked; see the handler in main/ipc/settings.ts.
                window.electron.ipcRenderer.send('settings:startOnBoot', checked)
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
        {loaded && (
          <>
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
          </>
        )}
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

      <Divider sx={{ mt: '10px', mb: '20px' }} />

      <Box display={'flex'} flexDirection={'column'} gap={1}>
        <Typography variant="h5">辨識診斷</Typography>
        <DiagnosticsSettings
          enabled={s.diagnostics}
          onToggle={(checked) => handleChange('diagnostics', checked)}
        />
      </Box>

      <Box component={'footer'} sx={{ mt: 10 }}>
        <Disclaimer />
      </Box>
    </Box>
  )
}

export default Settings
