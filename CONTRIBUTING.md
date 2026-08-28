# Contributing

開始開發前請閱讀：[Windows 開發環境與首次執行](docs/windows-setup.md) 與[架構說明](docs/architecture.md)。

## 提交前最低要求

```powershell
pnpm run lint
pnpm run typecheck:node
pnpm run build
```

變更 Windows 截圖器時，另執行：

```powershell
pnpm run capture:check
pnpm run capture:build
```

請勿提交 `node_modules`、`out`、`.env`、本機 SQLite 資料庫或遊戲截圖。大檔二進位資源由 Git LFS 管理；clone 前請先安裝 Git LFS。

當 `.gitattributes` 的 LFS 規則有調整時，提交前執行 `git add --renormalize .`，確認既有檔案依新規則重新加入 index；再用 `git lfs status` 檢查是否意外產生大型待推送物件。

提交 Pull Request 即表示你有權提交內容，並同意將你的原創程式碼與文件依 [Apache-2.0](LICENSE) 授權。遊戲衍生圖片、Cygames 商標與第三方內容不在此授權範圍；提交前請閱讀 [素材與商標政策](ASSETS_POLICY.md)。

## 修改辨識邏輯

- 說明調整的範本、ROI 或閾值，以及原因。
- 加入或保留可重現問題的匿名化截圖。
- 至少驗證舊版與新版遊戲畫面的關鍵流程不互相回歸。
- 不要讓對局更新回到「最新一筆」的資料庫寫入方式；請使用目前場次的 `matchId`。
- 新卡包素材必須等 Cygames 官方公開後才可提交，且圖片須最小化裁切並去識別化。

## 修改資料庫

`resources/migrations/` 是 schema 的唯一真相，由 `svwb-engine migrate` 套用；沒有 ORM，也沒有第二份 schema 需要同步。新增 migration 後，記得同步 `tools/engine/src/store.rs` 與 `src/main/data/db/client.ts` 的 `MatchRow`——它們是 SQL 的手工鏡像，漏改不會有編譯錯誤。詳見 [Windows 開發環境與首次執行](docs/windows-setup.md#5-資料庫與資料安全)。
