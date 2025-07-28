import { Box } from '@mui/material'

const Disclaimer = (): React.JSX.Element => {
  const handleExternalLink = (e: React.MouseEvent, url: string): void => {
    e.preventDefault()
    window.electronAPI.openLink(url)
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', fontSize: '0.9rem', color: 'gray' }}>
      <span>本網站／應用程式與 Cygames 並無合作、推薦、贊助或個別承認關係。</span>
      <span>Cygames 對本網站／應用程式之營運與內容不負任何責任。</span>
      <span>對 Cygames 商標及其他智慧財產之使用，必須遵守 Cygames 粉絲素材的服務協議。</span>
      <span>
        關於 Cygames 的詳細資訊請見該公司網站（
        <a
          style={{ color: 'lightblue' }}
          href="https://www.cygames.co.jp/"
          onClick={(e) => handleExternalLink(e, 'https://www.cygames.co.jp/')}
        >
          https://www.cygames.co.jp/
        </a>
        ）。
      </span>
    </Box>
  )
}

export default Disclaimer
