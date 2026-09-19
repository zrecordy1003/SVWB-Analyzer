# 計畫：Google 登入與跨裝置同步

Last updated: 2026-09-07（初版；同日敲定文末 J-1～J-6，其中 J-1 與 J-2 推翻了初稿的傾向）

本文件是「多台 PC 用同一個帳號看同一份資料」這件事的唯一計畫來源。相關文件：
`docs/architecture.md`（現行架構）、`docs/telemetry-dau-plan.md`（匿名統計，本計畫**不得**與其
共用識別碼）、`docs/deck-versioning-plan.md`（Deck 是不可變卡表 + `familyId`，同步規則直接繼承
它的語意）、`docs/meta-stats-plan.md`。

> 狀態：**規劃中**。所有 SQL、端點與檔名都是提案，未落地。文末的判斷題 J-1～J-6 已敲定，
> **J-7（對手名牌要不要同步）未決，且必須在階段 2 動工前決定**；
> 決定與理由記在那一節；本文其他章節已依那些決定改過。

## 決定前提（已確認）

- 讀取端是**另一台裝了 app 的 Windows PC**。不做 web 前端，因此伺服器**不需要**能查詢資料，
  這是本計畫最大的簡化，也是下面選 R2 而不是 D1 的唯一理由。
- **雙向**：任何一台都可能錄對局、也可能編輯牌組與備註。不能用「一台發佈、其他唯讀」的整檔覆蓋。
- 同步範圍：`Match`、`MatchTag`、`Deck`、`DeckCard`、`Tag`、`DeckCategory`。
  **不同步** `electron-store` 設定（HUD 位置跨機同步是反效果）、`Card` / `CardPool`（公開資料，
  每台自己抓）、`TelemetryState`（install id 跨機同步會讓一台機器被算兩次，是 bug 不是功能）。
  **`Match.oppo_name_crop` 的處置尚未決定，見 J-7**——它是 2026-09-07 加進 `Match` 的新欄位，
  而且是這份範圍裡唯一的第三方個資。

## 非目標

- 不做即時協作、不做多人共享牌組、不做行動版。
- 不做「雲端是唯一真相」。app 離線必須完全可用，同步失敗只能寫進狀態列，不能擋 UI、不能擋引擎。
  這條和 `telemetry.ts` 的第二條規則同源。
- 不做伺服器端統計。統計永遠在本機算，因為本機已經有全量資料。

## 五個真正的難點

同步這件事的工作量不在「上傳下載」，在下面五條。每一條都是既有設計選擇的直接後果。

### 1. 主鍵是 `INTEGER AUTOINCREMENT`

`Match`、`Deck`、`Tag` 的 `id` 是自增整數（`001_init.sql`），兩台機器一定會各自產生 `id = 1..N`。
整數 id 不能當跨裝置身分，但**也不能改成 UUID 主鍵**：`idx_match_playedAt_id` 的 keyset 分頁、
牌組版本化「以 `id` 排序」的規則（`deck-versioning-plan.md`）、`familyId = id` 的回填，全都建立在
「id 是單調整數」上。改 PK 會動到所有 IPC handler 與引擎的 `store.rs`。

**結論**：新增一個 `uid TEXT UNIQUE` 全域識別碼，整數 `id` 保持原樣、降級為「本機代理鍵」。
同步協定只說 `uid`，套用時在邊界翻譯 `uid ↔ id`。既有的每一行查詢都不用改。

### 2. 對局列是 Rust 引擎寫的，繞過所有 TypeScript

`svwb-engine` 直接寫 SQLite。任何寫在 `src/main/` 的變更追蹤都看不到引擎的 INSERT/UPDATE。

**結論**：變更追蹤用 **SQLite 觸發器**，不用應用層攔截。觸發器是唯一同時看得到引擎與 UI 兩邊
寫入的位置。引擎那側只需要一個改動：INSERT 時填 `uid`（`uuid` crate，`store.rs`）。

注意記帳：牌組刪除時 `Match.my_deckId` 的 `ON DELETE SET NULL` **會觸發** UPDATE 觸發器。
那確實是一筆該同步的變更（對局的牌組欄位真的變了），所以不是 bug——但它是「一個刪除動作產生
N+1 筆 outbox」的來源，壓測時要看得到。

### 3. `Tag.name` 與 `DeckCategory.name` 有 UNIQUE

兩台機器各自建了標籤「先手練習」，uid 不同、name 相同。套用遠端那筆會撞 UNIQUE。

