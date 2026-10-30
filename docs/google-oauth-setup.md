# Google 登入設定清單（維護者用）

> 讓跨裝置同步在正式版生效的步驟，照順序做。程式碼已經就緒（`src/main/sync/google.ts`、`config.ts`），
> 這裡只有 Google Cloud Console 和網站上、只有專案擁有者做得了的事。
> 內容是 2026-10-30 對照 Google 官方文件整理的；Console 的介面名稱會變，以當下畫面為準。
> 背景與設計理由見 `docs/account-sync-plan.md`。

## 已查證、不用再查的事

| 項目 | 現況 | 來源 |
| ---- | ---- | ---- |
| 桌面 client + `http://127.0.0.1:任意port` 回跳 | Windows 桌面應用程式的官方推薦做法。已停用的是自訂 URI scheme 與手動複製貼上（OOB），我們都沒用 | [native-app](https://developers.google.com/identity/protocols/oauth2/native-app) |
| PKCE | 桌面 client 必須用；我們用 S256 | 同上 |
| client secret | 桌面 client 是「公開 client」，secret 不算機密；文件寫換 token 時可以不帶，但我們照帶 | 同上 |
| `drive.appdata` | 列在 **Non-sensitive scopes**，不需要敏感／受限範圍審核 | [Drive 範圍](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) |
| 嵌入式 webview 登入 | Google 封鎖，所以一定走系統瀏覽器 | `account-sync-plan.md` |

## 1. 建 OAuth client、拿到 secret

- [ ] Google Auth Platform → **Clients** → 建立，類型選 **「桌面應用程式」（Desktop app）**，不是 Web。
      桌面類型不用登記重新導向 URI。
- [ ] **建立當下就把 client secret 存起來**（密碼管理器）。Google 現在的規定是 secret 只在建立時顯示一次，
      之後只看得到末四碼（[官方說明](https://support.google.com/cloud/answer/15549257)）。
- [ ] 沒存到的話不用重建 client：在同一個 client 底下**新增一組 secret**，新的立即可用，舊的手動停用。
      重建 client 會換掉 client ID，已登入的使用者全部要重新登入。

> 已有一個桌面 client ID（`598848392443-…`），secret 還沒交出來。另一個 Web client 已經不需要，可以刪。
> 第三方文章提到 Google 會刪除閒置超過 6 個月的 OAuth client，官方頁面上沒找到，但值得留意。

## 2. Data Access：只加四個範圍

- [ ] `openid`
- [ ] `.../auth/userinfo.email`（`email`）
- [ ] `.../auth/userinfo.profile`（`profile`）
- [ ] `https://www.googleapis.com/auth/drive.appdata`

不要多加。`google.ts` 要求的就是這四個（`SCOPES`），多一個範圍就要改隱私權政策，也可能踩到審核。

## 3. Audience：發版前一定要切到 Production

| 狀態 | 誰能登入 | 代價 |
| ---- | -------- | ---- |
| Testing | 只有列進測試使用者的帳號，上限 100 個 | **授權與 refresh token 7 天後失效**：使用者每週都得重新登入 |
| Production | 任何 Google 帳號 | 只用非敏感範圍時應該不需要送審（見下） |

7 天的豁免只涵蓋基本的 `openid email profile`，**`drive.appdata` 不在豁免內**，所以停在 Testing 等於同步每週壞一次
（[官方說明](https://support.google.com/cloud/answer/15549945)）。

- [ ] 自己測試期間：留在 Testing，把自己的帳號加進測試使用者。
- [ ] 發版前：按「Publish app」切到 Production。按之前在 Console 裡確認不會被要求驗證：
      官方說明「什麼情況必須驗證」的那一節沒查到原文。

## 4. Branding：隱私權政策與首頁

- [ ] 補完 `docs/privacy-policy-draft.md` 的〔聯絡方式〕〔生效日期〕，逐段核對和實際行為一致。
- [ ] 把它放到一個公開網址，填進同意畫面的隱私權政策欄位。
- [ ] 應用程式名稱填 `SVWB Analyzer`，和 loopback 回跳頁（`google.ts` 的 `PAGE`）一致。

**品牌驗證**（[官方要求](https://support.google.com/cloud/answer/13464321)）只有在需要時才做。要做的話：

- 首頁必須放在**自己擁有、用 Search Console 驗證過的網域**，不能只是登入頁，要描述功能並連到隱私權政策；
- 隱私權政策放在同一個網域，和同意畫面上填的網址相同；
- 「Authorized domains」裡的每個網域都要驗證所有權；
- `github.io` 這類網域無法證明是自己的，所以要自己的網域。

> 未查證的理解：不上傳 logo 就不會被要求品牌驗證，同意畫面照樣顯示應用程式名稱。上傳 logo 前先確認。

## 5. 接進 app

**開發版對真 Google 試**（`pnpm dev` 沒提供 client 時，同步功能完全不會啟用）：

```powershell
$env:SVWB_GOOGLE_CLIENT_ID = 'xxx.apps.googleusercontent.com'
$env:SVWB_GOOGLE_CLIENT_SECRET = 'xxx'
pnpm dev
```

注意開發用的資料庫裡有種子資料，登入後會跟著同步進那個帳號的 Drive；用測試帳號試。

**正式版**：建置時提供下面兩個變數，electron-vite 會把它們直接寫進 main bundle：

```
MAIN_VITE_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
MAIN_VITE_GOOGLE_CLIENT_SECRET=xxx
```

放在環境變數或不進版控的 `.env` 都可以。
- [ ] 確認 `.env` 沒有被 commit。
- [ ] 確認發版機器上有這兩個變數。少了不會建置失敗，只會讓這一版的同步顯示「尚未開放」。

不想用任何帳號、只想跑完整流程：`node tools/sync-dev.mjs` 加 `SVWB_GOOGLE_BASE=http://127.0.0.1:8788`（假 Google）。

## 6. 對真 Google 驗收

用兩台乾淨的機器（或兩個 userData）：

- [ ] 登入：瀏覽器開出同意畫面，四個範圍都列出來，回跳頁顯示「登入完成」。
      **重點看**：防毒或防火牆會不會擋 loopback，以及 Google 會不會接受任意 port（官方頁面沒寫明）。
- [ ] 同意畫面上取消勾選 Drive → app 顯示「需要允許存取 Google 雲端硬碟的應用程式資料夾」。
- [ ] 重開 app 仍是登入狀態；登出後憑證檔案裡沒有可讀的 token。
- [ ] 第二台登入 → 還原出第一台的資料。
- [ ] 兩台各自編輯 → 互相同步回來。
- [ ] 到 Google 帳號的「第三方存取權」撤銷授權 → app 提示重新登入，本機資料不動。
- [ ] 刪除雲端資料 → Drive 的應用程式資料裡沒有檔案（Drive 設定 → 管理應用程式可以看占用）。
- [ ] Testing 狀態下過 7 天，確認 token 真的失效（驗證第 3 步不是多慮），或直接相信文件，切到 Production。
