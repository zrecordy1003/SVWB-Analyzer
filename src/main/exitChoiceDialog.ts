/* eslint-disable @typescript-eslint/no-explicit-any */
import { BrowserWindow, ipcMain } from 'electron'
import path from 'path'

export type ExitChoice = 'minimize' | 'exit' | 'cancel'
export type ExitChoiceDialogOptions = {
  parent?: BrowserWindow
  appName?: string
  title?: string
  message?: string
  detail?: string
  rememberLabel?: string
  defaultAction?: ExitChoice // 預設 Enter 的行為（建議 'minimize'）
}

export async function openExitOrMinimizeDialog(
  opts: ExitChoiceDialogOptions
): Promise<{ action: ExitChoice; remember: boolean }> {
  const {
    parent,
    appName = 'SVWB Analyzer',
    title = '要關閉還是最小化到系統列？',
    message = `你想要最小化到系統列（背景執行）還是關閉 ${appName}？`,
    detail = '最小化到系統列後仍可於背景運行；關閉將結束所有背景作業。',
    rememberLabel = '記住我的選擇',
    defaultAction = 'minimize'
  } = opts

  return new Promise((resolve) => {
    let resolved = false
    const win = new BrowserWindow({
      width: 470,
      height: 180,
      parent,
      modal: true,
      show: false,
      frame: false,
      // transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      roundedCorners: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '../preload/exitChoice.mjs')
      }
    })

    const content = { appName, title, message, detail, rememberLabel, defaultAction }

    const onReady = (): void => {
      win.webContents.send('exit-choice:content', content)
    }
    const onChoose = (
      _e: Electron.IpcMainEvent,
      data: { action: ExitChoice; remember: boolean }
    ): void => {
      if (resolved) return
      resolved = true
      cleanup()
      if (!win.isDestroyed()) win.close()
      resolve(data)
    }

    function cleanup(): void {
      ipcMain.off('exit-choice:ready', onReady)
      ipcMain.off('exit-choice:choose', onChoose)
    }

    ipcMain.once('exit-choice:ready', onReady)
    ipcMain.once('exit-choice:choose', onChoose)

    win.once('ready-to-show', () => win.show())

    const html = getHtml()
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    win.loadURL(url)

    win.on('closed', () => {
      if (!resolved) {
        resolved = true
        cleanup()
        resolve({ action: 'cancel', remember: false })
      }
    })
  })
}

