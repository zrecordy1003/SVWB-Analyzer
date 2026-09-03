# Windows 發行流程

## 發行前檢查

在 Windows x64 機器上執行：

```powershell
git pull
git lfs pull
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run engine:build
pnpm run vision:verify
pnpm run build:win
```

`vision:verify` 是辨識回歸真正被攔下來的地方：cargo 測試（狀態機情境 + fixture 斷言）、clippy、OCR oracle，以及引擎與 addon 的 parity 比對。它需要 `pnpm run vision:build` 產出的 `svwb-vision.node`；`build:win` 會順帶建它。

`build:win` 會依序編譯截圖器、vision addon、`svwb-engine`，產生 Electron bundle，最後用 electron-builder 建立 NSIS 安裝程式。

> **本機通過不等於乾淨環境會通過。** 開發機通常已經有建好的引擎、解壓過的 `eng.traineddata`，以及本地時區——這三項都曾讓本機全綠的 commit 在 CI 上失敗。要看真正的驗證結果，看 `for_dev` 的 CI 是否為綠。

## 打包內容

`package.json` 的 `build.files` 只列 `out/**`，node_modules 由 electron-builder 依 `dependencies` 自行收集。所以**只有 main／preload 真正在執行期 require 的套件才可以放在 `dependencies`**——renderer 的相依（MUI、date-fns、chart.js⋯）已經被 vite bundle 進 `out/renderer`，再列進 `dependencies` 等於把同一份程式碼多打包一次未壓縮的原始碼。這個錯誤曾讓 app.asar 長到 138MB，其中屬於本專案的只有 1.6MB。

`files` 的排除規則有個會無聲爆炸的地雷：**一個只含 `!` 的陣列會被 electron-builder 判定為 `containsOnlyIgnore`，於是自動補回 `**/_`**。結果是整個專案目錄（含 `tests/`的錄影與`tools/target/` 的 Rust 產物）被打包進 asar——實測 32MB 變成 2.4GB，而且建置不會報任何錯。`build.win.files`的第一行`out/**`就是為了讓那個判定不成立，不是多餘的。改完打包設定要看`dist/builder-debug.yml`的`firstOrDefaultFilePatterns`開頭是不是`**/_`：是的話就踩到了。

被排除的檔案是查過載入路徑才拿掉的：better-sqlite3 的 `lib/binding.js` 在 win32-x64 上只 require `prebuilds/win32-x64.node`，其餘 prebuild 與 `deps/`（9.5MB 的 sqlite3.c）只在自行編譯時才需要；tesseract.js 的 `getCore` 走 `require('tesseract.js-core/tesseract-core-simd')`，而該套件沒有 `exports` 欄位，Node 一律解析到 `.js` 而非同名的 `.wasm.js`（那四個是瀏覽器用的單檔版）。升級這兩個套件時要重新確認一次。

## 版本號

**發版前一定要更新 `package.json` 的 `version`。** electron-builder 以版本號決定 GitHub release 的 tag；若沿用一個已發佈過的版本號，它會把**既有 release 的安裝檔換掉**，而使用者的 electron-updater 因為版本相同不會提示更新——結果是 release 頁面的檔案被無聲替換。

語意化版本以「使用者感受到什麼」為準：辨識管線更換屬於 minor，文案與連結修正屬於 patch。

以往 `v1.0.x` 的 tag 都是 annotated；electron-builder 自己建的是 lightweight。要維持慣例，在 publish 之前先手動打 tag。

## 實機驗證清單

- [ ] 安裝程式可於乾淨的 Windows 10／11 x64 環境啟動（未簽章，SmartScreen 會警告）。
- [ ] 遊戲關閉時不啟動擷取；`svwb-engine` 行程不常駐。
- [ ] 遊戲視窗化、無邊框／全螢幕皆可開始擷取。
- [ ] 遊戲最小化時擷取停止；恢復後自動重新 attach。
- [ ] Electron terminal 出現 `[Engine] ready` 與 `[Engine] capture attached`；detach 時回報的 `framesSeen` 不為 0（attached 但零幀是擷取故障的樣子）。**打包後的版本沒有 terminal**，改看 `%APPDATA%\svwb-analyzer\diagnostics\engine.log`：要有 `[Engine] ready`，且 `[Startup]` 各行的 `exists=` 皆為 `true`。
- [ ] 對戰開始只新增一筆 Match；BP、MP、CR、模式與勝敗都更新到同一筆。
- [ ] 對局列表在對戰進行中就會即時更新，不會停在「未定」。
- [ ] 勝利與敗北、階級與 2Pick 至少各驗證一場。
- [ ] 觀戰重播不會留下幽靈對局。
- [ ] 既有使用者資料庫升級後保留牌組、標籤與歷史對局。
- [ ] 自動更新檢查、下載與重啟安裝流程正常。
- [ ] 沒有更新時**不會有任何彈窗**——背景檢查只在真的有新版可裝時才出聲。
- [ ] 差分下載有生效：更新時 terminal 應出現 `[Update] Download block maps (old: …, new: …)`，且**沒有** `Cannot download differentially, fallback to full download`。退回全量是無聲的，只有這行 log 看得出來，而代價是使用者多下載約 90MB。前提是舊版 release 上的 `.blockmap` 還在，以及 `%LOCALAPPDATA%\svwb-analyzer-updater\installer.exe` 存在（安裝時由 NSIS 複製）。

