import Versions from './components/Versions'
import Role from './components/Role'
import Analyzer from './components/Analyzer'

// import electronLogo from './assets/electron.svg'

function App(): React.JSX.Element {
  // const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')

  return (
    <>
      <Analyzer></Analyzer>
      <Role></Role>
      {/* <img alt="logo" className="logo" src={electronLogo} />
      <div className="creator">Powered by electron-vite</div>
      <div className="text">
        Build an Electron app with <span className="react">React</span>
        &nbsp;and <span className="ts">TypeScript</span>
      </div>
      <p className="tip">
        Please try pressing <code>F12</code> to open the devTool
      </p>
      <div className="actions">
        <div className="action">
          <a href="https://electron-vite.org/" target="_blank" rel="noreferrer">
            Documentation
          </a>
        </div>
        <div className="action">
          <a target="_blank" rel="noreferrer" onClick={ipcHandle}>
            Send IPC
          </a>
        </div>
      </div> */}
      <Versions></Versions>
      <p>
        「本網站／應用程式與 Cygames 並無合作、推薦、贊助或個別承認關係。Cygames
        對本網站／應用程式之營運與內容不負任何責任。對 Cygames 商標及其他智慧財產之使用，必須遵守
        Cygames 粉絲素材的服務協議。關於 Cygames
        的詳細資訊請見該公司網站（https://www.cygames.co.jp/）。」
      </p>
    </>
  )
}

export default App
