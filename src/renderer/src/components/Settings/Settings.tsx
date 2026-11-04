import { Box, FormControlLabel, RadioGroup, Radio } from '@mui/material'
import React, { useEffect, useState } from 'react'
import Disclaimer from '../Disclaimer'
import UpdateSettings from '../Update/UpdateSettings'
import DiagnosticsSettings from '../Diagnostics/DiagnosticsSettings'
import TelemetrySettings from './TelemetrySettings'
import SyncSettings from './SyncSettings'
import ClearDataSettings from './ClearDataSettings'
import BackupSettings from './BackupSettings'
import { PAGE_COLUMN_WIDTH, SectionRow, Section, SwitchRow } from '../Common/SectionLayout'
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
  // Bumped when a section may have made a backup or rewritten local data, so the
  // others (sync status, the backup list) look again.
  const [dataVersion, setDataVersion] = useState(0)
  const bumpData = (): void => setDataVersion((v) => v + 1)

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

  // 每一顆開關都等讀到實際值才畫，不只更新那兩顆：一般區的開關原本也是先用預設值
  // 畫、讀完再滑到實際值。讀檔是一次本機 IPC，空一幀不會被看到。
  if (!loaded) return null

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: PAGE_COLUMN_WIDTH,
        mx: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 3.5,
        pb: 2
      }}
    >
      {/* `reduceAnimations` / `theme` controls and 開機時自動啟動 used to sit here
          commented out; see git history. 開機時自動啟動 needs `sendIpc` with
          'settings:startOnBoot' when it comes back (main/ipc/settings.ts). */}

      <Section title="一般">
        <SwitchRow
          title="只在遊戲畫面聚焦時顯示 HUD"
          checked={s.hudFollowGame}
          onChange={(checked) => handleChange('hudFollowGame', checked)}
        />
        <SwitchRow
          title="啟動時顯示 HUD"
          description={s.hudFollowGame ? '跟隨遊戲畫面時不適用' : undefined}
          checked={s.hudShow}
          disabled={s.hudFollowGame}
          onChange={(checked) => handleChange('hudShow', checked)}
        />
        <SwitchRow
          title="開啟應用通知"
          checked={s.enableNotifications}
          onChange={(checked) => handleChange('enableNotifications', checked)}
        />
        <SwitchRow
          title="關閉應用前詢問"
          checked={s.askBeforeExit}
          onChange={(checked) => handleChange('askBeforeExit', checked)}
        />
        {!s.askBeforeExit && (
          <SectionRow
            title="關閉視窗時"
            control={
              <RadioGroup
                row
                value={s.onCloseBehavior}
                onChange={(e) => handleChange('onCloseBehavior', e.target.value as OnCloseBehavior)}
                sx={{ gap: 1.5, '& .MuiFormControlLabel-label': { fontSize: 13.5 } }}
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
            }
          />
        )}
      </Section>

      {/* The switch lives inside TelemetrySettings and goes through
          `window.telemetry.setEnabled`, not `handleChange`: main owns the upload
          timers and has to hear about the change, and the generic settings
          bridge tells it nothing. */}
      <Section title="數據統計">
        <TelemetrySettings />
      </Section>

      {/* Brings its own section, and renders nothing in a build without a
          Google client. */}
      <SyncSettings dataVersion={dataVersion} onDataChanged={bumpData} />

      {/* 「資料來源」 and 「卡片語言」 sections were removed on purpose: see
          `main/data/provenance.ts`; `cardLang` still defaults to 'cht'. */}

      <Section title="更新">
        <UpdateSettings />
        {/* Not mounted until the saved values are in, so the switches appear
            in their real state instead of sliding there from the defaults. */}
        {loaded && (
          <SwitchRow
            title="自動檢查更新"
            checked={s.autoCheckUpdates}
            onChange={(checked) => handleChange('autoCheckUpdates', checked)}
          />
        )}
        {loaded && (
          <SwitchRow
            title="自動下載更新"
            checked={s.autoDownloadUpdates}
            disabled={!s.autoCheckUpdates}
            onChange={(checked) => handleChange('autoDownloadUpdates', checked)}
          />
        )}
      </Section>

      <Section title="辨識診斷">
        <DiagnosticsSettings
          enabled={s.diagnostics}
          onToggle={(checked) => handleChange('diagnostics', checked)}
        />
      </Section>

      {/* Last on the page: the one section here that removes the user's records,
          kept apart from 辨識診斷's log-clearing button. */}
      <Section title="資料管理">
        <ClearDataSettings onCleared={bumpData} />
        <BackupSettings dataVersion={dataVersion} onDataChanged={bumpData} />
      </Section>

      <Box component={'footer'} sx={{ mt: 4, px: 0.5 }}>
        <Disclaimer />
      </Box>
    </Box>
  )
}

export default Settings
