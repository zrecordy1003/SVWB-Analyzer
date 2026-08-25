# Security Policy

## Supported versions

安全性修正只會提供給最新發布版本與 `main` 分支。舊版使用者應先更新至最新 release。

## Reporting a vulnerability

請不要在公開 GitHub Issue、討論區、Pull Request 或 Discord 貼出可利用細節、帳號資料、完整截圖或 PoC。

優先使用 repository 的 GitHub **Private vulnerability reporting** 功能提交報告。若該功能尚未啟用，請建立不含細節的公開 Issue，標題為 `Security contact requested`；維護者會提供私密聯絡方式。

報告請包含：

- 受影響的版本與 Windows/macOS 環境。
- 重現步驟、預期結果與實際結果。
- 影響範圍與可能的濫用方式。
- 最小可重現範例或經過去識別化的附件。
- 是否已公開或有已知的 workaround。

## Scope

在範圍內的問題包括本應用程式的 Electron 主程序、preload／IPC 邊界、更新流程、資料庫處理、設定檔、截圖器程序呼叫與 release artifact。

不在範圍內：上游遊戲服務、Cygames 帳號系統、第三方套件尚未證實會影響本專案的問題，以及需要作弊、規避遊戲保護或未授權存取才能證明的回報。

## Disclosure

請給維護者合理時間驗證與修正後再公開。確認問題後，維護者會在 release notes 或 GitHub Security Advisory 註明受影響版本、修正版本與必要的緩解措施。
