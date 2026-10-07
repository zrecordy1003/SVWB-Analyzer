# 同步協定（客戶端 ↔ `server/sync` Worker）

`docs/account-sync-plan.md` 的實作契約。**兩邊都以這份為準**；改這裡就要同時改
`src/main/sync/protocol.ts`（客戶端常數與型別）與 `server/sync/src/`。

## 通則

- 全部 JSON（UTF-8），除了段落本體（`application/x-ndjson`）。
- 錯誤一律 `{ "error": "<code>", "message": "<人話>" }`，HTTP 狀態碼承載語意：
  - `401 expired`：access token 過期，客戶端用 refresh 換新後重試一次。
  - `401 revoked` / `401 retired` / `401 unknown_device`：refresh 也不行，客戶端清掉憑證、提示重新登入。
  - `403 forbidden`、`404 not_found`、`409 conflict`、`413 quota`（帳號超過 100 MB）、
    `413 too_large`（單段超過 1 MB）、`422 invalid`、
  - `429 rate_limited`（帶 `Retry-After`），
  - `503 unavailable`（kill switch，帶 `Retry-After`）：客戶端安靜退開，一切照常。
- 除 `/auth/*` 與 `POST /v1/auth/token|refresh` 外，每個請求都要 `Authorization: Bearer <access JWT>`。
  `sub` 只從 token 取，**絕不從請求體取**。
- **install id（telemetry）永遠不會出現在這裡**，反之亦然。

## 身分

Worker 中介的 authorization code + PKCE（app 不接觸 Google 的 secret）。

```text
GET  /auth/start?port=<1024-65535>&challenge=<base64url(sha256(verifier))>&state=<≤64 字元>
       → 302 Google 同意畫面（redirect_uri = {origin}/auth/callback，scope = openid email profile）
GET  /auth/callback?code=…&state=…        （Google 回跳；Worker 內換 id_token、驗 iss/aud/exp/email_verified/簽章）
       → 302 http://127.0.0.1:{port}/cb?grant=<一次性>&state=<原樣>
         失敗： http://127.0.0.1:{port}/cb?error=<code>&state=<原樣>
POST /v1/auth/token    { grant, verifier, deviceId, deviceName, appVersion }
       → { accessToken, accessExpiresAt, refreshToken, account: { email, name|null }, deviceId }
POST /v1/auth/refresh  { refreshToken, deviceId }
       → { accessToken, accessExpiresAt, refreshToken }      （refresh 每次輪替）
POST /v1/auth/logout   （bearer）→ 204；撤銷這台裝置的 refresh
```

- `grant`：一次性、5 分鐘、綁 `challenge`；`/token` 驗 `sha256(verifier) == challenge`。
- 帳號鍵 = Google `sub`。email 只用於顯示。
- access = HS256 JWT（15 分鐘），claims：`sub`、`did`（device id）、`exp`。refresh = 隨機 32 bytes，
  D1 只存雜湊。裝置以 `deviceId`（客戶端產生，存 `SyncState`）註冊；被 retire 的裝置再次 `/token` 會復活。

## 帳號與裝置

```text
GET  /v1/me                → { email, name|null, bytesUsed, quotaBytes, activeDevices, syncRoundsToday, roundsPerDay }
GET  /v1/devices           → { devices: [{ id, name, appVersion, lastSeenAt, lastPushAt|null, active, self }] }
POST /v1/devices/{id}/revoke → 204        （撤 refresh，不得再推送；可撤自己以外的任何裝置）
POST /v1/account/delete    → 204          （整個 users/{sub}/ 前綴 + D1 列 + 所有 token）
GET  /v1/account/export    → application/x-ndjson，所有裝置的 snapshot 與段落依序串接（每段自帶標頭行）
```

## 段落

R2 鍵：`users/{sub}/devices/{device}/{seq:06d}.jsonl`、`users/{sub}/devices/{device}/snapshot.jsonl`。
**每個裝置只寫自己的前綴**；客戶端不能指定路徑，只給 `seq`。

```text
GET  /v1/segments
       → { devices: [{ device, retired, schemaVersion|null,
                       snapshot: { upToSeq, bytes } | null,
                       segments: [{ seq, bytes }] }] }
       只列「其他」裝置；`segments` 不含已被 snapshot 涵蓋的（seq ≤ upToSeq）。
       計入「同步輪數」（每帳號每天 `roundsPerDay`，預設 200），超過回 429。
PUT  /v1/segments/{seq}      body = JSONL（≤ 1 MB），Header: X-Content-SHA256: <hex>
       → { bytesUsed }       同 seq 已存在且雜湊相同 → 200 冪等；不同 → 409。超配額 → 413。
PUT  /v1/snapshot?upToSeq=N  body = JSONL（≤ 8 MB）
       → { bytesUsed }       取代自己的 snapshot，並刪掉自己 seq ≤ N 的段落。
GET  /v1/segments/{device}/{seq}   → 段落本體（串流；Worker 以 R2 binding 代理，不發預簽 URL）
GET  /v1/snapshots/{device}        → snapshot 本體
```

- 讀取時 `device` 必須屬於同一個 `sub`，否則 404。
- 寫入會更新該裝置的 `lastPushAt`；任何已驗證請求更新 `lastSeenAt`。

## 段落格式（伺服器除了折疊之外不解讀它）

```jsonl
{"v":1,"schemaVersion":18,"device":"d-…","seq":17,"hlc":1757203200123}
{"tbl":"Match","uid":"a1b2…","op":"upsert","ts":1757203200124,"row":{…},"tagUids":["t1"]}
{"tbl":"Tag","uid":"t9…","op":"delete","ts":1757203200125}
```

第一行標頭，其餘一行一列變更。壞掉的最後一行可丟棄。伺服器只在**折疊**（cron 退休裝置）時
解析各行的 `tbl`、`uid`、`ts`：同一 `(tbl, uid)` 保留 `ts` 最大的一行（`ts` 相同保留後出現者）。

## 營運

- 每帳號 100 MB 儲存配額、每天 200 輪同步、per-IP 限流；全部是伺服器端政策，環境變數可調
  （`QUOTA_BYTES`、`ROUNDS_PER_DAY`、`MAX_DEVICES`，後者預設 0 = 不限）。
- `KILL_SWITCH=1`：除 `/auth/*` 之外一律 `503` + `Retry-After: 3600`。
- cron（每日 04:17 UTC）：90 天沒有 `lastPushAt`（沒推過則看 `createdAt`）的裝置 → 把它的 snapshot 與
  段落折成一份新 snapshot（`upToSeq` = 其最大 seq）、刪段落、標 `retiredAt`、撤 refresh。
  折疊後該裝置仍在 `/v1/segments` 裡（`retired: true`、無段落、一份 snapshot），所以新裝置拿得到它的資料。
- 資料區域 APAC（R2 location hint `apac`）。