**結論**：對這兩張「以名字為自然鍵」的表，合併規則是**依 name 去重**，勝者取 uid 較小者
（字典序）。兩台各自算都會得到同一個勝者，不需要伺服器參與。敗者的 uid 進 `SyncAlias`，
`MatchTag` 的引用改指勝者。這是整個計畫裡唯一需要「重寫外部引用」的合併。

### 4. 兩台 app 的 schema 版本會不一致

`resources/migrations/` 是唯一真相，但兩台機器的版本號可能差一次更新。舊版讀到新版寫的
列（多了欄位、或欄位語意變了）就是資料損壞。

**結論**：每一段日誌都帶 `schemaVersion`（= 已套用的最大 migration 編號）。
**讀取端閘門**：看到高於自己的版本就停止套用該段、在 UI 說「另一台裝置版本較新，請更新」，
並且**不推進**那段的游標，更新後自然接上。寫入不受限——舊版可以繼續推自己的資料。
這條沒做，階段 3 上線第一次發版就會出事。

### 5. 隱私立場整個翻轉

現在的公開承諾是「不送帳號、不送備註、不送牌組名稱、不送時間戳」（`telemetry-dau-plan.md`）。
本計畫要送的**正好是那一整份清單**，而且綁在一個 Google 帳號上。這不再是匿名統計，是託管
使用者的個人資料。

**結論**：這是產品決定不是技術決定，必須明確承受：

- **只能 opt-in**，永遠不預設開啟（和 telemetry 的 default-on 決定相反，理由不同：那邊送計數，
  這邊送內容）。
- 需要隱私權政策與服務條款頁面——**這也是 Google 同意畫面的必填欄位**，是階段 1 的硬前提。
- 需要「刪除帳號與所有雲端資料」與「匯出」，而且要能在 app 內按到。
- **install id 與 Google `sub` 永遠不得出現在同一個請求、同一張表、同一份日誌**。兩個系統之間
  沒有 join key，是刻意的。

## 身分：Google 登入

### 流程（提案）

用 **Worker 中介的 authorization code + PKCE**，不在 app 內做 code exchange：

```text
app                      系統瀏覽器                 Worker                    Google
 │ 起一個 127.0.0.1 的
 │ 一次性 loopback 監聽
 │ shell.openExternal ─────► /auth/start?cb=127.0.0.1:PORT&challenge=…
 │                                          │ 302 ─────────────────────────► 同意畫面
 │                                          │ ◄──── code ────────────────────┘
 │                                          │ code+secret 換 id_token（在 Worker 內）
 │                                          │ 驗 iss/aud/exp/email_verified（JWKS）
 │                                          │ 發自己的 session：
 │ ◄──── 302 到 127.0.0.1:PORT/cb?… ────────┘   refresh(長期) + access(短期 JWT)
 │ 關掉監聽，token 進 safeStorage
```

為什麼不是 app 直接對 Google 換 token（Desktop client + PKCE，較常見的做法）：

- Google 的 client secret 會被打包進每一份安裝檔。native app 的 secret 名義上「不算機密」，
  但它仍是我們專案的憑證，被拿去做釣魚同意畫面時擦不掉。放 Worker secret 只有我們有。
- 換 IdP（未來加 Discord／Apple）不必發新版 app。`telemetry/config.ts` 的教訓：**編進安裝檔的
  東西改不了**，已安裝的舊版只會對它建置時的那個值說話。身分提供者不該有這個性質。
- 代價：Worker 多兩個端點，且 loopback 回跳要處理使用者中途關瀏覽器（超時 + 可重試）。

其他被否決的：**嵌入式 BrowserWindow 裝載 Google 登入頁**——Google 封鎖 embedded webview
的 OAuth，且我們的 window 政策是 `sandbox: true` + 只放行 https 外開（`app:openLink`），
把登入頁請進來會拆掉那道牆。**貼一次性代碼**（device code 風格）只當 loopback 失敗的回退，
不當主路徑。

### 存哪裡

- refresh token → **`safeStorage`（Windows DPAPI）加密後寫 `userData` 下的獨立檔案**。
  - 不放 `config.json`：`settings:clear` 會清掉它（登出是這個的正確行為，但不該是意外行為）。
  - **不放同步的 SQLite**：那份資料庫會被上傳，憑證絕不能在裡面。這條要寫成測試。
  - `safeStorage.isEncryptionAvailable()` 為 false 時（罕見）：不落地、只保留記憶體內 session，
    UI 說明重開需重新登入。不接受明文落地。
