# 匿名使用統計（Telemetry / DAU）

Last updated: 2026-09-02

> 狀態：**記錄端已實作，Worker 已於 2026-09-02 部署。** 端點
> `https://telemetry.svwb-analyzer.workers.dev` 已填進 `src/main/telemetry/config.ts`，所以**下一版
> 打包出來的 build 開關就是活的**（預設仍為關閉，要使用者自己開）。已發出去的 1.2.0 之前的版本
> 端點是空的，永遠不會送。程式內的「環境統計」頁面**刻意延後**到之後的版本；本文件只涵蓋
> 「能夠記錄」這一段。

這份文件原本是一份提案（Plausible / PostHog、九個事件名稱）。實作時把它與
`docs/meta-stats-plan.md` 的「聚合層」合併成**一條管線**，理由見「為什麼合併」。跨使用者統計的
決策記錄（桶模型、信任分層、已否決的方案）仍在 `meta-stats-plan.md`；這裡寫的是實際出貨的東西。

## 回答的問題

維護者：

- 現在有多少人在用（今日／7 天／30 天活躍安裝數）。
- 各版本各有多少人。
- 每天記錄了多少場對局；其中多少是引擎乾淨觀測到的、多少被人改過、多少沒收尾。

使用者（之後的版本）：

- 這個版本哪個 class 強、某個對位實際勝率多少 —— 由 `/v1/meta` 供應，格式已定，頁面未做。

## 隱私原則（不變）

- **預設開啟（1.3.0 起），但在告知之前一筆都不送。** `settings.telemetry` 預設 `true`；上傳另外
  被「一次性告知已經顯示過」（`telemetryPromptShown`）擋著，兩個條件都成立才會送。所以沒有任何一台
  機器是在不知情的狀況下送出東西的——預設開是參與率的決定，靜默送出是另一回事。
- 為什麼從 opt-in 改成 opt-out（2026-09-02，使用者決定）：埋在設定裡的 opt-in 只會拿到個位數
  參與率，而用個位數樣本畫出來的對位表比不畫還糟。告知的內容包含「送出什麼」與「隨時可關」，
  toast 上就有關閉鍵。
- 升級既有安裝時做一次性翻轉（`telemetryDefaultFlipped`）：1.3.0 之前的 build 沒有端點，開關是灰的、
  提示也不會出現，所以那些安裝裡存著的 `false` 是「沒被問過」而不是「拒絕」。翻轉只做一次，之後
  關掉就一直是關的。
- **上傳前看得到全部內容。** Settings 的「檢視會送出的內容」顯示下一次上傳的完整 JSON，由與真正上傳
  同一段程式產生。
- 不送：截圖、OCR 文字、牌組名稱、備註、標籤、對局時間戳、BP／MP／CR、本機路徑、帳號、任何完整對局列。
- install id 是隨機 UUID，只在第一次開啟時產生，不與任何身分連結。關閉時保留（再開時不會被算成第二台機器）。
- 網路失敗不影響任何功能：所有上傳路徑吞掉自己的錯誤、記在 Settings 顯示，不 await、不 throw。

## 送出什麼

wire format 在 `src/shared/telemetry.ts`；一次上傳長這樣：

```json
{
  "schema": 1,
  "installId": "6f0d1a2b-…",
  "appVersion": "1.3.0",
  "platform": "win32",
  "arch": "x64",
  "locale": "zh-TW",
  "sentAt": "2026-09-02T10:00:00.000Z",
  "days": [
    {
      "date": "2026-09-02",
      "abandoned": 1,
      "manual": 0,
      "buckets": [
        { "tier": "clean", "mode": "ranked", "myClass": "witch", "oppoClass": "dragon",
          "playOrder": "first", "result": "win", "count": 3 }
      ]
    }
  ]
}
```

- `days` 固定涵蓋最近 **14 個 UTC 日**（含今日），沒打的日子也送空的。伺服器以 `(installId, date)`
  整批覆寫，所以刪掉或改過的對局在下次上傳就自動反映，兩邊都不用做變更追蹤。
- 桶的 key：`tier × mode × myClass × oppoClass × playOrder × result`，值是計數。這就是全部。
- `tier` 是引擎對這列的自我評價（見 `rollup.ts`）：
  `clean`（引擎寫、沒改過統計欄位、沒有存疑旗標）／`edited`（人改過 `OBSERVED_COLUMNS` 之一）／
  `flagged`（帶 `weak-mode-accepted`、`mode-guessed`、`mode-corrected`、`final-screen-never-seen`
  之一）／`legacy`（008 之前的列，來源不明）。四種都上傳；哪些可以進公開圖表由伺服器決定，不用發版。
- `abandoned` 是 `result IS NULL` 的列數；`manual` 是手動新增（`source='manual'`）的列數。兩者只計數、
  不進桶。
- 「活躍」看上傳**抵達**的日子，「對局趨勢」看對局**發生**的日子；兩者在伺服器是不同的表。

## 什麼時候送

前提是**一次性告知已經顯示過**（開機 12 秒後跳出，主視窗沒開就不算）。在那之前所有上傳路徑都會
早退，包含 Settings 的「立即上傳」。之後：`src/main/telemetry/telemetry.ts`：啟動後 20 秒一次；之後每 6 小時一次；每場對局結束後 10 分鐘一次
（去抖）；開啟開關後 3 秒一次；Settings 的「立即上傳」。同一分鐘內只送一次。所有計時器 `unref`，
不會拖住關閉。

## 存在哪裡

