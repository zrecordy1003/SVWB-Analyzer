# svwb-sync

SVWB Analyzer 跨裝置同步的 Cloudflare Worker：Google 登入、每裝置 append-only 日誌段落、
帳號配額與退休。一個 Worker、一個 D1、一個 R2 bucket。

HTTP 契約在 `docs/sync-protocol.md`（兩邊都以它為準）；設計理由在 `docs/account-sync-plan.md`。
**與 `server/telemetry` 完全分開**：不同 Worker、不同資料庫、不同網域。telemetry 的說法是「無帳號、
無法回連到個人」，這裡的資料庫恰好是能回連的那一個，共處會讓那句話需要看程式碼才能相信。
install id 永遠不會出現在這裡（`tests/server/sync/segments.test.ts` 會檢查）。

## 結構

| 檔案                | 內容                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `src/index.ts`      | fetch 與 scheduled 入口；唯一讀 `env` 的地方                                  |
| `src/router.ts`     | 路由表、kill switch、限流、錯誤整形                                           |
| `src/auth.ts`       | Google code 交換、id_token 驗證（JWKS + RS256）、grant/PKCE、refresh 輪替、bearer 驗證 |
| `src/jwt.ts`        | base64url、SHA-256、HMAC、HS256 access JWT                                    |
| `src/segments.ts`   | 段落與 snapshot 的讀寫、列表                                                  |
| `src/devices.ts`    | 裝置列表、revoke、logout                                                      |
| `src/account.ts`    | `/v1/me`、刪除帳號、匯出                                                      |
| `src/fold.ts`       | 折疊（純函式）                                                                |
| `src/retire.ts`     | 每日 cron：退休閒置裝置、清理                                                 |
| `src/limits.ts`     | 所有數字與設定解析                                                            |
| `src/types.ts`      | D1 / R2 / fetch 的結構型別                                                    |
| `migrations/`       | D1 schema                                                                     |

核心（除了 `index.ts`）只用 WebCrypto、`fetch`、`Response`，儲存只經 `types.ts` 的結構介面。
所以 app 的根 `pnpm typecheck` 會一起檢查它，而 `tests/server/sync` 用 SQLite 做的 D1、Map 做的
R2、本機產生金鑰的假 Google，在 Node 底下跑**真正的 router**。

```bash
pnpm vitest run tests/server        # 從 repo 根目錄
pnpm typecheck                      # 在這個目錄：用 Workers 型別再檢查一次
```

## 儲存怎麼分

- **R2** 放位元組：`users/{sub}/devices/{device}/{seq:06d}.jsonl` 與 `.../snapshot.jsonl`。
  鍵由伺服器用 token 的 `sub`、token 的 device、驗證過的整數組成，客戶端給不出路徑。
- **D1** 放索引（`segments`、`devices` 的 snapshot 欄位）與帳號、裝置、grant、每日輪數。
  同步一輪的「列出」讀 D1，不呼叫 R2 `list`——後者是 Class A（計量的那種），是成本粗算裡真正的瓶頸。
  R2 `list` 只用在刪除帳號（按前綴清，連同崩潰留下的孤兒物件）。
- **沒有任何二級索引**：D1 的索引寫入也算寫入列，而這個專案的 telemetry 資料庫曾在 91 個安裝時撞到
  免費額度的寫入牆。`lastSeenAt` 只在落後 10 分鐘以上才寫、帳號列只在 email/name 改變才改。

## 部署（維護者手動，順序重要）

1. **建 D1**（APAC）：

   ```bash
   cd server/sync
   pnpm install
   wrangler d1 create svwb-sync --location apac
   ```

   把印出的 `database_id` 填進 `wrangler.toml`（現在是全零的 PLACEHOLDER，故意讓錯誤部署大聲失敗）。

2. **建 R2 bucket**（APAC）。位置提示只能在建立時給，之後不能改，隱私權政策要寫明區域（J-5）：

   ```bash
   wrangler r2 bucket create svwb-sync --location apac
   ```

3. **套 migration**：

   ```bash
   pnpm db:migrate          # = wrangler d1 migrations apply svwb-sync --remote
   ```

4. **Google Cloud Console**（專案裡）：
   - 「API 與服務 → OAuth 同意畫面」：User type 外部；填應用程式名稱、支援信箱、**隱私權政策 URL**
     （必填，且要說明同步會把對局資料上傳到哪個區域）；範圍只加 `openid`、`email`、`profile`
     （非敏感範圍，不需要 Google 的敏感／受限範圍審核）；**發佈狀態設為「正式版」**——測試狀態有
     測試使用者上限，且 refresh 會過期。
   - 「憑證 → 建立憑證 → OAuth 用戶端 ID」：類型 **網頁應用程式**（不是 Desktop）。
     「已授權的重新導向 URI」填 `{Worker 的 origin}/auth/callback`，例如
     `https://sync.svwb-analyzer.workers.dev/auth/callback`。**一字不差**：Worker 用請求自己的
     origin 組 `redirect_uri`，與這裡不同 Google 就拒絕。換網域時兩邊要一起改。
   - 記下 Client ID 與 Client secret。

5. **三個 secret**（不放 `wrangler.toml`）：

   ```bash
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put SESSION_SECRET      # 至少 32 個隨機位元組，例如 `openssl rand -base64 48`
   ```

   `SESSION_SECRET` 簽 access JWT 與 OAuth `state`。換掉它會讓所有已發的 access token 驗不過；客戶端
   把這當成憑證失效、要求重新登入（refresh 在 D1 是雜湊、不受影響，但客戶端沒機會用到）。換之前先想好。