- access token 只在記憶體，過期就用 refresh 換。
- 帳號鍵是 Google `sub`，**不是 email**。email 會變，`sub` 不變。email 只用來在 UI 顯示登入者。

### 範圍與審核

只要 `openid email profile`（非敏感範圍），不需要 Google 的敏感／受限範圍審核。仍然需要：
填好品牌資訊與**隱私權政策 URL**、發佈狀態設為「生產」（測試狀態有測試使用者上限）。
實作前再核對一次 Google 當期的政策文字，這段是 2026-09 的理解。

## 同步模型：uid + 觸發器 outbox + 每裝置 append-only 日誌

### 形狀

```text
本機 SQLite                                R2（每個帳號一個前綴）
  Match/Deck/Tag（+uid）                     users/{sub}/devices/{devA}/000017.jsonl
      │ 觸發器                                users/{sub}/devices/{devA}/snapshot.jsonl
      ▼                                      users/{sub}/devices/{devB}/000004.jsonl
  SyncOutbox（誰髒了）                        …
      │ push：讀出當前列 → 一段 JSONL          D1（只有帳號與裝置註冊表、游標；列數有界）
      ▼
  SyncRowMeta（每列的 HLC 時戳與來源裝置）  ◄── pull：列出他人前綴的新段落 → 合併
```

- **每個裝置只寫自己的前綴**，永遠 append。沒有兩個寫入者碰同一個物件，所以伺服器端不需要鎖、
  不需要合併邏輯、不會有半套用狀態。合併全部發生在客戶端，而客戶端本來就有全量資料。
- **合併規則是 per-row LWW**，時戳用 HLC（`max(本機時鐘, 見過的最大時戳+1)`），平手時比裝置 id。
  純函式 `mergeRow(local, remote) -> keep | replace | alias`，這是本計畫最該被單元測試釘死的地方。
- 對局列實務上幾乎不衝突（一場遊戲只有一台機器錄到），牌組因為版本化是 append-only 的
  （編輯打過的牌組會 fork 新列），也幾乎不衝突。真正會衝突的是改名、刪除、`isDefault`。

### 為什麼不是別的

| 方案                                     | 否決理由                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 逐列同步                              | 伺服器不需要查詢能力（前提 1），付這個代價買不到東西。而且 D1 免費層按**寫入列數**計，`d1-free-tier-write-wall` 那次就是寫入放大炸的；同步的寫入量是 telemetry 的數十倍。 |
| 整份 DB 檔案 last-writer-wins（R2 單物件） | 雙向前提直接否決：兩台都在錄，覆蓋等於刪掉另一台今天的對局。                                                                                                          |
| 伺服器權威 DB（app 走遠端查詢）           | 離線可用是硬需求；而且 `remoteDriver.ts` 的序列化假設（單一同步 handle）在網路延遲下會變成 UI 卡頓。                                                                    |
| SQLite session extension / WAL 複寫       | 兩台各自有本機寫入，不是主從關係。而且引擎與 UI 共用檔案，WAL 層的複寫會把引擎的寫入也當成位元組來複製，衝突無法在領域層解釋。                                          |
| Google Drive appDataFolder 當儲存         | 省掉伺服器，但配額與速率由使用者的 Drive 決定、除錯時我們看不到任何東西、也拿不到「有幾個人在用同步」的健康指標。列為備案。                                              |

### Schema 變更（提案 `015_add_sync_ids.sql` / `016_add_sync_tables.sql`）

> 編號原本是 013／014，一路被先落地的東西擠：`013_add_oppo_name_crop.sql`（對手名牌）與
> `014_add_opening_hand.sql`（起手手牌）。提案永遠讓路給已經進版的。

拆兩個 migration：uid 是**領域表**的欄位、引擎也要寫；同步帳本是**同步自己的**表，引擎不碰。

```sql
-- 015：全域識別碼。刻意不加 DEFAULT：
-- 讓「忘記填 uid 的寫入路徑」在測試裡就爆，而不是靜靜產生一列同步不到的資料。
ALTER TABLE "Match" ADD COLUMN "uid" TEXT;
ALTER TABLE "Deck"  ADD COLUMN "uid" TEXT;
ALTER TABLE "Tag"   ADD COLUMN "uid" TEXT;
UPDATE "Match" SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;  -- 同理 Deck / Tag
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_uid ON "Match"(uid);
```

- `DeckCategory.id` **已經**是全域唯一的隨機字串（`newCategoryId()`：`c` + base36 時間 + 20 個
  亂數字元），不需要 uid 欄位，它自己就是。三個內建分類（`aggro`/`midrange`/`control`）在每台
  機器上 id 相同，合併時天然對齊——這是既有設計送的禮物。
