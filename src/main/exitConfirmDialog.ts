import { BrowserWindow, ipcMain } from 'electron'
import path from 'path'

export type ExitConfirmOptions = {
  appName?: string
  title?: string
  message?: string
  detail?: string
  rememberLabel?: string
  parent?: BrowserWindow
}

export type ExitConfirmResult = { confirmed: boolean; remember: boolean }

export async function openExitConfirmDialog(opts: ExitConfirmOptions): Promise<ExitConfirmResult> {
  const {
    parent,
    appName = 'SVWB Aanlyzer',
    title = '確認關閉應用？',
    message = `你確定要關閉 ${appName} 嗎？`,
    detail = '目前有未儲存的變更或正在擷取。關閉後將停止擷取，未存資料可能遺失。',
    rememberLabel = '以後不要再詢問'
  } = opts

  return new Promise<ExitConfirmResult>((resolve) => {
    let resolved = false

    const win = new BrowserWindow({
      width: 480,
      height: 170,
      resizable: false,
      minimizable: false,
      maximizable: false,
      parent,
      modal: true,
      show: false,
      frame: false,
      movable: true,
      backgroundColor: '#00000000', // 必要
      alwaysOnTop: true,
      // hasShadow: true,
      roundedCorners: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '../preload/exitConfirm.mjs')
      }
    })

    win.removeMenu?.()
    win.once('ready-to-show', () => win.show())

    // 傳遞文字到視窗
    const payload = { appName, title, message, detail, rememberLabel }
    ipcMain.once('exit-confirm:ready', (e) => {
      e.sender.send('exit-confirm:content', payload)
    })

    // 接收選擇
    ipcMain.once('exit-confirm:choose', (_e, data: ExitConfirmResult) => {
      if (!resolved) {
        resolved = true
        resolve(data)
      }
      if (!win.isDestroyed()) win.close()
    })

    // 使用者用 Alt+F4/ESC 關閉視窗 → 視為取消
    win.on('closed', () => {
      if (!resolved) {
        resolved = true
        resolve({ confirmed: false, remember: false })
      }
    })

    // 載入 HTML（也可改成 file:// 指向打包後檔案）
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(getHtml())}`
    win.loadURL(url)
  })
}

function getHtml(): string {
  // 極簡 UI：毛玻璃 + 進出場動畫 + 鍵盤操作
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm</title>
<style>
  :root {
    --bg: rgba(25,25,28,0.55);
    --panel: rgba(30,30,36,0.65);
    --text-strong: #fff;
    --text: #d6d6db;
    --muted: #aeb0b7;
    --primary: #7aa2ff;
    --danger: #ff6b6b;
    --ok: #4caf50;
    --ring: rgba(122,162,255,0.35);
    --radius: 16px;
  }
  html,body {
    -webkit-app-region: drag;
    margin:0; padding:0; width:100%; height:100%;
    background: transparent;
    font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, 'Noto Sans TC', sans-serif;
    color: var(--text);
  }
  .wrap {
    position:fixed; inset:0;
    display:flex; align-items:center; justify-content:center;
    background: var(--bg);
    -webkit-backdrop-filter: blur(20px) saturate(120%);
            backdrop-filter: blur(20px) saturate(120%);
    animation: fadeIn .18s ease-out;
  }
  .card {
    padding: auto;
    width: 480px;
    height: 170px;
    background: var(--panel);
    border: 1px solid rgba(255,255,255,0.08);
    // border-radius: var(--radius);
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    overflow: clip;
    transform-origin: 50% 50%;
    animation: popIn .16s ease-out;
  }
  .head {
    display:flex; gap:12px; align-items:center;
    padding: 16px 18px 8px;
  }
  .icon {
    width: 28px; height: 28px; border-radius: 999px;
    background: linear-gradient(135deg, #7aa2ff, #9ad0ff);
    display:grid; place-items:center; color:#0f1730; font-weight:900;
    box-shadow: 0 4px 12px rgba(122,162,255,0.45);
  }
  h1 {
    margin:0; font-size: 16px; color: var(--text-strong);
    letter-spacing: .2px;
  }
  .body {
    padding: 6px 18px 6px;
    color: var(--text);
  }
  .detail {
    margin-top: 4px; color: var(--muted);
  }
  .foot {
    display:flex; align-items:center; justify-content:space-between;
    padding: 12px 14px 14px;
    gap: 8px;
  }
  .left { display:flex; align-items:center; gap:8px; }
  .checkbox {
    width: 16px; height: 16px; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.25);
    background: rgba(255,255,255,0.03);
    display:grid; place-items:center;
    cursor:pointer; transition:.12s;
  }
  .checkbox[data-checked="true"] {
    border-color: var(--primary); box-shadow: 0 0 0 4px var(--ring) inset;background-color:var(--ring);
  }
  .btns { display:flex;align-item:center; gap:10px; }
  .btn {
    appearance:none; border:1px solid rgba(255,255,255,0.16);
    background: rgba(255,255,255,0.06);
    color: var(--text-strong);
    border-radius: 10px; padding: 8px 14px; cursor:pointer;
    transition: transform .06s ease, background .12s ease, border-color .12s ease;
    user-select:none;
  }
  .btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.24); }
  .btn:active { transform: translateY(1px); }
  .btn.primary { background: linear-gradient(180deg, rgba(122,162,255,0.32), rgba(122,162,255,0.18));
                 border-color: rgba(122,162,255,0.45); }
  .btn.primary:hover { background: linear-gradient(180deg, rgba(122,162,255,0.40), rgba(122,162,255,0.24)); }
  .btn.danger { background: linear-gradient(180deg, rgba(255,107,107,0.32), rgba(255,107,107,0.18));
                border-color: rgba(255,107,107,0.45); }
  .btn.danger:hover { background: linear-gradient(180deg, rgba(255,107,107,0.40), rgba(255,107,107,0.24)); }
  .kbd { opacity:.8; margin-left:6px; font-size:12px; border:1px solid rgba(255,255,255,0.2);
         padding: 1px 6px; border-radius: 6px; }

  @keyframes popIn { from{ transform: scale(.98); opacity:.0 } to{ transform: scale(1); opacity:1 } }
  @keyframes fadeIn { from{ opacity:.0 } to{ opacity:1 } }
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="t">
    <div class="head">
      <div class="icon">i</div>
      <h1 id="t"></h1>
    </div>
    <div class="body">
      <div id="msg"></div>
      <div class="detail" id="detail"></div>
    </div>
    <div class="foot">
      <div class="left" style="-webkit-app-region: no-drag;">
        <div class="checkbox" id="cb" tabindex="0" role="checkbox" aria-checked="false"></div>
        <label id="lbl" for="cb" style="cursor:pointer;user-select:none;"></label>
      </div>
      <div class="btns" style="-webkit-app-region: no-drag;">
        <button class="btn" id="cancel">取消</button>
        <button class="btn danger" id="ok">關閉</button>
      </div>
    </div>
  </div>
</div>
<script>
  const api = window.ExitConfirm

  const t = document.getElementById('t')
  const msg = document.getElementById('msg')
  const det = document.getElementById('detail')
  const cb = document.getElementById('cb')
  const lbl = document.getElementById('lbl')
  const cancel = document.getElementById('cancel')
  const ok = document.getElementById('ok')

  let remember = false

  function setChecked(v){
    remember = !!v
    cb.dataset.checked = remember ? 'true' : 'false'
    cb.setAttribute('aria-checked', remember ? 'true' : 'false')
  }

  cb.addEventListener('click', ()=> setChecked(!remember))
  cb.addEventListener('keydown', (e)=> {
    if(e.key === ' ' || e.key === 'Enter'){ e.preventDefault(); setChecked(!remember) }
  })
  lbl.addEventListener('click', ()=> setChecked(!remember))

  cancel.addEventListener('click', ()=> api.choose({confirmed:false, remember}))
  ok.addEventListener('click', ()=> api.choose({confirmed:true, remember}))

  window.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape') api.choose({confirmed:false, remember})
    if(e.key === 'Enter') api.choose({confirmed:true, remember})
  })

  api.ready()
  api.onContent((payload)=>{
    t.textContent = payload.title
    msg.textContent = payload.message
    det.textContent = payload.detail
    lbl.textContent = payload.rememberLabel
  })
</script>
</body>
</html>`
}