function getHtml(): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Choice</title>
<style>
  :root {
    --bg: rgba(25,25,28,0.55);
    --panel: rgba(30,30,36,0.65);
    --text-strong: #fff;
    --text: #d6d6db;
    --muted: #aeb0b7;
    --primary: #7aa2ff;
    --danger: #ff6b6b;
    --ring: rgba(122,162,255,0.35);
    --radius: 16px;
  }
  html,body { -webkit-app-region: drag;margin:0; padding:0; width:100%; height:100%; background: transparent;
              font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, 'Noto Sans TC', sans-serif;
              color: var(--text); }
  .wrap{
    position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
    background: var(--bg);
    -webkit-backdrop-filter: blur(20px) saturate(120%);
            backdrop-filter: blur(20px) saturate(120%);
    animation: fadeIn .18s ease-out;
  }
  .card{ width: 100%;height:100%; background: var(--panel); border:1px solid rgba(255,255,255,.08);
        box-shadow:0 14px 40px rgba(0,0,0,.48); overflow: clip;
         transform-origin: 50% 50%; animation: popIn .16s ease-out; }
  .head{ display:flex; gap:12px; align-items:center; padding:18px 18px 10px; }
  .icon{ width:28px; height:28px; border-radius:999px; background:linear-gradient(135deg,#7aa2ff,#9ad0ff);
         display:grid; place-items:center; color:#0f1730; font-weight:900; box-shadow:0 4px 12px rgba(122,162,255,.45); }
  h1{ margin:0; font-size:16px; color:var(--text-strong); letter-spacing:.2px; }
  .body{ padding:8px 18px 8px; color:var(--text); }
  .detail{ margin-top:4px; color:var(--muted); }

  /* ↓ 重點：更寬鬆、分成兩欄（記住選擇 | 按鈕群） */
  .foot{
    display: flex;
    align-items: center;
    gap: 12px 16px; /* row / column gaps */
    padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
    border-top: 1px solid rgba(255,255,255,.06);
    -webkit-app-region: no-drag;
  }
  .remember{
    display:flex; align-items:center; gap:10px; min-height:24px;
  }
  .btns{
    display:flex; align-items:center; gap:12px; flex-wrap:wrap;
  }

  .checkbox{ width:16px; height:16px; border-radius:6px;
             border:1px solid rgba(255,255,255,.22);
             background:rgba(255,255,255,.03);
             display:grid; place-items:center; cursor:pointer; transition:.12s; }
  .checkbox[data-checked="true"]{ border-color: rgba(122,162,255,.9); box-shadow:0 0 0 4px rgba(122,162,255,.25) inset; }

  .btn{ appearance:none; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.06);
        color:var(--text-strong); border-radius:12px; padding:10px 16px; cursor:pointer;
        transition: transform .06s ease, background .12s ease, border-color .12s ease; user-select:none;
        line-height:1; min-height:36px; }
  .btn:hover{ background:rgba(255,255,255,.10); border-color:rgba(255,255,255,.24); }
  .btn:active{ transform: translateY(1px); }
  .btn.primary{ background: linear-gradient(180deg, rgba(122,162,255,.32), rgba(122,162,255,.18));
                border-color: rgba(122,162,255,.45); }
  .btn.primary:hover{ background: linear-gradient(180deg, rgba(122,162,255,.40), rgba(122,162,255,.24)); }
  .btn.danger{ background: linear-gradient(180deg, rgba(255,107,107,.32), rgba(255,107,107,.18));
               border-color: rgba(255,107,107,.45); }
  .btn.danger:hover{ background: linear-gradient(180deg, rgba(255,107,107,.40), rgba(255,107,107,.24)); }
  .btn.ghost{ background: rgba(255,255,255,.04); }

  .kbd{ opacity:.85; margin-left:8px; font-size:12px; border:1px solid rgba(255,255,255,.2);
        padding:2px 6px; border-radius:6px; }


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
      <div class="remember">
        <div class="checkbox" id="cb" tabindex="0" role="checkbox" aria-checked="false"></div>
        <label id="lbl" for="cb" style="cursor:pointer"></label>
      </div>
      <div class="btns">
        <button class="btn ghost" id="cancel">取消</button>
        <button class="btn danger" id="exit">關閉應用</button>
        <button class="btn primary" id="min">最小化到系統列</button>
      </div>
    </div>
  </div>
</div>
<script>
  const api = window.ExitChoice
  const t = document.getElementById('t')
  const msg = document.getElementById('msg')
  const det = document.getElementById('detail')
  const cb = document.getElementById('cb')
  const lbl = document.getElementById('lbl')
  const btnMin = document.getElementById('min')
  const btnExit = document.getElementById('exit')
  const btnCancel = document.getElementById('cancel')

  let remember = false
  let defaultAction = 'minimize'

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

  api.ready()
  api.onContent((p)=>{
    t.textContent = p.title
    msg.textContent = p.message
    det.textContent = p.detail
    lbl.textContent = p.rememberLabel
    defaultAction = p.defaultAction || 'minimize'
  })

  btnMin.addEventListener('click', ()=> api.choose({ action: 'minimize', remember }))
  btnExit.addEventListener('click', ()=> api.choose({ action: 'exit', remember }))
  btnCancel.addEventListener('click', ()=> api.choose({ action: 'cancel', remember }))

  window.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape') api.choose({ action: 'cancel', remember })
    if(e.key.toLowerCase() === 'e') api.choose({ action: 'exit', remember })
    if(e.key === 'Enter'){
      const action = defaultAction === 'exit' ? 'exit' : 'minimize'
      api.choose({ action, remember })
    }
  })
</script>
</body>
</html>`
}