- `MatchTag` / `DeckCard` 是複合鍵的關聯表，**不給 uid**：它們作為父列的子集合同步
  （一筆 Match 的 entry 帶 `tagUids: []`，一筆 Deck 帶 `cards: []`），整組覆蓋。
  好處是關聯表不需要墓碑。
- `Deck.familyId` 是 `Deck.id`（整數）→ 日誌裡寫 `familyUid`，套用時翻譯。
  `Match.my_deckId` / `oppo_deckId` 同理。

```sql
-- 015：同步帳本。全部是同步自己的表，引擎不讀不寫。
CREATE TABLE IF NOT EXISTS "SyncState"   ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS "SyncOutbox"  ("tbl" TEXT NOT NULL, "uid" TEXT NOT NULL, "op" TEXT NOT NULL, "changedAt" INTEGER NOT NULL, PRIMARY KEY ("tbl","uid"));
CREATE TABLE IF NOT EXISTS "SyncRowMeta" ("tbl" TEXT NOT NULL, "uid" TEXT NOT NULL, "ts" INTEGER NOT NULL, "device" TEXT NOT NULL, "deletedAt" INTEGER, PRIMARY KEY ("tbl","uid"));
CREATE TABLE IF NOT EXISTS "SyncAlias"   ("tbl" TEXT NOT NULL, "fromUid" TEXT NOT NULL, "toUid" TEXT NOT NULL, PRIMARY KEY ("tbl","fromUid"));
CREATE TABLE IF NOT EXISTS "SyncSuppress"("one" INTEGER PRIMARY KEY CHECK ("one" = 1));

-- 觸發器（每張表三個：AI / AU / AD），刪除那個就是墓碑：
CREATE TRIGGER IF NOT EXISTS sync_match_ad AFTER DELETE ON "Match"
WHEN NOT EXISTS (SELECT 1 FROM "SyncSuppress") BEGIN
  INSERT INTO "SyncOutbox"("tbl","uid","op","changedAt")
  VALUES ('Match', OLD."uid", 'delete', CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT("tbl","uid") DO UPDATE SET "op" = 'delete', "changedAt" = excluded."changedAt";
END;
```

`SyncSuppress` 是「現在正在套用遠端變更，別記帳」的旗標：套用交易一開始插入那一列，
提交前刪掉。**為什麼夠**：WAL 只允許一個寫入者，所以引擎的 INSERT 不可能夾在我們的
`BEGIN IMMEDIATE` 中間執行——它會等（或拿到 `SQLITE_BUSY` 後重試），觸發器在旗標消失之後才跑。
前提是套用**必須是單一 `BEGIN IMMEDIATE` 交易**；拆成多筆小交易就會漏掉引擎的變更。這條要有測試。

### 日誌段落格式（提案）

```jsonl
{"v":1,"schemaVersion":14,"device":"d-7f3…","seq":17,"hlc":1757203200123}
{"tbl":"Match","uid":"a1b2…","op":"upsert","ts":1757203200124,"row":{},"tagUids":["t1","t2"]}
{"tbl":"Tag","uid":"t9…","op":"delete","ts":1757203200125}
```

- 第一行是段落標頭，其餘一行一列變更。JSONL 因為可以串流附加，壞掉的最後一行可以丟掉而不影響前面。
- 段落大小上限（如 512 KB 或 1000 列，取先到者），滿了就開新的 `seq`。
- **壓實**：段落數超過門檻（如 200）時，該裝置把自己的歷史合成一份 `snapshot.jsonl` 並刪掉舊段落。
  新裝置首次同步只讀每個裝置的 snapshot + 之後的段落，不必讀完整歷史。

### 衝突規則表

