# macOS 開發環境與限制

macOS 可以做這個專案大部分的開發與測試工作。唯一真正做不到的是**即時擷取遊戲畫面**：那需要 Windows Graphics Capture 與 Win32 HWND，遊戲本身也只有 Windows 版。

值得先講清楚，因為它決定了 macOS 的價值：**辨識引擎除了即時擷取以外是跨平台的。** `windows-capture` 只列在 `tools/engine/Cargo.toml` 的 `[target.'cfg(windows)'.dependencies]`，`capture_source.rs` 整個檔案是 `#![cfg(windows)]`。狀態機、校準表、共識邏輯、範本比對、SQLite 寫入與 migration 全部沒有平台相依。

也就是說，`cargo test` 那套「每個情境對應一則歷史事故」的測試，以及 15 個涵蓋 44 張 fixture 的整合斷言——這個專案測試覆蓋的主體——在 Mac 上跑得起來。

## 適用範圍

| 工作                                                    | macOS |
| ------------------------------------------------------- | ----- |
| React／renderer／IPC／TypeScript 修改                   | 支援  |
| `pnpm typecheck`、`pnpm lint`、`pnpm build`             | 支援  |
| `pnpm test`（vitest：資料層、IPC 契約、純函式）         | 支援  |
| `pnpm vision:test`（cargo：狀態機情境與 fixture 斷言）  | 支援  |
| `pnpm vision:check`（clippy）                           | 支援  |
| `pnpm engine:build`、`svwb-engine migrate`              | 支援  |
| `svwb-engine replay <video>`（對錄影跑出貨的狀態機）    | 支援（見下方說明，npm script 本身是 Windows 路徑） |
| `pnpm dev`（UI 開發；遊戲一定顯示「未偵測到」）         | 支援  |
| 即時擷取、遊戲視窗偵測、真實對局辨識                     | 不支援；須在 Windows 實機驗證 |
| `capture:build`、`vision:build`（PowerShell 腳本）      | 不支援 |
| `vision:check-engine-parity` / `vision:verify`          | 不支援；需要 PowerShell 建置的 `svwb-vision.node` |
| `build:win`、NSIS installer、發行                        | 不支援 |

## 1. 安裝前置工具

```zsh
xcode-select --install
brew install git-lfs node@22
corepack enable
corepack install --global pnpm@11.10.0
```

Rust 也裝上——不是選配，`pnpm test` 需要引擎二進位檔才能跑（見第 3 節）：

```zsh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

專案以 Node `22.23.1` 為基準，詳見根目錄 `.node-version`。Apple Silicon 與 Intel Mac 都可以，但不要用 Mac 產出的原生模組或安裝檔取代 Windows 發行版本。

## 2. Clone 與安裝

```zsh
git lfs install
git clone https://github.com/zrecordy1003/SVWB-Analyzer.git
cd SVWB-Analyzer
pnpm install
```

不需要建立 `.env`；應用程式會自行在 Electron `userData` 建立並升級自己的資料庫。

`pnpm install` 的 postinstall 會執行 `electron-builder install-app-deps`，重建 `better-sqlite3`、`node-window-manager` 與 `extract-file-icon` 三個原生模組。這在 macOS 上是可行的（OpenCV 已經完全移除，過去必須 `--ignore-scripts` 的原因已不存在）。若原生重建仍然失敗，退而求其次：

```zsh
pnpm install --ignore-scripts
```

代價是 `pnpm test` 裡用到 `better-sqlite3` 的部分會無法執行。不要把 macOS 的 `node_modules`、原生二進位檔或 lockfile 副作用提交上去。

## 3. 在 macOS 可執行的檢查

先建引擎。資料庫相關的測試會透過 `svwb-engine migrate` 建立臨時資料庫——刻意如此，讓測試走的是與應用程式相同的 migration 路徑：

```zsh
pnpm engine:build
```

然後：

```zsh
pnpm typecheck
pnpm lint
pnpm test          # vitest
pnpm vision:test   # cargo test：狀態機情境 + fixture 斷言
pnpm vision:check  # clippy
pnpm build         # Electron main/preload/renderer bundle
```

`pnpm test` 若出現 `svwb-engine is not built at ...`，就是漏了 `pnpm engine:build`。

### 對錄影跑狀態機

`engine:replay-*` 這幾個 npm script 寫的是 Windows 路徑（`tools\target\release\svwb-engine.exe`），在 macOS 上不能直接用。底層指令本身是跨平台的，直接呼叫二進位檔即可：

```zsh
tools/target/release/svwb-engine replay \
  tests/fixtures/captures/cpu-practice-1920-fullscreen/recording.mp4 \
  --templates resources/templates --fps 2
```

需要 `ffmpeg`（`brew install ffmpeg`），而且錄影檔沒有進版控（見 `.gitignore`），要向 Windows 端索取。`tests/fixtures/captures/` 底下的 PNG 有進版控，`pnpm vision:test` 斷言的就是它們。

## 4. 不要在 macOS 執行的指令

```zsh
pnpm capture:build   # PowerShell 腳本 + Windows Rust MSVC toolchain
pnpm vision:build    # PowerShell 腳本，產出 svwb-vision.node
pnpm vision:verify   # 內含 check-engine-parity，需要上面那個 addon
pnpm build:win       # Windows／NSIS 發行環境
pnpm publish:win     # 需要 Windows build artifact 與 GH_TOKEN
```

`pnpm dev` 可以開起來，UI 開發完全可行。遊戲偵測會一直回報「未偵測到」——因為它找的是 `shadowversewb.exe`——所以擷取與辨識不會啟動。這是預期行為，不要把它當成真實功能驗證。

## 5. 與 Windows 開發者協作

1. macOS：UI、資料呈現、IPC、資料層、狀態機邏輯與其測試、文件。狀態機改動可以在 Mac 上用 `cargo test` 完整驗證。
2. Windows：即時擷取、範本／ROI 校準、OCR 實測、`vision:verify` 全套、NSIS 安裝程式與發布。
3. 任何影響**擷取或範本**的 PR，仍須附上 Windows 實機驗證與新舊截圖樣本。純狀態機或純 UI 的改動不需要。

## 疑難排解

| 現象                                              | 處理方式                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm test` 說 `svwb-engine is not built`         | 執行 `pnpm engine:build`。                                                         |
| 原生模組在 postinstall 失敗                       | 先確認 `xcode-select --install` 已完成；仍失敗則改用 `pnpm install --ignore-scripts`，但資料庫測試會無法執行。 |
| 找不到 `powershell.exe`，或 `.exe` 無法執行       | 預期行為；那些 script 只支援 Windows。                                             |
| `svwb-engine replay` 找不到錄影檔                 | 錄影檔沒有進版控，向 Windows 端索取後放到對應目錄。                                |
| Git 顯示 LFS 檔變成 pointer                       | 執行 `git lfs install`、`git lfs pull`。                                            |
| 要驗證擷取或真實對局辨識                          | 轉到 Windows 裝置，依 [Windows 開發環境與首次執行](windows-setup.md) 操作。        |