6. **部署**：`pnpm deploy`（`wrangler deploy`）。部署後：
   - `curl {origin}/health` 應回 `{"ok":true}`；
   - 在瀏覽器開 `{origin}/auth/start?port=48151&challenge=<43 字元 base64url>&state=x`，應轉到
     Google 同意畫面（沒設好 secret 會回 500 `misconfigured`）。
   - 把網址寫進 app 端的設定（`src/main/sync/` 的 config）。**網址會編進安裝檔**：定案後不要再改
     （telemetry 同樣的教訓）。

## 本機開發

```bash
cd server/sync
pnpm install
pnpm db:migrate:local                  # wrangler d1 migrations apply svwb-sync --local
printf 'GOOGLE_CLIENT_ID=...\nGOOGLE_CLIENT_SECRET=...\nSESSION_SECRET=dev-only-secret-dev-only-secret-0000\n' > .dev.vars
pnpm dev                               # wrangler dev --local，預設 http://127.0.0.1:8787
```

本機要走完整登入，Google 用戶端需另加 `http://127.0.0.1:8787/auth/callback` 為重新導向 URI
（Google 允許 loopback 的 http）。不碰 Google 的部分（段落、配額、限流……）直接看
`tests/server/sync`，那裡用假 Google 跑完整流程。`.dev.vars` 不要 commit。

## 營運旋鈕（`wrangler.toml` 的 `[vars]`，改完 `wrangler deploy`，或在 Dashboard 改）

| 變數             | 預設        | 意義                                                              |
| ---------------- | ----------- | ----------------------------------------------------------------- |
| `QUOTA_BYTES`    | `104857600` | 每帳號儲存上限；超過推送回 413 `quota`                            |
| `ROUNDS_PER_DAY` | `200`       | 每帳號每個 UTC 日的同步輪數（`GET /v1/segments`）；超過 429       |
| `MAX_DEVICES`    | `0`         | 每帳號活躍裝置硬上限；0 = 不限（J-2：預設不設，保留開關）         |
| `KILL_SWITCH`    | `0`         | `1` 時除 `/auth/*`、`/v1/auth/*`、`/health` 外一律 503 + `Retry-After: 3600` |

格式錯誤的值退回預設而不是整個 Worker 壞掉。

限流（`[[unsafe.bindings]]`，沿用 telemetry 的形狀）全部**選用且 fail-open**：`IP_LIMITER`
（每 IP 120/分）、`AUTH_IP_LIMITER`（登入路徑每 IP 20/分）、`ACCOUNT_LIMITER`（每帳號 60/分）。
binding 改名或壞掉時放行，而不是讓所有人的同步停擺。

## Cron（每日 04:17 UTC）

- 90 天沒有 `lastPushAt`（沒推過則看 `createdAt`；裝置復活後從 `revivedAt` 重新起算）的裝置：
  把它的 snapshot 與段落折成一份新 snapshot（同一 `(tbl, uid)` 留 `ts` 最大者，同 `ts` 留後出現者）、
  刪段落、標 `retiredAt`。它仍在 `GET /v1/segments` 裡（`retired: true`），所以新裝置拿得到。
- 每次執行最多花 40 次 R2/D1 呼叫（免費方案每次 invocation 的 subrequest 上限是 50），多的留給明天；
  單一裝置大到一次折不完時，只標退休、不折疊（段落原樣保留、照樣可下載）。
- 順手清過期的 grant 與三天前的每日計數。

## 成本備註（2026-09 的理解，實作前再核對當期免費額度）

- **R2 Class A（寫入／list）是真正的瓶頸**，不是儲存量。一輪同步 = 0 次 R2 list（索引在 D1）+
  N 次 GET（Class B，便宜）+ 每個新段落 1 次 PUT。所以**同步不能輪詢**：app 的時機是啟動後一次、
  對局結束去抖 60 秒、手動、每小時上限一次。每 5 分鐘輪詢會爆。
- **D1 寫入**：登入一次幾列；每個新段落一列 + 一次裝置列更新；每輪同步一次每日計數更新。
  不為了「最後上線時間」逐請求寫入。
- **Workers 請求**（免費 10 萬／天）：5 台 × 每天 6 輪 ≈ 150 次／天／帳號。濫用靠的是
  `ROUNDS_PER_DAY`、`QUOTA_BYTES`、90 天退休，這三個數字要被監控，不能只寫在文件裡。
- 段落下載由 Worker 以 R2 binding 代理（J-3）；真的撞到請求數上限再換預簽 URL。

## 已知取捨

- **refresh 重放即撤銷**：出示前一把 refresh token 會撤銷該裝置（視為被複製）。代價是「回應遺失」
  這種良性情況也會要求重新登入；換到的是被偷的 token 只有一次窗口。
- **配額是 D1 的計數器**，與 R2 的實際位元組在崩潰時可能有細微偏差（崩潰留下的孤兒物件不計入，
  刪除帳號時按前綴一併清掉）。
- 同一 `seq` 並行推送不同內容時，勝者以 D1 的 `INSERT OR IGNORE` 決定；R2 物件先被索引再寫入，
  所以有毫秒級的窗口列表看得到而下載 404（客戶端重試即可）。