### 資料庫升級可以先離線驗證

不必等安裝就能測既有資料庫的升級路徑。拿一份舊備份跑引擎的 migration：

```powershell
Copy-Item "$env:APPDATA\svwb-analyzer\db\app.<timestamp>.bak.db" $env:TEMP\upgrade-test.db
tools\target\release\svwb-engine.exe migrate --db $env:TEMP\upgrade-test.db --migrations resources\migrations
tools\target\release\svwb-engine.exe migrate --db $env:TEMP\upgrade-test.db --migrations resources\migrations
```

第一次回報 `{"applied":N}`，第二次必須是 `{"applied":0}`——migration 要是冪等的。再用任何 SQLite 工具確認對局筆數沒有變、`pragma integrity_check` 為 `ok`。

## 發佈

發佈**不會重新建置**。`build:win` 產出的那三個檔就是上傳的那三個檔：

```powershell
pnpm run release:win
```

這是刻意的。先前的 `publish:win` 走 `electron-builder --publish always`，而它會在上傳前重建一次——NSIS 打包含時間戳、並非可重現建置，所以使用者下載到的二進位檔從來就不是你實機測過的那一份（來源 commit 相同，位元組不同）。順帶也省掉第二次 35 秒的 NSIS 壓縮。

代價是上傳的檔案不再由 electron-builder 挑選，所以 `release-win.ps1` 在 tag 與上傳之前會把每一項前置條件都擋下來，全部失敗即中止：

- **版本已經發佈過** → 直接拒絕。舊流程會把既有 release 的安裝檔換掉，而使用者因為版本相同不會收到更新，等於 release 頁面被無聲替換。
- **`latest.yml` 的 `sha512` 與 `size` 與磁碟上的 `.exe` 不符** → 拒絕。這就是以前要你手動 `curl` 下來比對的那一步，現在是硬性檢查。
- **`latest.yml` 的 `url` 與實際檔名不符** → 拒絕。見下方檔名一節。
- **缺 `.blockmap` 或 `latest.yml`** → 拒絕。缺前者，每個使用者多下載約 90MB；缺後者，更新器根本看不到這個版本。
- **工作目錄不乾淨** → 拒絕，因為 `dist/` 的產物對不上任何 commit。重傳時才用 `-AllowDirty`。

想先看檢查結果而不真的發佈：

```powershell
pnpm run release:win:dry
```

tag 由腳本建立，是 annotated 的，與 `v1.0.x` 以來的慣例一致（electron-builder 建的是 lightweight，這是以前要手動先打 tag 的原因）。release notes 仍需事後在 GitHub 補上。

授權走 GitHub CLI 自己的憑證（`gh auth login`），**repo 內不再存放任何 token**。`.env` 的 `GH_TOKEN` 已無用途。

### 安裝檔檔名不能改

`build.nsis.artifactName` 是寫死的 `SVWB-Analyzer-Setup-${version}.${ext}`，不是預設值，也不要換成 `${productName}`（會留空白）或 `${name}`（會變小寫）。

原因有兩層。第一，electron-builder 只在**上傳時**才把檔名正規化成連字號版，落地的檔案不改名；手動上傳會讓 asset 名字對不上 `latest.yml` 的 `url`，每次更新 404。第二，electron-updater 做差分下載時，是把舊版號代進這個檔名樣式去推舊 `.blockmap` 的網址；`v1.0.4` 以來的 asset 全都是 `SVWB-Analyzer-Setup-*`，樣式一變就整批退回全量下載。
