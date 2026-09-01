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

## 測試更新流程

更新流程在 `pnpm dev` 就能整套走一遍，不需要發佈 release。一個 dev build 永遠等於它建置時的版本號，所以「有新版可下載」「下載到 37%」「下載失敗」這幾個狀態，本來只有真的發一版才看得到；`SVWB_UPDATE_SIM` 會用一個模擬器接管同樣的 IPC 頻道來重現它們。

```powershell
$env:SVWB_UPDATE_SIM = 'available'; pnpm dev
```

| 值               | 情境                                                         |
| ---------------- | ------------------------------------------------------------ |
| `available`      | 找到新版，差分大小的下載（約 4.8MB）                         |
| `big`            | 找到新版，退回完整下載（約 92MB），用來看進度條與速率        |
| `none`           | 已是最新版                                                   |
| `error`          | 檢查失敗                                                     |
| `download-error` | 檢查成功，下載到一半斷線                                     |
| `real`           | 不模擬，改用 `dev-app-update.yml` 對真實 GitHub release 檢查 |

設了環境變數，啟動兩秒後會自動跑一次背景檢查；**沒設的話 dev 一樣有模擬器，但不會自動觸發**，要按設定頁的「檢查更新」才會動——平常開發不會被更新視窗打斷。

要看背景與設定頁兩條路徑的差異，記得它們是分開的：背景檢查只在真的有東西可裝時才出聲，設定頁則會回報包含「已是最新」與失敗在內的每一種結果。搭配設定頁的「自動下載更新」開關可以驗證第三條路徑——自動下載時完全不彈窗，直到下載完成才提示安裝。

模擬器在 `src/main/updates.ts` 的 `wireSimulator`，送出的 payload 與真實 updater 完全相同，所以 renderer 那側沒有任何為了測試而存在的分支。

## 端對端測試（真的 app）

`pnpm test` 是 vitest，跑純邏輯。要驗證「畫面上真的長這樣、按下去真的會這樣」，用 Playwright 啟動**真正的 Electron app**：

```powershell
pnpm run test:e2e
```

它會先 `build` 再跑 `tests/e2e/*.spec.ts`。單純重跑測試（確定 `out/` 是新的）用 `pnpm run test:e2e:only`；想看 app 自己的 `[Engine]` / `[Update]` log 就加 `$env:E2E_VERBOSE=1`。

Playwright 在這裡**只當 Electron driver**，沒有任何瀏覽器 project——所以 `pnpm install` 不會去下載那幾百 MB 的 Chromium（pnpm 的 `onlyBuiltDependencies` 允許清單本來就擋掉了它的 postinstall）。

測試檔用 `*.spec.ts`，vitest 只收 `*.test.ts`，兩個 runner 靠副檔名分家。截圖與失敗現場落在 `test-results/`（已 gitignore），也會附在報告裡。

### 三件不直覺的事

**`firstWindow()` 拿到的是 splash，不是主視窗。** splash 先被建立、活大約一秒。`tests/e2e/app.ts` 的 `window` fixture 是用 URL 挑出 `renderer/index.html` 的那個。

**測試跑的是 `out/`，不是你剛改的原始碼。** 這是這套 harness 唯一會無聲說謊的地方——忘記 build，所有測試都會對著舊程式碼開心地通過。第一次踩到時，一個故意放回去的 bug 就這樣被放行了。所以 fixture 會比對 `src/` 與 `out/` 的 mtime，舊了就直接報錯而不是繼續跑。

**每次啟動都用獨立的 `--user-data-dir`。** 少了它，單一實例鎖會讓第二次啟動直接 exit(0) 而且沒有視窗；更糟的是測試會去讀寫、甚至 migrate 你本機真正的對局資料庫。

### 寫更新流程的測試

夾具就是 `SVWB_UPDATE_SIM`（見上一節）。用 `test.use({ updateScenario: 'none' })` 指定情境，fixture 會把它放進環境變數並啟動 app：

```ts
test.use({ updateScenario: 'none' })

test('沒有更新時不該打擾使用者', async ({ window }) => {
  await window.waitForTimeout(6_000) // 模擬的背景檢查在啟動後兩秒觸發
  await expect(window.getByRole('dialog')).toHaveCount(0)
})
```

「不該出現什麼」這類斷言只有在真的 app 上才寫得出來，而它正是先前每次啟動都彈窗那個 bug 的守門員。

## 修改辨識邏輯

- 說明調整的範本、ROI 或閾值，以及原因。
- 加入或保留可重現問題的匿名化截圖。
- 至少驗證舊版與新版遊戲畫面的關鍵流程不互相回歸。
- 不要讓對局更新回到「最新一筆」的資料庫寫入方式；請使用目前場次的 `matchId`。
- 新卡包素材必須等 Cygames 官方公開後才可提交，且圖片須最小化裁切並去識別化。

## 修改資料庫

`resources/migrations/` 是 schema 的唯一真相，由 `svwb-engine migrate` 套用；沒有 ORM，也沒有第二份 schema 需要同步。新增 migration 後，記得同步 `tools/engine/src/store.rs` 與 `src/main/data/db/client.ts` 的 `MatchRow`——它們是 SQL 的手工鏡像，漏改不會有編譯錯誤。詳見 [Windows 開發環境與首次執行](docs/windows-setup.md#5-資料庫與資料安全)。
