import { Alert, Box, Button, Divider, Link, Paper, Stack, Typography } from '@mui/material'
import VolunteerActivismOutlinedIcon from '@mui/icons-material/VolunteerActivismOutlined'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined'
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined'
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined'

import { PRIMARY_SUPPORT_LINK, supportUrl } from '@shared/support'

const REPOSITORY_URL = 'https://github.com/zrecordy1003/SVWB-Analyzer'
const CYGames_GUIDELINES_URL = 'https://shadowverse-wb.com/en/guideline/'

const resourceLinks = [
  ['Apache-2.0 License', '原創程式碼的授權條款', 'LICENSE'],
  ['Notices', '第三方套件與必要聲明', 'NOTICE'],
  ['Assets Policy', '素材來源與使用範圍', 'ASSETS_POLICY.md']
] as const

const About = (): React.JSX.Element => (
  <Stack spacing={2.5} sx={{ maxWidth: 920, mx: 'auto', pb: 4 }}>
    <Box>
      <Typography variant="h4" component="h1" fontWeight={700}>
        關於 SVWB Analyzer
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 0.75, maxWidth: 640 }}>
        在本機整理 Shadowverse: Worlds Beyond 的對局畫面與個人戰績，讓每次練習都有可回顧的紀錄。
      </Typography>
    </Box>

    <Paper
      variant="outlined"
      sx={{
        p: { xs: 2.25, sm: 3 },
        borderRadius: 2,
        borderColor: 'rgba(246, 184, 67, 0.34)',
        bgcolor: 'rgba(246, 184, 67, 0.07)'
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2.5}
        alignItems={{ sm: 'center' }}
        justifyContent="space-between"
      >
        <Box sx={{ maxWidth: 540 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <VolunteerActivismOutlinedIcon sx={{ color: '#f6b843' }} />
            <Typography fontWeight={700}>喜歡這個工具嗎？</Typography>
          </Stack>
          <Typography variant="body2" sx={{ mt: 1 }}>
            你的贊助會用於持續維護、錯誤修正，以及遊戲改版後的辨識範本更新。
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
            完全自願，所有功能永遠免費且不會有贊助者限定內容。
          </Typography>
        </Box>
        <Box sx={{ flexShrink: 0 }}>
          <Button
            variant="contained"
            size="large"
            startIcon={<VolunteerActivismOutlinedIcon />}
            endIcon={<OpenInNewIcon />}
            onClick={() => window.electronAPI.openLink(supportUrl(PRIMARY_SUPPORT_LINK, 'about'))}
            sx={{
              px: 2.5,
              py: 1.1,
              bgcolor: '#e0a019',
              color: '#251a05',
              fontWeight: 800,
              boxShadow: 'none',
              '&:hover': { bgcolor: '#f6b843', boxShadow: '0 6px 18px rgba(246, 184, 67, 0.22)' }
            }}
          >
            歐付寶贊助
          </Button>
          <Typography
            variant="caption"
            color="text.secondary"
            align="center"
            display="block"
            sx={{ mt: 0.75 }}
          >
            信用卡、ATM、超商代碼
          </Typography>
        </Box>
      </Stack>
    </Paper>

    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2.5 }}>
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.25 }}>
          <ShieldOutlinedIcon color="primary" fontSize="small" />
          <Typography variant="h6" fontWeight={700}>
            使用界線
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          本工具只分析本機擷取的遊戲畫面，不會與遊戲互動、自動操作或讀取遊戲記憶體。
        </Typography>
      </Box>
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.25 }}>
          <GavelOutlinedIcon color="primary" fontSize="small" />
          <Typography variant="h6" fontWeight={700}>
            素材與權利
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          遊戲名稱、標誌、畫面、角色與卡片相關素材皆為 Cygames, Inc. 智慧財產。© Cygames, Inc.
        </Typography>
        <Link
          href={CYGames_GUIDELINES_URL}
          target="_blank"
          rel="noreferrer"
          underline="hover"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mt: 1, fontSize: 14 }}
        >
          查看 Cygames Content Guidelines <OpenInNewIcon sx={{ fontSize: 15 }} />
        </Link>
      </Box>
    </Box>

    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
      <Box sx={{ px: 2.5, py: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <CodeOutlinedIcon color="primary" fontSize="small" />
          <Typography variant="h6" fontWeight={700}>
            開源與授權
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          原創程式碼採 Apache License 2.0。該授權不涵蓋 Cygames 素材、遊戲衍生範本與第三方套件。
        </Typography>
      </Box>
      <Divider />
      {resourceLinks.map(([title, description, path]) => (
        <Link
          key={path}
          // `HEAD` rather than a branch name: these pointed at `main`, which
          // this repository does not have, so all three were 404s. HEAD
          // resolves to whatever the default branch is and survives a rename.
          href={`${REPOSITORY_URL}/blob/HEAD/${path}`}
          target="_blank"
          rel="noreferrer"
          underline="none"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            px: 2.5,
            py: 1.6,
            color: 'text.primary',
            '&:not(:last-child)': { borderBottom: (theme) => `1px solid ${theme.palette.divider}` },
            '&:hover': { bgcolor: 'action.hover' }
          }}
        >
          <Box>
            <Typography fontWeight={700}>{title}</Typography>
            <Typography variant="caption" color="text.secondary">
              {description}
            </Typography>
          </Box>
          <OpenInNewIcon color="action" sx={{ fontSize: 18 }} />
        </Link>
      ))}
    </Paper>

    <Typography variant="body2" color="text.secondary">
      原始碼、貢獻方式與安全性回報都在{' '}
      <Link href={REPOSITORY_URL} target="_blank" rel="noreferrer">
        GitHub repository
      </Link>
      。
    </Typography>

    <Alert severity="info" icon={<ShieldOutlinedIcon />} sx={{ borderRadius: 1.5 }}>
      本應用程式不是 Cygames 的產品，亦未獲 Cygames 合作、推薦、贊助或個別核准。Cygames
      對本應用程式的營運與內容不負任何責任。
    </Alert>
  </Stack>
)

export default About