| 情境                                            | 規則                                                    | 理由                                                             |
| ----------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| 同一筆 Match 兩邊都編輯                          | LWW（HLC），欄位不細分                                   | 只有備註／牌組／標籤會被手改，整列覆蓋的損失有界且可解釋           |
| 一邊刪除、一邊編輯                               | **刪除勝**（若刪除 ts 較新）                             | 「我刪了它又出現」比「我的編輯沒了」更難信任                       |
| 兩邊建同名 Tag/Category                          | uid 小者勝，敗者進 `SyncAlias`，`MatchTag` 改指           | UNIQUE 約束（難點 3）；規則可各自獨立算出同一結果                  |
| 兩邊改同一 Tag 名稱                              | LWW                                                     | —                                                                |
| 兩邊各自 fork 同一牌組                           | 兩個新版本都保留                                         | 版本化本來就是 append-only，合併不該猜哪一份才算                   |
| `isDefault` 兩邊都設                             | LWW，套用後跑一次「同職業只能有一個預設」的收斂           | 這個約束在應用層（`decks.ts`）不在 schema，合併後必須重跑          |
| 遠端 `schemaVersion` 較高                        | 拒絕套用該段、不推進游標、提示更新                       | 難點 4                                                           |
| 遠端列引用了本機還沒有的父列（未知 `deckUid`）    | 套用該列、外鍵留 NULL，記進待補；父列到齊後再修           | 段落按裝置分開拉，順序不保證                                       |

## 伺服器（`server/sync/`，與 telemetry 分開部署）

分開的 Worker、分開的資料庫、分開的網域。理由不是架構潔癖：telemetry 必須維持
「無帳號、無法回連到個人」的說法，兩者共處一個 Worker 會讓那句話變成需要看程式碼才能相信。

| 端點                                       | 用途                                                            |
| ------------------------------------------ | --------------------------------------------------------------- |
| `POST /v1/auth/start`、`GET /v1/auth/callback` | 上面的登入流程                                              |
| `POST /v1/auth/refresh`                    | 換 access token                                                 |
| `POST /v1/auth/logout`                     | 撤銷這台裝置的 refresh token                                     |
| `POST /v1/devices/register`                | 註冊裝置 id 與名稱                                              |
| `GET /v1/devices`                          | 裝置清單（名稱、上次同步、活躍與否），UI 要能列出來               |
| `POST /v1/devices/{id}/revoke`             | 撤銷某台裝置：撤 refresh token，該裝置不得再推送（賣掉的電腦）     |
| `GET /v1/segments?since=…`                 | 列出本帳號**活躍**裝置的段落清單（R2 list，過濾掉自己與已退休的）  |
| `PUT /v1/segments/{seq}`                   | 上傳自己的段落（物件鍵由 Worker 決定，客戶端不能指定路徑）        |
| `GET /v1/segments/{device}/{seq}`          | 下載一段，Worker 以 R2 binding 串流（J-3：不發預簽 URL）          |
| `POST /v1/account/delete`                  | 刪掉整個 `users/{sub}/` 前綴與 D1 列，並撤銷所有 token            |
| `GET /v1/account/export`                   | 打包下載（可以就是所有段落的 zip）                                |

- 資料區域：**APAC**（J-5）。R2 的位置提示一旦建立就固定，隱私權政策要明白寫出存放區域。
- 每個請求都驗自己發的 access JWT；`sub` 從 token 來，**絕不從請求體來**。
- 限流沿用 telemetry 的形狀（`unsafe.bindings` ratelimit）：per-account 上傳、per-IP、per-account 下載。
- **成本天花板不是裝置數，是這三個數字**（J-2）：每帳號每天同步輪數上限（提案 200）、
  每帳號 100 MB 儲存配額（超過回 413 並在 UI 說明）、90 天閒置裝置自動退休。
  這三個都是伺服器端政策，可以不發版就調整——硬性裝置上限也保留為同一種開關，預設關閉。
- 這些數字必須有監控（階段 4 的健康指標），否則它們只是文件裡的字。
- **Kill switch**：Worker 回 503 + `Retry-After` 時，客戶端安靜退開並照常運作。要有測試。

### 成本粗算（實作前重新核對當期免費額度）

- R2：儲存以「每帳號幾 MB」計，1000 個帳號約 GB 級，落在免費 10 GB 內；Class A（寫／列出）
  的免費額度才是**真正的瓶頸**。每次同步 = 1 次 list + N 次 GET（Class B，便宜）+ 1 次 PUT。
  1000 帳號 × 每天 6 次同步 × 2 次 Class A ≈ 36 萬次／月，可以。**每 5 分鐘輪詢就會爆。**
- Workers 請求的免費額度（每天 10 萬次）同樣禁不起定時輪詢。
- 所以同步時機**不是輪詢**：啟動後一次、對局結束後去抖 60 秒、UI 手動、每小時上限一次。
  這和 `telemetry.ts` 的排程理由一樣，但這裡它同時是成本上限。

## ⚠ 開工前必須先擋掉：本機測試資料會跟著同步上去

