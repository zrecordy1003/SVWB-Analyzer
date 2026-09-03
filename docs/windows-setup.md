# Windows 開發環境與首次執行

本專案的正式支援平台是 **Windows 10 1903 以上與 Windows 11 x64**。遊戲偵測與視窗擷取（Windows Graphics Capture）以 Windows 為目標；macOS 與 Linux 的 package script 僅保留為實驗用途，不能視為支援的發行流程。辨識引擎本身除了即時擷取以外是跨平台的，詳見 [macOS 開發環境](macos-setup.md)。

## 1. 安裝前置工具

請先安裝下列工具，再 clone 專案。

| 工具                           | 建議版本／安裝項目                                             | 用途                                        |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| Git                            | 最新版                                                         | 取得程式碼                                  |
| Git LFS                        | 最新版                                                         | 下載 OCR 訓練資料（`eng.traineddata.gz`）   |
| Node.js                        | 22.23.1（見 `.node-version`）                                  | Electron 與 TypeScript 執行環境             |
| pnpm                           | 11.10.0                                                        | 套件管理                                    |
| Visual Studio 2022 Build Tools | **Desktop development with C++**、MSVC v143、Windows 10/11 SDK | 重建 Electron 原生模組，並供 Rust MSVC 使用 |
| Python                         | 3.11 以上                                                      | node-gyp 的原生編譯依賴                     |
| Rust                           | stable **MSVC** toolchain                                      | 編譯 `svwb-engine`、vision addon 與截圖器   |

安裝 Node.js 後，以 PowerShell 啟用 pnpm：

```powershell
corepack enable
corepack install --global pnpm@11.10.0
```

確認工具版本：

```powershell
git --version
git lfs --version
node --version
pnpm --version
cargo --version
```

## 2. Clone 與安裝依賴

```powershell
git lfs install
git clone https://github.com/zrecordy1003/SVWB-Analyzer.git
Set-Location SVWB-Analyzer
pnpm install
```

`pnpm install` 會執行 Electron 原生模組重建；第一次安裝需要一些時間。若它在 `better-sqlite3`、`node-window-manager`、`node-gyp` 或 MSVC 相關步驟失敗，先確認已安裝上述 C++ Build Tools、Windows SDK 與 Python，然後重新開啟 PowerShell 再執行一次。

確認 LFS 資源不是 pointer 檔：

```powershell
git lfs ls-files
Get-Item eng.traineddata.gz | Select-Object Length   # 應約 2.9 MB，不是 132 bytes
```

## 3. 編譯截圖器並啟動開發版

新版截圖器由 Rust 建置；它會覆蓋 `tools\svwb-capture-tool.exe`，這是預期行為。

```powershell
pnpm run capture:build
pnpm run dev
```

開發版啟動後：

1. 開啟 Shadowverse: Worlds Beyond。
2. 保持遊戲視窗存在且未最小化；建議先使用視窗化或無邊框視窗化模式。
3. 開啟 SVWB Analyzer。主程式會以 `shadowversewb.exe` 驗證遊戲行程、取得 HWND、啟動截圖器，然後開始分析。
4. 在對戰開始、結算與下一場切換時，確認主介面的擷取／辨識狀態與對局紀錄是否同步更新。

## 4. 常用指令

```powershell
pnpm run dev                 # Electron 開發模式
pnpm run build               # 編譯 JS bundle，不產生安裝程式
pnpm run capture:check       # 檢查 Rust 截圖器
pnpm run capture:build       # 編譯並複製 Windows 截圖器
pnpm run build:win           # 截圖器 + Electron Windows 安裝程式
pnpm run lint                # ESLint
pnpm run typecheck:node      # Electron main process TypeScript 檢查
pnpm run engine:build        # 編譯辨識引擎（測試需要）
pnpm run vision:verify       # cargo 測試 + clippy + OCR oracle + 引擎/addon parity
```

`pnpm run typecheck` 會同時執行 renderer 檢查；目前 renderer 有既有型別債務，尚未列為發行阻擋條件。修改 renderer 時請主動執行 `pnpm run typecheck:web`，並修正自己變更造成的問題。

## 5. 資料庫與資料安全

應用程式啟動時會自行在 Electron `userData\db\app.db` 建立 SQLite 資料庫；Windows 上通常位於 `%APPDATA%\svwb-analyzer\db\app.db`。

正式程式套用的是 `resources/migrations/` 內以三位數版本號命名的 SQL migration。發現未套用 migration 時，程式會先備份現有資料庫，並保留最近五份備份。

**`resources/migrations/` 是 schema 的唯一真相**，由 `svwb-engine migrate` 套用。這裡沒有 ORM，也沒有第二份 schema 定義需要同步——之前的 Prisma schema 與開發用 migration 都已隨 Prisma 一併移除。

修改資料表時：

1. 新增下一個 `resources/migrations/NNN_description.sql`。
2. 更新 `tools/engine/src/store.rs`（引擎的寫入端）與 `src/main/data/db/client.ts` 的 `MatchRow`（UI 的讀取端）。這兩份是 SQL 的手工鏡像，加了欄位卻漏改任一邊不會有編譯錯誤。
3. 以既有資料庫與全新資料庫各測試一次升級。既有資料庫可以直接拿 `%APPDATA%\svwb-analyzer\db\` 裡的 `.bak.db` 副本測：

   ```powershell
   Copy-Item "$env:APPDATA\svwb-analyzer\db\app.<timestamp>.bak.db" $env:TEMP\upgrade-test.db
   tools\target\release\svwb-engine.exe migrate --db $env:TEMP\upgrade-test.db --migrations resources\migrations
   ```

   再跑一次應該回報 `{"applied":0}`——migration 必須是冪等的。

## 疑難排解

| 現象                                        | 優先檢查                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `git-lfs: command not found` 或資源檔異常小 | 安裝 Git LFS，執行 `git lfs install` 與 `git lfs pull`。                                                  |
| `node-gyp`／原生模組 rebuild 失敗           | Visual Studio C++ Build Tools、Windows SDK、Python 與目前 Node 版本。                                     |
| 有偵測到遊戲但沒有截圖                      | 重新執行 `pnpm run capture:build`，確認遊戲不是最小化，查看 Electron terminal 的 `[Capture]` JSON／錯誤。 |
| 擷取器立即退出                              | 確認 Windows 版本、遊戲 HWND 是否有效，以及 `tools\svwb-capture-tool.exe` 是否是最新 Rust 產物。          |
| 資料庫找不到或要重置                        | 先完整備份 `%APPDATA%\svwb-analyzer\db\`，再處理 `app.db`；不要直接刪除唯一資料庫。                       |
