# svwb-telemetry

接收 SVWB Analyzer 匿名使用統計的 Cloudflare Worker。一個 Worker、一個 D1 資料庫，沒有其他相依。

**已於 2026-09-02 部署**：`https://telemetry.svwb-analyzer.workers.dev`，這個網址已經寫進
`src/main/telemetry/config.ts`。網址的兩段各是一個東西：`telemetry` 是 Worker 名字
（`wrangler.toml` 的 `name`），`svwb-analyzer` 是帳號的 workers.dev 子網域（帳號層級，Dashboard
才改得動）。D1 資料庫另外叫 `svwb-telemetry`（`database_name`、`db:*` 指令），與網址無關。
改任一段都會換掉網址，而網址是編譯進安裝檔的，舊版本只會打舊網址——所以定案後不要再改。

app 端的對應程式在 `src/main/telemetry/`；wire format 在 `src/shared/telemetry.ts`，這裡的驗證
（`src/validate.ts`）直接 import 同一份常數，所以 app 寫得出來的值、伺服器就收得下，反之亦然。

## 端點

| 方法 | 路徑                 | 用途                                                                | 保護                                   |
| ---- | -------------------- | ------------------------------------------------------------------- | -------------------------------------- |
| POST | `/v1/ingest`         | app 上傳。以 `(installId, date)` 為鍵整批**覆寫**，重送冪等。       | 無認證；每 IP 60/分、每 installId 6/分 |
| GET  | `/v1/meta`           | 公開彙總：ranked、`clean` tier、預設最近 14 天（`?days=1..90`）。   | 無認證；每 IP 120/分；邊緣快取 15 分   |
| GET  | `/v1/admin/overview` | 維護者數字：活躍安裝數（今日／7 天／30 天）、各版本人數、每日序列、**CR 段位切分**。 | `Authorization: Bearer <ADMIN_TOKEN>`  |
| GET  | `/health`            | 存活檢查                                                            | 無                                     |

`/v1/ingest` 沒有認證，因為 client 是開源的，任何金鑰都等於公開（`docs/meta-stats-plan.md` R-5）。

### schema 版本

`/v1/ingest` 同時收 **schema 1 與 2**，而這份清單只會變長、不會變短。端點是編譯進安裝檔的，
所以一個永遠不更新的安裝會一直送它當年的 schema；把 1 從 `TELEMETRY_ACCEPTED_SCHEMAS` 拿掉
不會「讓那些安裝升級」，只會讓它們**無聲地不再被計算**。

schema 2 在每個 bucket 上加了 `crBand`。schema 1 的 bucket 沒有這個欄位，存成 `unknown`——
跟一個 schema 2 客戶端「讀不到 CR」時送的值是同一個，而且這是**刻意**讓兩者無法區分的：
兩者都沒有說出這場對局的階級。相對地，schema 2 少送 `crBand` 是**被拒收**的（`missing
crBand`），因為 `unknown` 本來就是多數，一個悄悄不送這個欄位的客戶端會直接消失在裡面。

### 三個抑制機制，性質不同

`/v1/meta` 上有三件事在縮減你看到的東西，很容易被混為一談，但只有一件跟隱私有關：

| 機制 | 常數 | 性質 |
| --- | --- | --- |
| 每人每格上限 | `META_MAX_PER_INSTALL_CELL` = 10 | **統計**。沒有它，一個在窗口內打了三百場排位的安裝會用一百比一壓過打三場的；以這個專案的規模，一個狂刷的人就是 meta。縮放時保住那個人的**勝率**，不分別截斷勝與敗——分別截斷會把懸殊紀錄拉向 50%，那是製造訊號。 |
| 每格最少安裝數 | `META_MIN_INSTALLS_PER_CELL` = 5 | **揭露**。一格只有一個貢獻安裝時，那一格就是那個人的對戰紀錄，而文件還把 `installs` 印在旁邊。這是唯一一個「只能躲在 token 後面才敢關掉」的。 |
| 只用 `clean` | `META_TIERS` | **資料品質**。目前 `legacy` 就佔了儲存的四分之三，所以公開矩陣與全部資料的差距主要來自這一項，而不是來自抑制。 |

`/v1/admin/overview` 的 `raw` 區塊把三個都關掉——那條路徑有 bearer 認證、只有一個讀者。
它仍然按 tier 分組（而不是全部混起來），這樣讀的人可以自己決定要信哪些；而且每格照樣回報
`installs`，因為門檻拿掉之後，誠實的替代做法是**把集中度顯示出來**，不是把它藏起來。
模式仍然固定在 `META_MODE`：把 2Pick 混進構築矩陣是在比較兩種賽制，那不是抑制而是可比性。

