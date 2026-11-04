/**
 * 關於 - what this is, who it answers to, and how to support it.
 *
 * The page used to open on a gold-tinted panel with a large gold 「歐付寶贊助」
 * button and 「喜歡這個工具嗎？」 above everything else, under a sidebar entry
 * called 贊助. On a page whose job is to establish trust, leading with a payment
 * button reads like a sales page - the opposite of what a free, local tool
 * should feel like. So the page now leads with what the tool is and where its
 * source lives, and support is one quiet card among the others, in the same
 * row layout the settings page uses: a plain sentence about what the money
 * pays for, an ordinary outlined button, and an equally prominent way to help
 * that costs nothing.
 */
import { Box, Button, Paper, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import React from 'react'

import { useUpdateStatus } from '@renderer/components/Update/updateContext'
import { PANEL_SX } from '@renderer/components/Common/surfaces'
import { PRIMARY_SUPPORT_LINK, supportUrl } from '@shared/support'

const REPOSITORY_URL = 'https://github.com/zrecordy1003/SVWB-Analyzer'
const CYGAMES_GUIDELINES_URL = 'https://shadowverse-wb.com/en/guideline/'

/** Same column as 設定, so the two text-heavy pages line up. */
const PAGE_WIDTH = 720

const open = (url: string): void => window.electronAPI.openLink(url)

// `HEAD` rather than a branch name: these once pointed at `main`, which this
// repository does not have. HEAD resolves to the default branch and survives a
// rename.
const repoFile = (path: string): string => `${REPOSITORY_URL}/blob/HEAD/${path}`

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    <Typography
      component="h2"
      sx={{ fontSize: 13, fontWeight: 600, color: 'text.secondary', px: 0.5, letterSpacing: 0.2 }}
    >
      {title}
    </Typography>
    <Paper
      elevation={0}
      sx={{
        ...PANEL_SX,
        borderRadius: '12px',
        overflow: 'hidden',
        // `&&` outranks the `all: unset` on a LinkRow's button, which would
        // otherwise wipe this separator off every link row.
        '&& > * + *': { borderTop: '1px solid rgba(255,255,255,0.06)' }
      }}
    >
      {children}
    </Paper>
  </Box>
)

const Row: React.FC<{
  title: string
  description?: React.ReactNode
  control?: React.ReactNode
}> = ({ title, description, control }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1.5, minHeight: 56 }}>
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography sx={{ fontSize: 14, fontWeight: 500, lineHeight: 1.4 }}>{title}</Typography>
      {description && (
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.55, mt: 0.25 }}>
          {description}
        </Typography>
      )}
    </Box>
    {control && <Box sx={{ flexShrink: 0 }}>{control}</Box>}
  </Box>
)

/** A whole row that opens a page in the browser; the arrow says it leaves the app. */
const LinkRow: React.FC<{ title: string; description: string; url: string }> = ({
  title,
  description,
  url
}) => (
  <Box
    component="button"
    type="button"
    onClick={() => open(url)}
    sx={{
      all: 'unset',
      boxSizing: 'border-box',
      width: '100%',
      cursor: 'pointer',
      display: 'block',
      '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' },
      '&:focus-visible': { boxShadow: 'inset 0 0 0 2px rgba(144,202,249,0.6)' }
    }}
  >
    <Row
      title={title}
      description={description}
      control={<OpenInNewIcon sx={{ fontSize: 16, color: 'text.secondary', display: 'block' }} />}
    />
  </Box>
)