- 客戶端狀態（install id、最後上傳時間、最後錯誤）在 SQLite 的 `TelemetryState` 表
  （migration 012），不在 `electron-store`：`settings:clear` 會清掉 config.json，資料庫不會。
- 伺服器：`server/telemetry/`，Cloudflare Worker + D1，四張表，見該目錄的 README。

## 為什麼合併

原提案說 DAU 與 meta 「不共用管線」，理由是不該把對局資料塞進 Plausible / PostHog 那類產品分析服務。
自己寫 Worker 之後這個理由消失了：一次上傳同時帶「我是哪版、在哪個平台」（活躍度）和「我這 14 天
記錄了什麼」（meta），兩者都是每天一列、都以 install id 為鍵，拆成兩條只會多一倍的程式和一倍的
故障點。

原提案的九個事件（`deck_analysis_opened`、`capture_failed`……）沒有做。DAU 與版本分佈已由每日上傳
回答；功能使用率需要另一套 per-event 管線，而目前沒有任何一個決策等著這些數字。

## 部署與觀看

2026-09-02 已跑完一輪：D1 `svwb-telemetry`（APAC）、Worker `telemetry`、`ADMIN_TOKEN` 已設、端點已填。
重跑或重建的步驟見 `server/telemetry/README.md`：`wrangler d1 create` → 貼 id → `migrations apply`
→ `secret put ADMIN_TOKEN` → `deploy` → 把網址填進 `config.ts` → 重新打包。

Worker 名字（`telemetry`）就是網址的第一段，而網址編譯進安裝檔、舊版本永遠打舊網址——所以
`wrangler.toml` 的 `name` 不要再改。

```bash
SVWB_TELEMETRY_URL=… SVWB_TELEMETRY_ADMIN_TOKEN=… pnpm telemetry:report
```

## 測試

- `tests/main/telemetryRollup.test.ts`：分層規則、UTC 切日、空日、決定性輸出、輸出欄位白名單。
- `tests/main/telemetry.test.ts`：對真實 migration 後的資料庫走 IPC —— 告知之前不送、預覽不產生 id、
  開關切換保留 id、payload 內容、HTTP／網路失敗不 throw、沒端點就不送、去抖、提示只出一次。
- `tests/main/telemetryServer.test.ts`：Worker 的驗證與彙總純函式，直接吃 app 端 `rollup()` 的輸出
  —— 客戶端寫得出來的，伺服器一定收得下。
- `server/telemetry/smoke.mjs`（`pnpm smoke`，需要先 `pnpm dev` 起本機 Worker）：上面三支都是純
  函式，碰不到 SQL 與路由。這支打真的 HTTP／真的 D1，驗覆寫語意（重送不累加、改過的日子整天替換、
  連 `abandoned`／`manual` 一起換掉）、逐日拒收、admin token、壞 body 不會變成 500。2026-09-02
  對 `wrangler dev --local` 全過。

## 待辦（依序）

1. ~~部署 Worker、填端點~~（2026-09-02 完成）。**發版**——端點只有重新打包才會生效。
2. 觀察幾週：活躍數、版本分佈、`tier` 分佈、被拒收的日子（`rejected` 會在 app log 出現）。
3. 拿 `edited` 對 `flagged` 的比例回答 `meta-stats-plan.md` P0b：哪些旗標真的預測錯誤。
4. 之後的版本才做側邊欄「環境統計」頁：讀 `/v1/meta`，Wilson 區間與低樣本標記由呈現端算（D-8）。
5. 網頁版：同一個 `/v1/meta`，已開 CORS。

## 已知限制

- 仍然低估使用人數，只是少了很多：關掉的人不會回報，而在告知出現之前就關掉程式的安裝也不會。
  看到的數字永遠是下限。
- 雙方都用本工具時同一場被算兩次（勝率對稱不受影響，總場次膨脹）。
- 端點公開、client 開源，偽造上傳不可能根除；靠列舉白名單、單日上限、覆寫語意壓低影響
  （`meta-stats-plan.md` R-5）。需要時在 Cloudflare 加 WAF rate limit，不用改程式。
- Cygames 服務條款對「蒐集並公開對戰統計」的立場需要專案擁有者確認（`meta-stats-plan.md` J-4），
  在公開圖表之前。

## 修訂紀錄

- 2026-08：初版提案（Plausible / PostHog / OpenTelemetry 比較、九個事件）。
- 2026-09-02：改寫為實作記錄。與 meta 聚合合併為一條管線；事件模型放棄；記錄實際 payload、
  排程、儲存位置與測試。
- 2026-09-02：預設從 opt-in 改為 opt-out（使用者決定），加上「告知之前不送」的閘門與一次性
  翻轉；toast 從「要不要開」改成「已經開了，這是送出的內容，這裡可以關」。
- 2026-09-02：部署。D1 `svwb-telemetry`（APAC，`ae233733`）、Worker `telemetry`、`ADMIN_TOKEN`
  已設；`/health`、`/v1/meta`、admin 的 401 都對過。網址中途改過兩次，最終定案
  `https://telemetry.svwb-analyzer.workers.dev`，填進 `config.ts`，剩下發版。
- 2026-09-02：對本機 `wrangler dev` 跑完整條管線（上傳 → D1 → `/v1/meta`、`/v1/admin/overview`、
  `pnpm telemetry:report`）並全過；把這段固化成 `server/telemetry/smoke.mjs`。剩下的第 1 項要
  Cloudflare 帳號，只有專案擁有者能做。