`tools/seed-opening-demo.mjs` 會寫 1758 場假對局，標記是 `Match.source = 'demo-seed'`。
telemetry 那條路已經擋住了（`rollup.ts` 的 `classifyRow` 對未知 `source` 一律回 `invalid`，
並有回歸測試釘住），**但這份計畫的階段 2 沒有擋。**

觸發器 outbox 同步的是**整張 `Match` 表**，而這份文件從頭到尾沒有提過 `source`；
J-6 還明確否決了「只同步一部分」。也就是說**階段 2 一上線，假資料就會跟著上雲端**，
而且是以「使用者真實對局」的身分。

這已經真的發生過一次：同一批假資料透過 telemetry 上傳，10 場捏造的 ranked 對局進了公開的
meta 文件（2026-09-17，已修並已對帳清除）。第二次不該再用同樣的方式發現。

**所以階段 2 動工前要先決定**：是在觸發器層就排除 `source = 'demo-seed'`（那是 J-6 的一個
明確例外，要寫下來），還是把 seeder 改成寫進另一個資料庫檔。兩條都行，不能兩條都不做。

順帶兩個小的（不是資料外洩，但會被假資料影響）：

- `src/main/support/supportPrompt.ts` 數 `Match` 沒有濾 `source`，種完假資料會提早觸發
  「打滿 100 場」的贊助提示。純顯示，不外傳。
- `src/main/ipc/decks.ts` 的牌組發佈沒有濾 `Deck.sourceRef`，所以 `[demo]` 開頭的示範牌組
  **可以被發佈到官方 portal**。需要使用者自己按下發佈才會發生，但那是一列種出來的資料
  離開這台機器。

---

## 失效模式（要先想好 UI 怎麼說）

- 沒網路／Worker 掛掉 → 狀態列顯示「上次同步：…」，其他一切照常。
- token 失效（使用者在 Google 撤銷授權）→ 提示重新登入，本機資料完全不動。
- 兩台版本不一致 → 難點 4 的提示，並且明確說「你的資料沒有遺失」。
- 合併把資料弄壞 → **每次套用遠端變更前，先複製一份本機 DB 到 `userData/sync-backup/`**
  （保留最近 3 份）。階段 3 上線初期這是唯一能救回來的東西，不是可選項。

## 階段切分

每個階段都能單獨發版，而且前一階段不完成不能開始下一階段。

**階段 0：前提（沒有使用者可見變化）**

- `015` uid 欄位 + 回填；引擎 `store.rs` INSERT 時填 uid；`ipc/decks.ts`、`ipc/tags.ts` 建立時填 uid。
- 隱私權政策與服務條款頁面上線（Google 同意畫面的必填欄位）。
- Google Cloud 專案、OAuth client、同意畫面設定。
- 驗收：既有測試全綠；`SELECT count(*) FROM Match WHERE uid IS NULL` 為 0；
  跑一場真實對局後新列有 uid。

**階段 1：只有登入，還沒有同步**

- `server/sync/` 的 `/v1/auth/*` + 裝置註冊；app 的登入／登出 UI 與 `safeStorage`。
- 設定頁顯示「已登入為 …（同步尚未啟用）」。
- 驗收：真實 Google 帳號在乾淨機器上登入、重開仍在、登出後檔案裡沒有可讀憑證。
  這階段的價值是把 OAuth 的現實問題（防毒攔 loopback、瀏覽器預設值、企業帳號）在還沒有資料
  風險的時候撞完。

**階段 2：單向備份（只推不拉）**

- `016` 同步帳本 + 觸發器；outbox → 段落 → PUT；壓實。
- UI：手動「立即備份」、上次備份時間、雲端用量、裝置清單（`GET /v1/devices`）與撤銷。
- 「還原到空資料庫」（新機器首次登入且本機沒有對局時直接套用全部段落——這條路徑沒有合併），
  結束時觸發一次 `cards:syncPool`（J-4）。
- 驗收：A 機錄 20 場 → B 機（空的）還原後，兩邊統計數字逐格相同，且牌組頁有卡名與卡圖。

**階段 3：雙向合併**

- pull + `mergeRow` + `SyncAlias` + 抑制旗標 + 套用前備份 + schemaVersion 閘門。
- 首次登入且本機已有對局時的「合併／以雲端為準」對話，以及「回到合併前」（J-1）。
- UI：同步狀態；衝突不需要使用者介入（規則已定），但要有「這次合併套用了 N 筆變更」的紀錄。
- 驗收：兩台各錄各改的情境表全部通過，且**任一台重跑同步都不會再改變任何東西**
  （收斂性：同步兩次的結果等於同步一次）。