### 為什麼 CR 段位不在 `/v1/meta`

因為算術。公開的每一格要 `META_MIN_INSTALLS_PER_CELL` 個不同安裝，而目前過得了這個門檻的
每一格都只有 5～11 個；再乘上段位數，公開矩陣會歸零。所以這個維度**現在就收**（歷史補不
回來），但只在沒有門檻的 admin 路徑上切分。等安裝數長起來要在公開端點打開，是改常數、
不用發版。

第一層防線是統計性的：列舉值白名單、單日場次上限（`TELEMETRY_MAX_MATCHES_PER_DAY`）、body 大小
上限、逐日拒收而非整包拒收，以及覆寫語意讓重送不會累加。但這些都攔不住「偽造大量 installId」——
攻擊者把量分散到更多 id 上就繞過了單日上限，而公開表就是這樣被汙染的。

## 防濫用

兩層，刻意重疊。

**Worker 內**（`wrangler.toml` 的 `[[unsafe.bindings]]` + `src/index.ts` 的 `withinLimit`）：
每 IP 每分鐘 60 次 ingest、每 installId 每分鐘 6 次、`/v1/meta` 每 IP 每分鐘 120 次。app 自己的
排程在兩次上傳之間有 60 秒的底線（`MIN_GAP_MS`），所以真實安裝離 6/分很遠。

這些 binding 在程式裡是**可選的**，而且 fail **open**：binding 不存在、改名或 `limit()` 本身失敗
時放行。理由是 telemetry 靜掉是 bug，而一個因為 binding 改名就拒收所有上傳的 Worker，比一個多收
一下午的 Worker 糟得多。代價是「限制沒生效」不會有任何錯誤——所以部署後要實際驗一次（見下）。

**Cloudflare 邊緣**（儀表板，零程式碼，擋在 Worker 執行之前、不計 Worker 請求數）：
Security → WAF → Rate limiting rules，新增一條

- Field `URI Path` equals `/v1/ingest`
- Rate: `600` requests per `1 minute`, counting by `IP`
- Action: `Block`, duration `1 minute`

刻意設得比 Worker 內那層鬆一個數量級：邊緣這條是防真正的洪水（省 Worker 額度），Worker 內那層
才是防資料汙染的細粒度限制。兩層的閾值一樣的話，其中一層就是白費的。

`namespace_id` 是 Worker 內部的編號，彼此不能重複；改動它等於把該限制器的計數歸零。

## 保留期限

沒有任何東西被刪除過——`ingest` 只會覆寫同一個 `(installId, date)`，所以在這之前每張表都是
只增不減。夜間的 `scheduled` handler（cron `17 4 * * *`）補上這件事：

| 表           | 保留   | 理由                                                                                 |
| ------------ | ------ | ------------------------------------------------------------------------------------ |
| `buckets`    | 120 天 | 公開路徑最多問 90 天（`META_MAX_DAYS`），留餘裕給窗口變寬                            |
| `match_days` | 120 天 | 同上                                                                                 |
| `activity`   | 400 天 | 一天一列、很小，而它是唯一的長期使用量紀錄——丟掉去年就永遠答不出「上個賽季相比如何」 |
| `installs`   | 永久   | 一個安裝一列，而裡面的 `first_seen` 就是全部的成長紀錄                               |

三個 `DELETE` 不放在同一個 batch：batch 是原子的，而那是錯的性質——`activity` 的清理失敗沒有
任何理由要把 `buckets` 的清理一起回滾。失敗會記 log 然後放過，和這個 Worker 其他地方一樣的理由。

驗證。「不刪窗口內資料」那半由 `smoke.mjs` 蓋（比較方向寫反會刪光線上資料，而其他測試都讀自己
剛寫的資料，全都不會發現）。「會刪掉尾巴」那半 smoke 碰不到——`/v1/ingest` 拒收 30 天前的日子，
所以它造不出可清理的資料。手動驗一次：

```bash
pnpm exec wrangler d1 execute svwb-telemetry --local --command \
  "INSERT INTO buckets (install_id,date,tier,mode,my_class,oppo_class,play_order,result,count) \
   VALUES ('ancient','2020-01-01','clean','ranked','witch','elf','first','win',5)"
pnpm exec wrangler dev --local --test-scheduled   # 另一個終端
curl http://127.0.0.1:8787/cdn-cgi/handler/scheduled
pnpm exec wrangler d1 execute svwb-telemetry --local --command \
  "SELECT COUNT(*) FROM buckets WHERE date < '2021-01-01'"   # 應為 0
```

