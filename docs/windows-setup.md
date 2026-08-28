# Windows 開發環境與首次執行

本專案的正式支援平台是 **Windows 10 1903 以上與 Windows 11 x64**。遊戲偵測、視窗擷取與 OpenCV 原生模組皆以 Windows 為目標；macOS 與 Linux 的 package script 僅保留為實驗用途，不能視為支援的發行流程。

## 1. 安裝前置工具

請先安裝下列工具，再 clone 專案。

| 工具                           | 建議版本／安裝項目                                             | 用途                                           |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------- |
| Git                            | 最新版                                                         | 取得程式碼                                     |
| Git LFS                        | 最新版                                                         | 下載 OpenCV 執行期 DLL 與 OCR 資料等二進位資源 |
| Node.js                        | 22.23.1（見 `.node-version`）                                  | Electron 與 TypeScript 執行環境                |
| pnpm                           | 11.10.0                                                        | 套件管理                                       |
| Visual Studio 2022 Build Tools | **Desktop development with C++**、MSVC v143、Windows 10/11 SDK | 重建 Electron 的原生 OpenCV 模組               |
| Python                         | 3.11 以上                                                      | node-gyp 的原生編譯依賴                        |
| Rust                           | stable **MSVC** toolchain                                      | 編譯新版 Windows Graphics Capture 截圖器       |

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

`pnpm install` 會執行 Electron 原生模組重建；第一次安裝需要一些時間。若它在 `@u4/opencv4nodejs`、`node-gyp` 或 MSVC 相關步驟失敗，先確認已安裝上述 C++ Build Tools、Windows SDK 與 Python，然後重新開啟 PowerShell 再執行一次。

確認 LFS 資源不是 pointer 檔：

```powershell
git lfs ls-files
Get-Item resources\opencv\bin\opencv_world4110.dll
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
pnpm run db:migrate:dev      # 僅開發用途：變更 Prisma schema 後建立 migration
```

`pnpm run typecheck` 會同時執行 renderer 檢查；目前 renderer 有既有型別債務，尚未列為發行阻擋條件。修改 renderer 時請主動執行 `pnpm run typecheck:web`，並修正自己變更造成的問題。

## 5. 資料庫與資料安全

應用程式啟動時會自行在 Electron `userData\db\app.db` 建立 SQLite 資料庫；Windows 上通常位於 `%APPDATA%\svwb-analyzer\db\app.db`。

正式程式套用的是 `resources/migrations/` 內以三位數版本號命名的 SQL migration。發現未套用 migration 時，程式會先備份現有資料庫，並保留最近五份備份。

修改資料表時請同時：

1. 更新 `prisma/schema.prisma`，供 TypeScript／Prisma Client 使用。
2. 建立或更新 `prisma/migrations/`，供開發資料庫使用。
3. 新增下一個 `resources/migrations/NNN_description.sql`，供已安裝版本升級使用。
4. 以既有資料庫與全新資料庫各測試一次升級。

不要在 release build 中執行 `prisma migrate dev`；正式資料庫升級只由應用程式內建 migration runner 處理。

## 疑難排解

| 現象                                        | 優先檢查                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `git-lfs: command not found` 或資源檔異常小 | 安裝 Git LFS，執行 `git lfs install` 與 `git lfs pull`。                                                  |
| `node-gyp`／OpenCV rebuild 失敗             | Visual Studio C++ Build Tools、Windows SDK、Python 與目前 Node 版本。                                     |
| 有偵測到遊戲但沒有截圖                      | 重新執行 `pnpm run capture:build`，確認遊戲不是最小化，查看 Electron terminal 的 `[Capture]` JSON／錯誤。 |
| 擷取器立即退出                              | 確認 Windows 版本、遊戲 HWND 是否有效，以及 `tools\svwb-capture-tool.exe` 是否是最新 Rust 產物。          |
| 資料庫找不到或要重置                        | 先完整備份 `%APPDATA%\svwb-analyzer\db\`，再處理 `app.db`；不要直接刪除唯一資料庫。                       |