**階段 4：帳號生命週期與營運**

- 刪除帳號／匯出；配額與每日輪數限流；90 天閒置裝置退休的 cron 與段落封存折疊（J-2）；
  kill switch；同步健康度指標（只送成功率、延遲、活躍裝置數分佈，不送內容，
  且**不帶** install id）。

## 測試策略

- **純函式優先**（這個專案的既有做法）：`mergeRow`、HLC、段落解析、uid↔id 翻譯、
  同名去重的勝者選擇，全部不碰 DB、不碰網路。
- **對真實 schema 的測試**（`tests/main/`，已有 migration 測試的位置）：觸發器記帳
  （含牌組刪除的 `SET NULL` 連帶）、抑制旗標、套用後的應用層約束收斂（`isDefault`）。
- **Rust**：`store.rs` 寫入必帶 uid；`store` 對出貨 migrations 的既有驗證要涵蓋 015/016。
- **收斂性測試**：兩份記憶體內 DB、隨機產生操作序列、以任意順序交換段落，斷言最終狀態相同。
  這是唯一能抓到「規則在某個交錯下不收斂」的測試，值得寫成 property test。
- **e2e**（Playwright，兩份 profile 已是既有能力）：`SVWB_SYNC_URL` 指向 `wrangler dev`
  （照 `SVWB_UPDATE_SIM` / `SVWB_TELEMETRY_URL` 的既有慣例），跑 A 錄 → B 拉 → B 改 → A 拉。
- **不能忘的負面測試**：同步的 DB 檔案裡沒有 token；telemetry 請求裡沒有 `sub`；
  同步請求裡沒有 install id。

## 判斷題（J-1～J-6 於 2026-09-07 敲定；J-7 未決）

### J-1：新裝置首次登入而本機已有資料 → **問一次，兩個選項**

「合併」或「以雲端為準」，只在「首次登入且本機已有對局」時出現一次，兩條路都先把本機 DB
複製到 `sync-backup/` 並提供「回到合併前」。

推翻了初稿「直接合併、不問」的傾向。理由是**合併是雙向的**：這台的測試資料不只留在這台，
會被推上雲端再散到其他裝置。那是不可逆的污染，而「不問」省下的只有一次點擊。
不提供第三個選項「保留本機且這台不同步」——設定頁的總開關本來就是那件事，對話框裡再放一次是重複。

### J-2：裝置上限 → **不設硬上限**，改成對成本本身設限

先把成本算對（初稿寫的「N² 流量」不精確）：

- **位元組**是線性的。一台每次拉的量 ≈ 其他裝置新產生的資料，全帳號一輪 ≈ `D × 新資料`。
  而且 R2 沒有 egress 費用，位元組不計價。
- **請求數**才是平方的：一輪 `D × (D-1)` 次 GET。而免費額度的瓶頸正是 Worker 請求數
  （10 萬／天）。5 台 × 每天 6 次 ≈ 150 次／天／帳號，可忽略；50 台（帳號被分給一群人用）
  = 15,000 次／天，**一個帳號吃掉全站免費額度的 15%**。要防的只有帳號共享與腳本造裝置。

**裝置數是很差的量尺**：重裝 Windows、換硬碟、清 `userData` 都會生出新裝置 id，使用者沒有五台
電腦卻撞到上限，是永久的客服成本；而且 3 台每天同步 60 次比 8 台每天一次貴得多。

所以量在成本本身：

1. 裝置 id 存在 `SyncState`（DB），不存 electron-store——`settings:clear` 不該生出幽靈裝置。
   理由和 `012_add_telemetry_state.sql` 一字不改。
2. **per-account 限流**：每天同步輪數上限（提案 200）+ 每帳號 100 MB 儲存配額。
   形狀就是 telemetry Worker 已有的 `unsafe.bindings` ratelimit，不引入新概念。
3. **閒置裝置自動退休**：90 天沒推送 → 標記非活躍、段落折進封存、不再列入 pull 清單。
   重裝產生的舊裝置會自己淡出，fan-out 只跟著**活躍**裝置數走，平方項的底數自己收斂。
   用 cron，照 telemetry 那個 04:17 UTC 的既有模式。
4. **軟門檻當訊號**：活躍裝置 > 5 時記健康指標並在 UI 提示，不阻止。
5. **硬上限保留為伺服器端開關。** 這是重點：`telemetry/config.ts` 的教訓是編進安裝檔的東西改不了，
   但伺服器政策隨時可改。真的出現濫用時不必發版就能開。