`/cdn-cgi/handler/scheduled` 是 wrangler dev 的觸發端點，部署後不存在；正式環境靠 cron。

## 資料表

見 `migrations/0001_init.sql`（與 `0002_cr_band.sql`）。四張表回答兩個問題：

- **誰在用什麼**：`installs`（每個安裝一列，最後回報的版本／平台）、`activity`（每個安裝每個
  _收到上傳的_ UTC 日一列）。「今日活躍」= `activity` 當日列數。
- **記錄了什麼**：`match_days`（每個安裝每個 _對局發生的_ UTC 日一列，含總數）、`buckets`
  （依 tier／模式／雙方職業／先後攻／**CR 段位**／勝負的計數）。

`0002` 是重建而不是 `ALTER TABLE ADD COLUMN`：段位是 bucket 身分的一部分（同一個對戰在不同
CR 打的是兩個 bucket），所以要進 PRIMARY KEY，而 SQLite 改不動 primary key。既有列一律變成
`unknown`，那就是它們的真相。對線上資料是安全的：ingest 是以 `(install_id, date)` 為鍵
`DELETE` 再 `INSERT`，不是靠 PK upsert，所以擴 PK 不會留下孤兒列。

兩組日期刻意分開：一個人今天打開程式，上傳的是過去 14 天的對局；活躍度看前者，對局趨勢看後者。

## 部署

需要 Cloudflare 帳號（免費方案即可）。在這個目錄：

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
```

**不要加 `--ignore-workspace`。** 這個目錄有自己的 `package.json` 與 lockfile，而讓 pnpm
把它當成獨立專案、而不是往上安裝到 repo 根的，是這裡的 `pnpm-workspace.yaml`；那個旗標會讓
pnpm 不讀它，連 wrangler 需要的 esbuild／workerd 都不會建。理由寫在那個檔案裡。

建資料庫，把印出來的 `database_id` 貼進 `wrangler.toml`：

```bash
pnpm db:create
```

套 migration、設管理用 token、部署：

```bash
pnpm db:migrate
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm run deploy
```

**`run` 不能省。** `deploy` 撞到 pnpm 的內建指令（`pnpm --filter=<pkg> deploy <dir>`，用來把
workspace 裡的套件攤平到一個目錄），所以 `pnpm deploy` 不會跑這裡的 script，而是去跑 pnpm
自己的部署功能然後印 usage 錯誤。這個坑只有 `deploy` 有——其他 script 名字都不衝突，
`pnpm db:migrate`、`pnpm smoke` 都可以直接寫。不想記的話一律加 `run`，或者直接
`pnpm exec wrangler deploy`。

**順序不能顛倒**，而顛倒的代價是靜默的資料遺失：

1. `pnpm db:migrate`（remote）——`buckets` 加上 `cr_band` 並擴 PK。
2. `pnpm run deploy`——這版才會收 schema 2。
3. **最後**才發帶 schema 2 的 app。

如果先發 app，那些安裝送出的 schema 2 會被舊 Worker 以 `unsupported schema 2` 全部 400 掉，
而客戶端只會把失敗記在 log 裡；等你發現的時候那段時間的對局已經過了 30 天的收件窗口，
補不回來了。反過來（先部署後發版）沒有任何代價：新 Worker 照樣收 schema 1。

部署完成會印出 Worker 的網址。把它填進
`src/main/telemetry/config.ts` 的 `BUILT_IN_ENDPOINT`，重新打包 app。**沒填之前 app 的開關是
灰的、什麼都不會送**——這是刻意的，一個看起來開著卻沒送出去的開關比沒有開關更糟。

部署後驗一次限制器有沒有真的生效——它 fail open，所以壞掉的時候沒有任何徵兆：

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$URL/v1/ingest" \
    -H 'content-type: application/json' \
    -d '{"schema":1,"installId":"00000000-0000-4000-8000-000000000000","appVersion":"0.0.0","platform":"x","arch":"x","locale":"x","sentAt":"2026-01-01T00:00:00Z","days":[]}'
done
```

前幾次應該是 400（`days` 是空的，這是預期的拒收），第七次之後應該轉成 **429**——那是
`INGEST_INSTALL_LIMITER` 的 6/分在作用。一路都是 400 表示限制器沒接上。

`/v1/meta` 的邊緣快取是 15 分鐘，所以剛部署的改動不會立刻反映在公開頁面上。要立刻看到新的
結果，用標準的 `Cache-Control: no-cache`（Worker 會遵守，見 `src/index.ts` 的快取查詢註解）：

