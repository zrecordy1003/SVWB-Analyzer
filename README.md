# ShadowverseWB Analyzer

[![GitHub Downloads (all releases)](https://img.shields.io/github/downloads/zrecordy1003/SVWB-Analyzer/total)](https://github.com/zrecordy1003/SVWB-Analyzer/releases)
[![GitHub Downloads (latest release)](https://img.shields.io/github/downloads/zrecordy1003/SVWB-Analyzer/latest/total)](https://github.com/zrecordy1003/SVWB-Analyzer/releases/latest)
[![GitHub Release (latest)](https://img.shields.io/github/v/release/zrecordy1003/SVWB-Analyzer)](https://github.com/zrecordy1003/SVWB-Analyzer/releases/latest)

> 正式支援 Windows 10 1903+／Windows 11 x64。請先安裝 Git LFS；OpenCV 執行期 DLL 與 OCR 資料由 LFS 管理。

## 文件導覽

| 目的                                    | 文件                                                |
| --------------------------------------- | --------------------------------------------------- |
| 在另一台 Windows 裝置 clone、設定並啟動 | [Windows 開發環境與首次執行](docs/windows-setup.md) |
| 在 Mac 上進行程式、UI 或文件開發        | [macOS 開發環境與限制](docs/macos-setup.md)         |
| 瞭解程式模組、資料與辨識流程            | [架構說明](docs/architecture.md)                    |
| 建立 Windows 安裝程式與發布版本         | [Windows 發行流程](docs/releasing.md)               |
| 修改程式、辨識或資料庫                  | [貢獻指南](CONTRIBUTING.md)                         |
| 編譯 Rust 截圖器                        | [截圖器文件](tools/capture/README.md)               |
| 授權、遊戲素材與安全性回報              | [授權與政策](#授權與官方素材)                       |

## Windows 快速開始

```powershell
git lfs install
git clone https://github.com/zrecordy1003/SVWB-Analyzer.git
Set-Location SVWB-Analyzer
Copy-Item .env.example .env
pnpm install
pnpm run capture:build
pnpm run dev
```

完整前置需求、原生模組失敗處理、資料庫位置與實機驗證步驟請見 [Windows 開發環境與首次執行](docs/windows-setup.md)。

<!-- 英文版放這裡 -->

## English

### Description

A desktop application built with Electron, OpenCV4NodeJS, and Tesseract.js ...

### Features

- Automated screenshot capture
- Template matching with OpenCV4NodeJS
- OCR for BP gain/loss using Tesseract.js
- SQLite persistence written by the Rust engine (WAL; the UI reads via Kysely)
- React + MUI analytics dashboard

---

<!-- 中文版放這裡 -->

## 中文說明

### 專案簡介

一款以 Electron、OpenCV4NodeJS 與 Tesseract.js 為核心的桌面應用，  
自動擷取 ShadowverseWB 截圖、辨識對戰資料並儲存至資料庫，  
同時提供即時與歷史對局分析介面。

### 主要功能

- 自動截圖：持續監控遊戲視窗並定時擷取
- 模板比對：辨識職業、徽章、先後攻與勝敗
- OCR：擷取排行 BP 正負增減
- SQLite：完整對戰紀錄由 Rust 引擎直接寫入（UI 以 Kysely 讀取）
- React + MUI：即時分析、對局列表、統計圖表

### 開發中的截圖器

截圖器原始碼位於 `tools/capture/`，以 Rust 與 Windows Graphics Capture 依已驗證的視窗 HWND 擷取畫面。它不依賴遊戲視窗標題，並以 JSON Lines 回報擷取狀態。

在 Windows 安裝 Rust MSVC toolchain 後，執行：

```powershell
pnpm run capture:build
```

此指令會產生 `tools/svwb-capture-tool.exe`（保留為回退點；正式擷取已內建於 `svwb-engine`）。`pnpm run build:win` 會依序建置截圖器、vision addon 與 `svwb-engine`。

## 支持開發

本工具完全免費，所有功能對每個人都一樣，不會有贊助才能使用的部分。若覺得有幫助，可透過
[歐付寶](https://p.opay.tw/EYvPO)（信用卡／ATM／超商代碼）小額贊助。贊助純屬自願，不構成任何交易或回報，與
Cygames 無關；款項用於後續維護與開發。

## 授權與官方素材

本專案的原創程式碼以 [Apache License 2.0](LICENSE) 授權；詳細權利聲明請見 [NOTICE](NOTICE)。此授權不涵蓋 Cygames 的商標、遊戲畫面、卡片、角色、遊戲衍生辨識範本或任何第三方素材。請在提交素材前閱讀 [素材政策](ASSETS_POLICY.md)。

Shadowverse: Worlds Beyond 及其相關智慧財產為 Cygames, Inc. 所有。© Cygames, Inc. 本專案／應用程式不是 Cygames 的產品，未獲 Cygames 合作、推薦、贊助或個別核准；Cygames 對本專案／應用程式的營運與內容不負任何責任。使用 Cygames 素材時，須遵守其 [Content Guidelines](https://shadowverse-wb.com/en/guideline/)。

發現安全性問題時，請先閱讀 [SECURITY.md](SECURITY.md)，不要在公開 Issue 貼出可利用細節。
