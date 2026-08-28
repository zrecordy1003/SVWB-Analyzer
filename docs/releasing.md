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

## 版本號

**發版前一定要更新 `package.json` 的 `version`。** electron-builder 以版本號決定 GitHub release 的 tag；若沿用一個已發佈過的版本號，它會把**既有 release 的安裝檔換掉**，而使用者的 electron-updater 因為版本相同不會提示更新——結果是 release 頁面的檔案被無聲替換。

語意化版本以「使用者感受到什麼」為準：辨識管線更換屬於 minor，文案與連結修正屬於 patch。

以往 `v1.0.x` 的 tag 都是 annotated；electron-builder 自己建的是 lightweight。要維持慣例，在 publish 之前先手動打 tag。

## 實機驗證清單

- [ ] 安裝程式可於乾淨的 Windows 10／11 x64 環境啟動（未簽章，SmartScreen 會警告）。
- [ ] 遊戲關閉時不啟動擷取；`svwb-engine` 行程不常駐。
- [ ] 遊戲視窗化、無邊框／全螢幕皆可開始擷取。
- [ ] 遊戲最小化時擷取停止；恢復後自動重新 attach。
- [ ] Electron terminal 出現 `[Engine] ready` 與 `[Engine] capture attached`；detach 時回報的 `framesSeen` 不為 0（attached 但零幀是擷取故障的樣子）。
- [ ] 對戰開始只新增一筆 Match；BP、MP、CR、模式與勝敗都更新到同一筆。
- [ ] 對局列表在對戰進行中就會即時更新，不會停在「未定」。
- [ ] 勝利與敗北、階級與 2Pick 至少各驗證一場。
- [ ] 觀戰重播不會留下幽靈對局。
- [ ] 既有使用者資料庫升級後保留牌組、標籤與歷史對局。
- [ ] 自動更新檢查、下載與重啟安裝流程正常。

### 資料庫升級可以先離線驗證

不必等安裝就能測既有資料庫的升級路徑。拿一份舊備份跑引擎的 migration：

```powershell
Copy-Item "$env:APPDATA\svwb-analyzer\db\app.<timestamp>.bak.db" $env:TEMP\upgrade-test.db
tools\target\release\svwb-engine.exe migrate --db $env:TEMP\upgrade-test.db --migrations resources\migrations
tools\target\release\svwb-engine.exe migrate --db $env:TEMP\upgrade-test.db --migrations resources\migrations
```

第一次回報 `{"applied":N}`，第二次必須是 `{"applied":0}`——migration 要是冪等的。再用任何 SQLite 工具確認對局筆數沒有變、`pragma integrity_check` 為 `ok`。

## 發佈

```powershell
pnpm run publish:win
```

這一個指令會重新建置、建立 GitHub release、上傳安裝檔與 `latest.yml`。**它會重新建置**，所以上傳的二進位檔不是你先前實機測試的那一份（NSIS 打包含時間戳，並非可重現建置）；來源 commit 相同。

發佈後務必確認 `latest.yml` 的 `sha512` 與實際上傳的安裝檔一致——不一致的話，每一次自動更新都會在完整性檢查失敗，而且是無聲失敗：

```powershell
curl -sL https://github.com/zrecordy1003/SVWB-Analyzer/releases/download/v<version>/latest.yml
```

再與本機 `dist\` 內同名安裝檔的 sha512（base64）比對。

electron-builder 不會寫 release notes，需要事後在 GitHub 補上。

`publish:win` 透過 `.env` 讀取 `GH_TOKEN`；此檔案不得提交。發佈授權只應存在於受信任的本機或 CI secret。`.env` 除了 `GH_TOKEN` 之外沒有其他必要內容，但**不要因此刪掉整個檔案**。
