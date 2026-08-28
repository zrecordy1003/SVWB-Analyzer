# macOS 開發環境與限制

macOS 可用於閱讀程式、修改 React／TypeScript、檢查文件、執行 bundle build 與進行部分資料庫開發；但 **不能作為 SVWB Analyzer 的完整執行或發行平台**。

目前遊戲偵測與擷取依賴 Windows 行程、Win32 HWND、Windows Graphics Capture、Windows OpenCV 資源及 `svwb-capture-tool.exe`。因此在 macOS 上無法擷取 Shadowverse: Worlds Beyond 視窗，也無法驗證真實對局辨識。

## 適用範圍

| 工作                                              | macOS 支援狀態                     |
| ------------------------------------------------- | ---------------------------------- |
| 文件、React、renderer、IPC 與一般 TypeScript 修改 | 支援                               |
| `npm run build` bundle 驗證                       | 支援                               |
| Prisma schema／開發資料庫檢視                     | 支援                               |
| Windows 截圖器 Rust 原始碼閱讀                    | 支援                               |
| `capture:build` 與 Windows 截圖器實測             | 不支援；須在 Windows MSVC 環境執行 |
| Shadowverse 視窗偵測、截圖與 OpenCV 對局辨識      | 不支援；須在 Windows 實機驗證      |
| `build:win`、NSIS installer、auto-update 發行     | 不支援；須在 Windows 執行          |

## 1. 安裝前置工具

建議使用 Homebrew：

```zsh
xcode-select --install
brew install git-lfs node@22
corepack enable
corepack install --global pnpm@11.10.0
```

確認版本：

```zsh
git --version
git lfs --version
node --version
pnpm --version
```

專案以 Node `22.23.1` 為基準，詳見根目錄 `.node-version`。Apple Silicon 與 Intel Mac 都可進行 source／bundle 工作，但不應用它們產出的原生模組或安裝檔取代 Windows 發行版本。

## 2. Clone 與安全安裝

先取得所有 LFS 資源：

```zsh
git lfs install
git clone https://github.com/zrecordy1003/SVWB-Analyzer.git
cd SVWB-Analyzer
```

`@u4/opencv4nodejs` 會在一般 `pnpm install` 的 postinstall 階段嘗試重建 Electron 原生模組。專案目前攜帶 Windows OpenCV 資源，且未提供經驗證的 macOS 原生 OpenCV 設定；因此 macOS 建議先略過 install scripts：

```zsh
pnpm install --ignore-scripts
```

這種安裝方式足以進行 TypeScript、renderer、文件與 bundle 工作，但無法執行 OpenCV 對局分析。不要將 macOS 的 `node_modules`、原生二進位檔或 lockfile 副作用提交到 repository。

## 3. 在 macOS 可執行的檢查

```zsh
npm run typecheck:node
npm run build
```

`npm run build` 驗證 Electron main/preload/renderer 的 bundle；它不等於已能在 macOS 上進行遊戲擷取。若要修改 Prisma schema，可使用 `.env` 的本機 `prisma/dev.db`，但正式 migration 仍須遵守 [Windows 文件中的 migration 規則](windows-setup.md#5-資料庫與資料安全)。

## 4. 不要在 macOS 執行的指令

```zsh
pnpm run capture:build  # 需要 Windows Rust MSVC toolchain 與 Windows Graphics Capture
pnpm run build:win      # 需要 Windows／NSIS 發行環境
pnpm run publish:win    # 需要 Windows build artifact 與發佈憑證
```

`pnpm run dev` 可能可以開啟部分 Electron UI，但沒有可用的遊戲擷取器，且原生 OpenCV 模組未受 macOS 支援；請不要將它當成真實功能驗證。

## 5. 與 Windows 開發者協作

推薦分工：

1. macOS：UI、資料呈現、IPC、文件、資料庫邏輯與 bundle 檢查。
2. Windows：安裝完整依賴、編譯 Rust 截圖器、擷取遊戲畫面、調整範本／OCR、建立 NSIS 安裝程式與正式發布。
3. 任何影響辨識或原生模組的 PR，都應附上 Windows 實機驗證結果與新舊截圖樣本。

## 疑難排解

| 現象                                                   | 處理方式                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `@u4/opencv4nodejs` 在 postinstall 失敗                | 使用 `pnpm install --ignore-scripts` 進行非原生開發；不要嘗試把這當作 Windows 發行問題修正。 |
| 找不到 `powershell.exe`、`tasklist` 或 `.exe` 無法執行 | 預期行為；這些功能只支援 Windows。                                                           |
| Git 顯示 LFS 檔變成 pointer 或取得失敗                 | 執行 `git lfs install`、`git lfs pull`，確認網路與 LFS 存取權。                              |
| 要驗證截圖器或遊戲辨識                                 | 轉到 Windows 裝置，依 [Windows 開發環境與首次執行](windows-setup.md) 操作。                  |
