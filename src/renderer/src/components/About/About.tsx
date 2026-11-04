/**
 * 關於 - what this is, who it answers to, and how to support it.
 *
 * The page used to open on a gold-tinted panel with a large gold 「歐付寶贊助」
 * button and 「喜歡這個工具嗎？」 above everything else, under a sidebar entry
 * called 贊助. On a page whose job is to establish trust, leading with a payment
 * button reads like a sales page - the opposite of what a free, local tool
 * should feel like. So the page now leads with what the tool is and where its
 * source lives. Support is one card: a sentence of context, two equal ways to
 * help (paying, and reporting problems), and three checkable commitments - the
 * features stay free, the payment never passes through this app, and what the
 * money is for.
 *
 * Built only from shared pieces - `SectionLayout`'s sections and rows and
 * `SoftButton` - so it reads as the same app as 設定, not as a page of its own.
 */
import { Box, Typography } from '@mui/material'
import CodeRoundedIcon from '@mui/icons-material/CodeRounded'
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import LocalCafeOutlinedIcon from '@mui/icons-material/LocalCafeOutlined'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded'
import React from 'react'

import SoftButton from '@renderer/components/Common/SoftButton'
import {
  LinkRow,
  PAGE_COLUMN_WIDTH,
  Section,
  SectionRow
} from '@renderer/components/Common/SectionLayout'
import { useUpdateStatus } from '@renderer/components/Update/updateContext'
import { PRIMARY_SUPPORT_LINK, supportUrl } from '@shared/support'

const REPOSITORY_URL = 'https://github.com/zrecordy1003/SVWB-Analyzer'
const ISSUES_URL = `${REPOSITORY_URL}/issues`
const CYGAMES_GUIDELINES_URL = 'https://shadowverse-wb.com/en/guideline/'

const open = (url: string): void => window.electronAPI.openLink(url)

// `HEAD` rather than a branch name: these once pointed at `main`, which this
// repository does not have. HEAD resolves to the default branch and survives a
// rename.
const repoFile = (path: string): string => `${REPOSITORY_URL}/blob/HEAD/${path}`

/** One of the two ways to help, as equals. */
const SupportTile: React.FC<{
  icon: React.ReactNode
  title: string
  description: string
  actions: React.ReactNode
}> = ({ icon, title, description, actions }) => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
      p: 2,
      borderRadius: '10px',
      border: '1px solid rgba(255,255,255,0.08)',
      bgcolor: 'rgba(255,255,255,0.025)'
    }}
  >
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}>
      {icon}
      <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'text.primary' }}>{title}</Typography>
    </Box>
    <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.6, flex: 1 }}>
      {description}
    </Typography>
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 0.5 }}>{actions}</Box>
  </Box>
)

const About = (): React.JSX.Element => {
  const { appVersion } = useUpdateStatus()

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
          <SoftButton startIcon={<CodeRoundedIcon />} onClick={() => open(REPOSITORY_URL)}>
            原始碼
          </SoftButton>
          <SoftButton startIcon={<BugReportOutlinedIcon />} onClick={() => open(ISSUES_URL)}>
            回報問題
          </SoftButton>
          <SoftButton
            startIcon={<HistoryRoundedIcon />}
            onClick={() => open(`${REPOSITORY_URL}/releases`)}
          >
            更新紀錄
          </SoftButton>
        </Box>
      </Box>

      {/* ---------- 支持開發 ---------- */}
      {/* 兩條路並排、一樣大：付錢和回報問題對這個專案一樣有用，而只給「付錢」
          一條路的支持說明，讀起來就是在要錢。底下三條是承諾，不是行銷。 */}
      <Section title="支持開發">
        <Box sx={{ p: 2.5 }}>
          <Typography sx={{ fontSize: 14, lineHeight: 1.7 }}>
            SVWB Analyzer
            由個人開發與維護。你的支持會用在日常維護、修正錯誤，以及遊戲改版後更新辨識範本。如果覺得好用，可以用下面任一種方式支持。
          </Typography>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 1.5,
              mt: 2
            }}
          >
            <SupportTile
              icon={<LocalCafeOutlinedIcon fontSize="small" />}
              title="贊助開發"
              description={`透過歐付寶，金額由你決定。${PRIMARY_SUPPORT_LINK.note}。`}
              actions={
                // `primary` but `soft`: the one accent on the page, still the
                // same quiet button as everywhere else. `solid` is kept for the
                // button that commits a dialog.
                <SoftButton
                  tone="primary"
                  startIcon={<OpenInNewIcon />}
                  onClick={() => open(supportUrl(PRIMARY_SUPPORT_LINK, 'about'))}
                >
                  前往歐付寶
                </SoftButton>
              }
            />
            <SupportTile
              icon={<BugReportOutlinedIcon fontSize="small" />}
              title="回報與建議"
              description="回報辨識錯誤、提出功能建議，或在 GitHub 按下 Star，都有幫助。"
              actions={
                <>
                  <SoftButton
                    startIcon={<BugReportOutlinedIcon />}
                    onClick={() => open(ISSUES_URL)}
                  >
                    回報問題
                  </SoftButton>
                  <SoftButton
                    startIcon={<StarBorderRoundedIcon />}
                    onClick={() => open(REPOSITORY_URL)}
                  >
                    GitHub
                  </SoftButton>
                </>
              }
            />
          </Box>
        </Box>
      </Section>

      {/* ---------- 使用界線 ---------- */}
      <Section title="使用界線">
        <SectionRow
          title="只看畫面，不碰遊戲"
          description="只分析本機擷取的遊戲畫面。不與遊戲互動、不自動操作，也不讀取遊戲記憶體。"
        />
        <SectionRow
          title="資料存在你的電腦上"
          description="對局資料存在本機。「設定 → 數據統計」會上傳以天合計、不含個人資訊的對局次數，可隨時關閉。"
        />
      </Section>

      {/* ---------- 授權與權利 ---------- */}
      <Section title="授權與權利">
        <LinkRow
          title="授權條款"
          description="原創程式碼採 Apache License 2.0；不涵蓋 Cygames 素材、遊戲衍生範本與第三方套件。"
          onOpen={() => open(repoFile('LICENSE'))}
        />
        <LinkRow
          title="第三方聲明"
          description="使用的第三方套件與必要聲明。"
          onOpen={() => open(repoFile('NOTICE'))}
        />
        <LinkRow
          title="素材政策"
          description="遊戲素材的來源與使用範圍。"
          onOpen={() => open(repoFile('ASSETS_POLICY.md'))}
        />
        <LinkRow
          title="Cygames 內容使用指引"
          description="Shadowverse: Worlds Beyond 官方的二次創作與素材使用規範。"
          onOpen={() => open(CYGAMES_GUIDELINES_URL)}
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