```bash
curl -s -H 'cache-control: no-cache' "$URL/v1/meta" | head -c 400
```

## 看數字

```bash
SVWB_TELEMETRY_URL=https://telemetry.svwb-analyzer.workers.dev \
SVWB_TELEMETRY_ADMIN_TOKEN=<token> \
pnpm telemetry:report
```

（在 repo 根目錄執行。）加 `--json` 拿原始文件，`--meta` 看公開彙總。

## 本機開發

```bash
pnpm db:migrate:local
pnpm dev
```

然後讓 dev build 的 app 指向它：

```powershell
$env:SVWB_TELEMETRY_URL = "http://localhost:8787"; pnpm dev
```

`config.ts` 只對 `localhost` / `127.0.0.1` 放行 http；其他一律要 https。

## 冒煙測試

vitest 那三支測的是純函式（`validate.ts`、`aggregate.ts`，以及餵給它們的 app 端 `rollup()`）。
SQL 與路由測不到——一次上傳有沒有真的落進四張表、`(installId, date)` 是不是真的覆寫而不是累加、
沒有 token 的人是不是真的進不了 admin。`smoke.mjs` 打的是**跑起來的 Worker**，只驗這些。

先在另一個終端機 `pnpm dev`（`.dev.vars` 要有 `ADMIN_TOKEN=<隨便一個字串>`），然後：

```bash
pnpm smoke
```

它會寫入兩個隨機 install id 的資料，所以**只對本機資料庫跑**；指向非 localhost 的網址要另外加
`--allow-remote`。要換埠口或對別的地方跑：

```bash
SVWB_TELEMETRY_URL=http://127.0.0.1:8788 pnpm smoke
```

跑過的資料會留在本機資料庫裡。要洗掉重來：刪掉 `.wrangler/`（整個目錄都是本機狀態）再
`pnpm db:migrate:local`。

## 免費額度（2026-09-04 實測，不是估算）

Workers 免費方案每日 100,000 次請求；D1 免費方案每日 **5,000,000 列讀取、100,000 列寫入**、5 GB。

**這裡曾經撞上寫入牆。** 2026-09-04、91 個安裝的時候，`wrangler d1 info` 顯示 24 小時內
`rows_written` = **120,424**（上限 100,000），`rows_read` = 535,120（上限的 11%）。寫入爆掉的
症狀是 ingest 的 D1 batch 失敗、Worker 回 500、而客戶端只把失敗記在 log 裡——沒有任何一個地方
會叫。

原本這一節估「寫入額度約夠 1,000 個活躍安裝」，錯了大約一個數量級。原因不是量大，是**每次
上傳都重寫整個 14 天窗口**，不管內容有沒有變：寫入成本是 `上傳次數 × 窗口天數`，跟新增了幾場
對局無關。客戶端的排程是「啟動後一次 ＋ 每 6 小時 ＋ 每場對局後 10 分鐘」，所以一個有在玩的
安裝一天上傳五六次，而其中只有「今天」會變。實測每次上傳約 246 次列寫入。

`0003_content_hash.sql` 之後不再重寫沒變的日子：`match_days.content_hash` 存該
`(install, date)` 的內容指紋，一樣就整天跳過（`unchanged` 會出現在 ingest 的回應裡）。
一次上傳多一個讀取查詢、少十幾天的寫入——這兩個額度差 50 倍，所以這是划算的交換。
成本從 `O(上傳 × 14 天)` 變成 `O(有變動的天數)`，正常情況下是 1。

`unchanged` 刻意放進回應裡：跳過寫入的兩種壞法（跳太多＝修正過的日子沒落地，跳太少＝額度
照樣燒光）都不會有任何錯誤碼，所以「你跳了幾天」必須是一個看得到的數字，而不是要去翻 D1
的圖表才能推斷。`smoke.mjs` 對這三種情況都有斷言。

還有寫入壓力的話，下一步是把 `/v1/meta` 的 GROUP BY 移到 scheduled handler、寫成 KV 快照
（回應格式不變，app 不用改）——但那省的是**讀取**，而讀取從來不是瓶頸。真正還會成長的是
`activity` 與 `installs` 每次上傳各一列，那個下不去，因為它就是心跳。

## 之後

`/v1/meta` 就是下一版側邊欄「環境統計」與網頁版要讀的東西。回傳的是每格的 `wins` / `total`，
不是勝率：Wilson 區間與低樣本標記由呈現端算（`docs/meta-stats-plan.md` D-8），伺服器不替任何人
決定「多少場算夠」。