const About = (): React.JSX.Element => {
  const { appVersion } = useUpdateStatus()

  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: PAGE_WIDTH,
        mx: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 3.5,
        pb: 2
      }}
    >
      {/* ---------- 這是什麼 ---------- */}
      <Box sx={{ px: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography component="h1" sx={{ fontSize: 20, fontWeight: 700 }}>
            SVWB Analyzer
          </Typography>
          {appVersion && (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>v{appVersion}</Typography>
          )}
        </Box>
        <Typography sx={{ fontSize: 14, color: 'text.secondary', mt: 0.75, lineHeight: 1.6 }}>
          Shadowverse: Worlds Beyond
          的對局紀錄工具。在你的電腦上讀取遊戲畫面，自動記下每一場對局，整理成戰績與對位勝率。
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
          <Button size="small" variant="outlined" onClick={() => open(REPOSITORY_URL)}>
            原始碼
          </Button>
          <Button size="small" variant="outlined" onClick={() => open(`${REPOSITORY_URL}/issues`)}>
            回報問題
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={() => open(`${REPOSITORY_URL}/releases`)}
          >
            更新紀錄
          </Button>
        </Box>
      </Box>

      {/* ---------- 支持開發 ---------- */}
      <Section title="支持開發">
        <Row
          title="這是個人維護的免費工具"
          description="所有功能都免費，以後也是。沒有付費功能，也不會有贊助者限定的內容。"
        />
        <Row
          title="贊助用在哪裡"
          description="維護與修正錯誤的時間，以及遊戲改版後重新製作辨識範本。"
        />
        <Row
          title="透過歐付寶贊助"
          description={`會在瀏覽器開啟歐付寶的付款頁面，金額由你決定。${PRIMARY_SUPPORT_LINK.note}。`}
          control={
            <Button
              size="small"
              variant="outlined"
              endIcon={<OpenInNewIcon sx={{ fontSize: 16 }} />}
              onClick={() => open(supportUrl(PRIMARY_SUPPORT_LINK, 'about'))}
            >
              前往贊助
            </Button>
          }
        />
        {/* 和贊助同樣顯眼：不花錢的幫忙對這個專案一樣有用，而一頁只給「付錢」
            一條路的支持說明，讀起來就是在要錢。 */}
        <Row
          title="不方便贊助也沒關係"
          description="回報辨識錯誤、提出建議，或在 GitHub 給個星星，對這個專案一樣是很大的幫助。"
          control={
            <Button size="small" onClick={() => open(REPOSITORY_URL)}>
              GitHub
            </Button>
          }
        />
      </Section>

      {/* ---------- 使用界線 ---------- */}
      <Section title="使用界線">
        <Row
          title="只看畫面，不碰遊戲"
          description="只分析本機擷取的遊戲畫面。不與遊戲互動、不自動操作，也不讀取遊戲記憶體。"
        />
        <Row
          title="資料存在你的電腦上"
          description="對局紀錄存在本機。「設定 → 數據統計」會上傳整天合併過、不含任何個人資訊的對局計數，可以隨時關閉。"
        />
      </Section>

      {/* ---------- 授權與權利 ---------- */}
      <Section title="授權與權利">
        <LinkRow
          title="授權條款"
          description="原創程式碼採 Apache License 2.0；不涵蓋 Cygames 素材、遊戲衍生範本與第三方套件。"
          url={repoFile('LICENSE')}
        />
        <LinkRow
          title="第三方聲明"
          description="使用的第三方套件與必要聲明。"
          url={repoFile('NOTICE')}
        />
        <LinkRow
          title="素材政策"
          description="遊戲素材的來源與使用範圍。"
          url={repoFile('ASSETS_POLICY.md')}
        />
        <LinkRow
          title="Cygames 內容使用指引"
          description="Shadowverse: Worlds Beyond 官方的二次創作與素材使用規範。"
          url={CYGAMES_GUIDELINES_URL}
        />
      </Section>

      <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.7, px: 0.5 }}>
        遊戲名稱、標誌、畫面、角色與卡片相關素材皆為 Cygames, Inc. 之智慧財產。© Cygames, Inc.
        本應用程式不是 Cygames 的產品，亦未獲 Cygames 合作、推薦、贊助或個別核准；Cygames
        對本應用程式的營運與內容不負任何責任。
      </Typography>
    </Box>
  )
}

export default About
