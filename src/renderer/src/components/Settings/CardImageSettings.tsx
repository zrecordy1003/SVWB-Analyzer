/**
 * The card art switch, its language, and what it is costing on disk.
 *
 * One switch covers both card art and the class emblems, because they raise the
 * same question and the answer must not be splittable - see
 * `protocol/cardImageProtocol.ts`. That is why the copy here names both.
 *
 * Presented with the attribution and the "your machine, your disk" wording
 * rather than as a bare toggle. Art is on by default, so this is where a user
 * finds out what that means and how to undo it - which matters more, not less,
 * now that nobody had to opt in. See docs/deck-import-plan.md, "合規要求".
 */
import {
  Box,
  Button,
  FormControlLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  Typography
} from '@mui/material'
import React from 'react'

import IOSSwitch from '../Common/IOSSwitch'

type PortalLang = 'ja' | 'en' | 'cht' | 'chs' | 'ko'

const LANGS: { id: PortalLang; label: string }[] = [
  { id: 'cht', label: '繁體中文' },
  { id: 'chs', label: '简体中文' },
  { id: 'ja', label: '日本語' },
  { id: 'en', label: 'English' },
  { id: 'ko', label: '한국어' }
]

const formatBytes = (bytes: number): string => {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb < 0.1 ? '< 0.1 MB' : `${mb.toFixed(1)} MB`
}

export default function CardImageSettings({
  cardImages,
  cardLang,
  onChange
}: {
  cardImages: boolean
  cardLang: PortalLang
  onChange: <K extends 'cardImages' | 'cardLang'>(
    key: K,
    value: K extends 'cardImages' ? boolean : PortalLang
  ) => void
}) {
  const [stats, setStats] = React.useState<{ files: number; bytes: number } | null>(null)
  const [clearing, setClearing] = React.useState(false)

  const refresh = React.useCallback(() => {
    void window.electron.ipcRenderer
      .invoke('cardImages:stats')
      .then((res) => setStats(res ?? null))
      .catch(() => setStats(null))
  }, [])

  React.useEffect(refresh, [refresh, cardImages, cardLang])

  const handleClear = async () => {
    setClearing(true)
    try {
      await window.electron.ipcRenderer.invoke('cardImages:clear')
      refresh()
    } finally {
      setClearing(false)
    }
  }

  return (
    <Box display="flex" flexDirection="column" gap={1}>
      <Typography variant="h5">卡片圖像</Typography>

      <FormControlLabel
        control={
          <IOSSwitch
            checked={cardImages}
            onChange={(_, checked) => onChange('cardImages', checked)}
          />
        }
        label="顯示官方卡圖與職業圖示"
      />

      <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 560, lineHeight: 1.7 }}>
        卡圖與職業圖示都是由
        <Box component="span" sx={{ fontWeight: 700 }}>
          你自己的電腦
        </Box>
        向官方伺服器取得並存在本機快取，本程式不散布任何官方素材，也不對圖做任何修改。卡圖 快取上限
        600 MB，超過會自動清掉最久沒看的——牌組建構器的卡池用的是全尺寸卡圖，一個 職業約 82
        MB；八個職業圖示合計不到 20 KB，不佔這個額度。關閉後牌組仍會顯示完整卡表
        （費用、卡名、張數），職業則回到純色色塊。
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 0.5 }}>
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            卡片語言
          </Typography>
          <Select
            size="small"
            value={cardLang}
            onChange={(event) => onChange('cardLang', event.target.value as PortalLang)}
            sx={{ minWidth: 140, mt: 0.5 }}
          >
            {LANGS.map((lang) => (
              <MenuItem key={lang.id} value={lang.id}>
                {lang.label}
              </MenuItem>
            ))}
          </Select>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            本機快取
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {stats ? `${stats.files} 張 ・ ${formatBytes(stats.bytes)}` : '—'}
            </Typography>
            <Button
              size="small"
              onClick={() => void handleClear()}
              disabled={clearing || !stats || stats.files === 0}
            >
              {clearing ? '清除中…' : '清除快取'}
            </Button>
          </Stack>
        </Box>
      </Stack>

      {/* Changing the language leaves the card NAMES already stored with each
          deck in the old one. Saying so is better than silently showing a mix,
          and better than a re-fetch this stage does not implement. */}
      <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 560, mt: 0.5 }}>
        切換語言只影響之後匯入的牌組與新抓的卡圖；已匯入牌組的卡名維持當時的語言。
      </Typography>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ maxWidth: 560, mt: 1, lineHeight: 1.7 }}
      >
        卡片圖像與文字著作權屬 © Cygames, Inc.。本應用程式與 Cygames
        並無合作、推薦、贊助或個別承認關係；Cygames 對本應用程式之營運與內容不負任何責任。
        《Shadowverse: Worlds Beyond》及其標誌均為 Cygames 的商標。{' '}
        <Link
          component="button"
          type="button"
          variant="caption"
          onClick={() => window.electronAPI.openLink('https://shadowverse-wb.com/cht/guideline/')}
        >
          內容規範
        </Link>
      </Typography>
    </Box>
  )
}
