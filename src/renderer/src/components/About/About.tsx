import { Alert, Box, Divider, Link, Paper, Stack, Typography } from '@mui/material'

const REPOSITORY_URL = 'https://github.com/zrecordy1003/SVWB-Analyzer'
const CYGames_GUIDELINES_URL = 'https://shadowverse-wb.com/en/guideline/'

const About = (): React.JSX.Element => (
  <Stack spacing={3} sx={{ maxWidth: 820 }}>
    <Box>
      <Typography variant="h4" component="h1" gutterBottom>
        SVWB Analyzer
      </Typography>
      <Typography color="text.secondary">
        本機擷取 Shadowverse: Worlds Beyond 對局畫面並整理個人對戰紀錄的社群工具。
      </Typography>
    </Box>

    <Alert severity="info">
      本應用程式不是 Cygames 的產品，亦未獲 Cygames 合作、推薦、贊助或個別核准。Cygames
      對本應用程式的營運與內容不負任何責任。
    </Alert>

    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>
        智慧財產與素材
      </Typography>
      <Stack spacing={1.5}>
        <Typography>
          Shadowverse: Worlds Beyond 及其名稱、標誌、遊戲畫面、角色、卡片與其他相關素材為 Cygames,
          Inc. 的智慧財產。© Cygames, Inc.
        </Typography>
        <Typography>
          本工具僅分析使用者在本機遊戲畫面中擷取的資料，不與遊戲互動、自動操作遊戲或讀取遊戲記憶體。
        </Typography>
        <Link href={CYGames_GUIDELINES_URL} target="_blank" rel="noreferrer">
          Cygames Content Guidelines
        </Link>
      </Stack>
    </Paper>

    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>
        開源授權
      </Typography>
      <Typography paragraph>
        本專案原創程式碼以 Apache License 2.0 授權；授權不涵蓋 Cygames
        素材、遊戲衍生範本或第三方套件。
      </Typography>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        divider={<Divider flexItem orientation="vertical" />}
      >
        <Link href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
          Apache-2.0 License
        </Link>
        <Link href={`${REPOSITORY_URL}/blob/main/NOTICE`} target="_blank" rel="noreferrer">
          Notices
        </Link>
        <Link
          href={`${REPOSITORY_URL}/blob/main/ASSETS_POLICY.md`}
          target="_blank"
          rel="noreferrer"
        >
          Assets Policy
        </Link>
      </Stack>
    </Paper>

    <Typography variant="body2" color="text.secondary">
      原始碼、貢獻方式與安全性回報說明請見{' '}
      <Link href={REPOSITORY_URL} target="_blank" rel="noreferrer">
        GitHub repository
      </Link>
      。
    </Typography>
  </Stack>
)

export default About
