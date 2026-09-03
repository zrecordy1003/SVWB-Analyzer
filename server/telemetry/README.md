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
| GET  | `/v1/admin/overview` | 維護者數字：活躍安裝數（今日／7 天／30 天）、各版本人數、每日序列。 | `Authorization: Bearer <ADMIN_TOKEN>`  |
| GET  | `/health`            | 存活檢查                                                            | 無                                     |

`/v1/ingest` 沒有認證，因為 client 是開源的，任何金鑰都等於公開（`docs/meta-stats-plan.md` R-5）。

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

## 資料表

見 `migrations/0001_init.sql`。四張表回答兩個問題：

- **誰在用什麼**：`installs`（每個安裝一列，最後回報的版本／平台）、`activity`（每個安裝每個
  _收到上傳的_ UTC 日一列）。「今日活躍」= `activity` 當日列數。
- **記錄了什麼**：`match_days`（每個安裝每個 _對局發生的_ UTC 日一列，含總數）、`buckets`
  （依 tier／模式／雙方職業／先後攻／勝負的計數）。

兩組日期刻意分開：一個人今天打開程式，上傳的是過去 14 天的對局；活躍度看前者，對局趨勢看後者。

## 部署

需要 Cloudflare 帳號（免費方案即可）。在這個目錄：

```bash
pnpm install
pnpm exec wrangler login
```

建資料庫，把印出來的 `database_id` 貼進 `wrangler.toml`：

```bash
pnpm db:create
```

套 migration、設管理用 token、部署：

```bash
pnpm db:migrate
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm deploy
```

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

## 免費額度（2026-09 查閱，動工前請再確認）

Workers 免費方案每日 100,000 次請求；D1 免費方案每日 5,000,000 列讀取、100,000 列寫入、5 GB。
一次上傳約寫 30–60 列（14 天 × 每日數個桶）。以每人每日上傳兩次估，寫入額度約夠 1,000 個活躍
安裝；`/v1/meta` 每 15 分鐘一次 cache miss，每次掃描 `buckets` 中 14 天內符合條件的列。
超過這個量級時把 `/v1/meta` 的 GROUP BY 移到 scheduled handler、寫成 KV 快照——回應格式不變，
app 不用改。

## 之後

`/v1/meta` 就是下一版側邊欄「環境統計」與網頁版要讀的東西。回傳的是每格的 `wins` / `total`，
不是勝率：Wilson 區間與低樣本標記由呈現端算（`docs/meta-stats-plan.md` D-8），伺服器不替任何人
決定「多少場算夠」。