代價要記著：退休 + 封存折疊是階段 4 的額外程式碼（cron + 一次段落重寫）；而「不設上限」
意味著濫用天花板完全靠上面那些數字，所以那些數字要被監控，不能只寫在文件裡。

### J-3：段落下載 → **Worker 代理（v1）**

用 R2 binding 直接串流，沒有簽章、沒有過期、沒有繞過我們授權的 URL。
算過：1000 帳號 × 每天 6 次 × 約 3 段 ≈ 1.8 萬次／天，遠低於免費 10 萬／天，而且壓實之後段落數
本來就少。真的撞到請求數上限再換預簽 URL（需要 S3 API 憑證與 aws4fetch）。

### J-4：`Card` / `CardPool` → **不同步，但還原後自動抓一次卡池**

遵守 `009_add_deck_import.sql` 的既有立場：`Card` 是別人資料的快取，缺列必須優雅降級。
還原流程結束時直接觸發現有的 `cards:syncPool`，使用者不會看到一片沒有卡圖的牌組而誤以為
還原失敗。整份同步 `Card` 被否決：那是把公開資料塞進使用者的私人配額，而且 `Card.lang`
的語系問題會跨機傳染。

### J-5：資料區域 → **APAC，並在隱私權政策明記**

使用者主體在亞洲，延遲最低，也和 telemetry 的 D1（已在 APAC）一致。R2 的位置提示一旦建立
就固定，所以這是一次性決定。歐洲使用者可行：以同意為法律依據，並在政策裡明白寫出存放區域。

### J-6：部分同步 → **不做，只有一個總開關**

半份資料的統計會和另一台不一致，那比「沒有同步」更難解釋。若顧慮是隱私，正確的答案是
不開同步，不是開一半。日誌標頭**不**預留範圍旗標——留一個沒人用的欄位只會讓將來讀日誌的人
猜它曾經代表什麼。

### J-7：`Match.oppo_name_crop` 要不要同步 → **未決**

`013_add_oppo_name_crop.sql`（2026-09-07）在 `Match` 上加了一張圖：對手名牌從 versus 畫面裁下
來的原圖。同步範圍寫的是「整個 `Match`」，所以**不做任何事的話，它會跟著上傳到 R2**。

這一欄和這份計畫裡其他所有欄位都不同：職業、勝敗、BP 是使用者自己的紀錄，這張圖是**別人的
名字**。把它從「使用者自己機器上的一張截圖」變成「我們伺服器上的一份第三方個資」，是性質的
改變，不是量的改變——即使 bucket 是私有的、即使只有本人讀得到。

三個選項：

1. **排除該欄位**，還原後那一欄為 NULL。代價：B 機看不到名牌，而使用者不會知道為什麼。
2. **照常同步**，並在隱私權政策明白寫出「你的對局紀錄包含對手名稱的畫面截圖，會存放在
   〈區域〉」。代價：政策要寫得更細，而且它是同意畫面上會被讀到的那種句子。
3. **讓使用者選**，預設不同步。代價：J-6 已經決定「不做部分同步，只有一個總開關」，這會是
   那條規則的第一個例外。

**這件事必須在階段 2（單向備份）動工前決定**，因為它決定日誌段落的欄位集合，事後再改就要處理
「已經上傳的舊段落裡有這些圖」。決定之後把結論寫回上面的「同步範圍」那一條。

## 附錄：被否決的方案（摘要）

- **改成 UUID 主鍵**：見難點 1。keyset 分頁、版本排序、`familyId` 回填全部建立在整數單調性上。
- **應用層攔截寫入取代觸發器**：看不到引擎（難點 2），且未來任何新寫入路徑都要記得手動記帳。
- **伺服器端合併**：伺服器不需要理解領域模型；合併規則放在客戶端才能和 `deck-versioning-plan.md`
  的語意共存，也才能先合併本機的東西再上傳。
- **把同步游標或裝置 id 放 `electron-store`**：`settings:clear` 會清掉它們，游標沒了就變成全量
  重放，裝置 id 沒了就多出一台幽靈裝置（而 J-2 的退休與限流都是按裝置算的）。
  和 `012_add_telemetry_state.sql` 拒絕放 `config.json` 的理由一字不改：兩者都住 `SyncState`。
- **硬性裝置上限（初稿的「5 台」）**：見 J-2。它量錯了東西——成本驅動因子是每日同步輪數與
  活躍裝置數，不是註冊過幾台；而重裝一次 Windows 就會讓誠實的使用者撞到牆。
