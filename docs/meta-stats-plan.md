# 計畫：對局資料的來源標記，與跨使用者統計

Last updated: 2026-09-02

本文件是「把使用者的對局資料變成統計圖表」這件事的唯一計畫來源，涵蓋兩層：

- **本機層**：對局資料的來源標記（provenance），讓「引擎觀測到什麼」與「使用者改成什麼」分開保存。
- **聚合層**：跨使用者的環境統計（meta），上傳、伺服器聚合、公開圖表。

兩層寫在同一份文件，理由見「為什麼兩層必須一起審查」。相關既有文件：
`docs/project-status-roadmap.md`（Priority 2、Priority 6）、`docs/telemetry-dau-plan.md`
（產品分析與 DAU，與本文件目標不同，見「明確不做的事」）。

> 狀態：**P1–P5 已實作**（2026-09-02）。P3 的 rollup 與 P5 的伺服器 ingest 都在 repo 裡，
> Worker 已於 2026-09-02 部署、端點已填入 `config.ts`，所以下一版打包出來就會送（預設仍關閉）；
> 已發出去的舊版本端點是空的，永遠不會送。P6（公開圖表）刻意延後。
> 判斷題 J-1／J-2／J-3／J-5／J-8 已於實作時定案（見各項）；J-4（Cygames 服務條款）與 J-7
> （per-row 辨識分數）仍開放，前者必須在 P6 之前由專案擁有者確認。
> 出貨的東西以 `docs/telemetry-dau-plan.md` 為準；本文件保留決策與否決記錄。

---

## 動機

Analyzer 目前畫的是使用者自己的資料，全部跑在本機 SQLite 上，成本為零，也沒有正確性以外的問題。
真正有產品價值、也真正困難的是另一件事：**把所有使用者的對局匯總成環境統計** —— 這個版本哪個
class 強、先後手影響多少、某個對位實際勝率是多少。

這類數據的價值上限，等於辨識準確率的上限。而一旦公開發布，錯誤會被當成事實引用。因此本計畫的
重心不在伺服器（那是最簡單的部分），而在**能不能證明送上去的每一筆資料是機器觀測到的、沒有被
改過、且引擎當時對自己有信心**。

### 現況查證（2026-08-30，逐項對照程式碼）

| 事實 | 依據 | 對統計的影響 |
|---|---|---|
| 沒有任何手動新增對局的路徑 | `insertInto('Match')` 在 `src/` 零命中；渲染層只用 `matches:` 的 delete / fetchRecent / getById / latestMode / needRefetch / queryList / updateDeck / updateWithExtras | **最大資產**：每列都源自 `store.rs:151` 的 `insert_match`。但這個保證是隱性的，沒有測試守著 |
| `updatedAt` 引擎也寫 | `store.rs:191,197,208,222`；`insert_match` 插入當下即寫入（`VALUES ... ?9, ?9`） | 從出生就非 NULL，**不能當「人改過」的旗標** |
| 編輯可改動全部統計欄位 | `ipc/matches.ts:616-645` 收 `result` / `play_order` / `my_class` / `oppo_class` / `mode` / `bp` / `playedAt`，就地覆寫 | 引擎原本讀到什麼，永久消失 |
| 刪除是硬刪除 | `ipc/matches.ts:709` | 已上傳的資料無法對帳 |
| 對戰一被辨識就先插列，result 後補 | `store.rs:148` 註解 | 每個 DB 都有一批未收尾的列 |
| 統計查詢沉默濾掉 `result IS NULL` | `ipc/matches.ts:473,495` | 若放棄行為與勝負相關，過濾本身即引入偏差 |
| 已知的系統性誤判 | `diagnosticsRecorder.ts:36` 註解：plaza / custom 兩個 probe 無驗證正樣本，其中一個曾把 ranked 標成 `weekendPlaza` | 系統性偏差不會因樣本變大而被平均掉 |
| `Confidence` 是仲裁順序，不是正確率 | `protocol.rs:56` 註解；ranked = `Strong`（`machine/tick.rs:184`），weekendPlaza = `Authoritative`（`tick.rs:196`） | 見「否決的方案 R-1」 |
| class / play_order / result 沒有信心度 | `Confidence` 只用於 mode；class 讀不到則整場丟棄（`class-unrecognised`） | 信任分層目前只能覆蓋四個統計維度中的一個 |

### 四類誤差，必須分開處理

混為一談是這個題目最容易犯的錯，因為四者的對策完全不同：

- **(a) 辨識錯誤** —— 引擎讀錯。**系統性**，不會被大樣本平均掉。對策是量測與排除，不是統計。
- **(b) 資料不完整** —— `result IS NULL`。對策是**上報而非丟棄**（見 D-6）。
- **(c) 使用者編輯** —— 可能是修正（提升品質），也可能是竄改。對策是 provenance，且要能分辨兩者。
- **(d) 惡意上傳** —— 直接打端點。對策是冪等、上限、離群剔除。**無法根除**（見 R-5）。

---

## 為什麼兩層必須一起審查

本機的 provenance 欄位不是實作細節，它**就是**上傳協定的一部分。具體耦合點：

1. **信任分層由 provenance 欄位定義。** Tier A/B/C 的判準直接讀 `source` / `edited_fields` /
   `recog_flags`。schema 一改，wire format 就改。
2. **上傳 watermark 必須放 DB。** 放 `electron-store` 會在重灌後遺失（見 D-5），所以它跟
   provenance 欄位是同一批 migration。
3. **逐欄 vs 整列 provenance 決定 payload 形狀。** 逐欄（D-3）才能讓「只改了牌組」的列留在
   Tier A，這直接影響可用樣本量的數量級。
4. **`observed` 快照決定伺服器能不能做 A/B 對照。** 沒有它，「使用者修正過的資料」與「引擎原始
   資料」的差異無法量化，也就無從判斷修正是在提升品質還是在竄改。
5. **provenance 事後再改 = 已上傳資料失去可比性。** 桶一旦累積，欄位語意變更會造成無法回溯的斷點。

因此：**兩層要嘛一起審查定案，要嘛都不做。** 先做伺服器再回頭補 provenance 是最差的順序。

---

## 目標架構

```text
[Rust 引擎]  觀測 → 寫入 Match（含 observed / recog_flags / engine_version）
                          │
[UI 編輯]    覆蓋層 → 只寫 edited_fields，不動 observed
                          │
                          ▼
[主行程]  rollup.ts（純函式）
            └ 依 watermark 取出區間 → 判定 Tier → 聚合成桶
                          │  gzip JSON，約 1KB／人／日
                          ▼
[Worker /ingest]  一次上傳 = D1 一列，PK (installId, date) —— 覆寫語意
                          │
[Worker Cron]  每日聚合 → 上限 / 離群剔除 / 健康度檢驗 → meta.json → KV
                          │
[Worker /meta] → app fetch → chart.js（既有依賴）
```

聚合的單位是**桶**，不是對局列：

```text
(date, mode, my_class, oppo_class, play_order, result) -> count
```

上限 7×7×2×2 = 196 個桶，實際一人一日約 20–60 個。這一個決定同時解掉頻寬、儲存、隱私三件事：
沒有牌組名、沒有註記、沒有標籤、沒有時間戳，也就沒有可辨識個人的內容。

---

## 已定案的決策

**D-1｜上傳聚合桶，不上傳對局列。**
meta 圖表只需要計數。原始列會讓儲存持續成長、寫入量放大兩個數量級，並把隱私審查從「幾乎不存在」
變成「必須認真做」。

**D-2｜編輯是覆蓋層，不是覆寫。**
引擎的觀測值不可變；使用者的修正疊在上面。這同時把 roadmap Priority 2「欄位所有權契約寫了但沒被
遵守」變成可執行的約束。

**D-3｜provenance 逐欄記錄，不是整列旗標。**
最常見的編輯是補牌組、加註記、貼標籤，這些欄位不進統計。整列旗標會丟掉大量完全乾淨的觀測。

**D-4｜伺服器主鍵是 `(installId, date)`。**
重送覆寫、不累加，天然冪等。同時支援「使用者回頭修正舊對局後重送該日完整桶」—— 這是選 date 而非
batch id 的第二個理由。

**D-5｜上傳 watermark 放 DB，不放 `electron-store`。**
DB 位於 `userData`，重灌後留存；settings 不一定。watermark 遺失會導致整段歷史重送，配上新的
installId 就是重複計數。

**D-6｜不確定性上報，不在客戶端消化。**
`result IS NULL` 的數量以 `abandoned_count` 單獨上報，Tier C 的數量也上報。伺服器必須知道「這批
300 場裡有 40 場沒收尾」，否則無從判斷偏差。

**D-7｜桶的日期用 UTC。**
`year/month/day` 是本地時間（`store.rs:16`），跨時區聚合會讓「一天」變糊。趨勢圖影響小，版本切段
的邊界會歪，所以在 rollup 時轉 UTC，本機圖表仍用本地日期。

**D-8｜統計呈現沿用 `confidence.ts` 的誠實性標準。**
Wilson 區間、低樣本標記、顯示 n。聚合圖不得只顯示一個百分比。

---

## 明確不做的事

- **不上傳原始對局列、牌組名稱、註記、標籤、路徑、時間戳。** 與 `telemetry-dau-plan.md` 的隱私原則
  一致。
- **不用客戶端簽章假裝防偽。** 見 R-5。
- **不新增手動記錄對局的功能。** 它會摧毀「每列都是機器觀測」這個唯一的信任基礎。若日後真要做，
  必須寫入 `source='manual'` 並在統計端無條件排除，且該排除要有測試。
- **不做 DAU 與功能使用分析。** 那是 `telemetry-dau-plan.md` 的範圍，事件模型與隱私考量都不同，
  兩者不共用管線。
- **不在辨識準確率量測完成前公開任何跨使用者圖表。** 見 P0b。

---

## 否決的方案

**R-1｜用 `mode_confidence == 'authoritative'` 當信任閘門。**
方向性錯誤。`Confidence`（`protocol.rs:56`）的語意是「誰可以覆蓋誰」，不是「有多可能正確」。
實際指派：ranked 是 `Strong`，且是刻意的 —— 2Pick 結算畫面自己的「BP 100」對「BP :」模板打到
0.757–0.787，過了 0.7 門檻並連中 9 幀，所以這個 probe 不准覆蓋分得出來的那個
（`machine/tick.rs:172` 註解）。而 weekendPlaza 是 `Authoritative`（`tick.rs:196`），偏偏它就是
沒有驗證正樣本、曾把 ranked 誤標的那個 probe。
此閘門會**濾掉全部 ranked、留下最不可信的 plaza**。
改採：模式白名單 + `recog_flags`（`weak-mode-accepted` / `mode-guessed` / `mode-corrected`）。

**R-2｜用 `updatedAt` 判斷是否被使用者編輯過。**
引擎自己每次 patch 都寫，且插入當下就寫。從出生即非 NULL，零判別力。

**R-3｜把鏡像一致性檢驗當作防灌水主力。**
恆等式 `count(A vs B, first, win) ≈ count(B vs A, second, lose)` 在期望值上成立（兩邊都是同一母體
事件乘採用率的無偏估計，不需要雙方都裝工具）。但：冷門對位方差蓋過訊號；採用率若與 class 選擇
相關會**系統性偏離而那不是造假**，誤報率高；雙方都裝工具時同一場被計兩次（對勝率對稱無害，但總
場次膨脹，同 class 內戰兩筆方向相反）。
降級為**健康度指標**，用於偵測某個 class 的方向性辨識偏差（例如「我方 X」比「敵方 X」好認 ——
兩者 ROI 與背景不同，這完全可能），不作為防灌水手段。

**R-4｜Supabase / PostHog / Plausible。**
Supabase 免費專案閒置會暫停，對一個靠 cron 的長尾服務是硬傷。PostHog / Plausible 是產品分析，不是
給遊戲 meta 聚合用的，塞對局資料進去會很快撞到事件計費，且與 D-1 的桶模型不相容。

**R-5｜試圖根除偽造上傳。**
沒有任何密碼學手段能保證一個裝在別人電腦上的 client 送真話：金鑰可從 binary 取出，本機 SQLite 可用
任何 sqlite3 工具直接改。本 repo 是 Apache-2.0，端點、payload 格式、驗證邏輯全部公開，偽造門檻近乎零。
目標改為「讓偽造的影響力低於雜訊」：冪等主鍵、單人單日場次上限、單一 installId 對任一桶的貢獻佔比
上限、桶內計數與宣稱總數一致性、列舉值白名單。

---

## 路線圖

### P0a｜讓 replay 真的在 CI 跑（現在就能做，獨立於其他各項）

`tests/fixtures/captures/**/*.mp4` 被 gitignore，乾淨簽出沒有錄影，CI 的 replay 步驟回報 skip。
透過 Git LFS 提交錄影（repo 已對 `*.dll` / `*.gz` 使用 LFS），並拿掉 `.github/workflows/ci.yml`
裡的 skip 分支。

驗的是**不迴歸**，不是準確率。這兩件事本文件初版混為一談了，見 P0b。

### P0b｜量測辨識準確率（依賴 P1 的實地資料，不能提前）

meta 統計的價值上限等於辨識準確率的上限，而目前沒有這個數字：fixture test 是逐項斷言（這張圖該讀
出什麼），`vision:verify` 驗的是不迴歸。

本文件初版把這件事放在最前面，是錯的 —— 現有語料是 5 支錄影加 47 張 PNG，**從這個規模算不出有
意義的準確率**。真正能提供準確率的語料，正是 P1 落地後 `observed` 累積下來的人工修正：使用者每改
一次就是一筆標註。所以順序是 P1 先行、P0b 在後，而不是相反。

完成條件：以 `observed` 對 `recog_flags` 分組，產出逐維度（mode / class / play_order / result）的
實測修正率。

### P1｜migration 008 + 引擎寫入 provenance

已實作於 `resources/migrations/008_add_provenance.sql`：

```sql
-- 引擎專屬（UI 永不寫入）
ALTER TABLE "Match" ADD COLUMN "source"          TEXT;  -- NULL | 'engine' | 'manual'
ALTER TABLE "Match" ADD COLUMN "mode_confidence" TEXT;  -- weak | strong | authoritative
ALTER TABLE "Match" ADD COLUMN "engine_version"  TEXT;
ALTER TABLE "Match" ADD COLUMN "recog_flags"     TEXT;  -- JSON array

-- UI 專屬（引擎永不寫入），P2 才開始寫入
ALTER TABLE "Match" ADD COLUMN "observed"      TEXT;  -- 首次編輯前的引擎值快照
ALTER TABLE "Match" ADD COLUMN "edited_fields" TEXT;  -- JSON array，逐欄
```

**`source` 可為 NULL，不是 `NOT NULL DEFAULT 'engine'`。** 本文件初版寫成後者是錯的：那會把 008
之前的所有列一律標成「引擎寫的、可信」，但那些列有沒有被人編輯過根本無從得知，等於在 migration
裡先斬後奏地替 J-2 做了決定。NULL 的語意就是「來源不明」，與 `GameMode.unknown` 不被折進
`unranked` 是同一個道理。

`mode_confidence` 存下來只作為診斷與事後分析用，**不作為信任閘門**（R-1）。

**旗標走 `MatchPatch`，不動 `Change::Noted`。** 原本設想在 `live.rs` 攔截 `Noted` 寫入資料庫，但
`Noted` 不帶 match ref —— 它只能說「plaza probe 觸發了」，不能說「在這一場觸發」。要補 ref 就得改
`machine::Change`、`replay.rs`、`scenarios.rs` 與相關測試。而 `MatchPatch` 本來就是「引擎為某一場
新解析出的欄位」的通道，已有 `persist()` → `update_match()` 的完整路徑，且 `tick.rs` 的六個 `Noted`
站點全都在有 ref 的作用域內。診斷用的 `Noted` 原樣保留，兩者並行。

寫入時機的兩個細節：`mode_confidence` 與 `mode` 由**同一句 UPDATE** 寫入，所以修正模式時信心度必然
一起換掉，不會出現「A 訊號的模式配 B 訊號的信心度」；`recog_flags` 在資料庫端做**聯集**而非覆寫，
因為對戰中途的 patch 只帶當下已知的旗標，且狀態機在收尾時會重送累積的整套。

實際記錄的旗標：`weak-mode-accepted`、`mode-corrected`、`mode-guessed`、`ranked-no-numbers`、
`final-screen-never-seen`。`weak-mode-accepted` 只在 `offer_mode` **接受**該訊號時才記 —— 診斷關心
「probe 觸發了」，但資料品質關心的是「它的答案被採用了」。

完成條件（已達成）：`cargo test` 4 個新測試 —— 插入列帶 `source='engine'` 與 `engine_version`、
引擎永不寫 `observed` / `edited_fields`、模式修正一併換掉信心度、旗標聯集不重複。

### P2｜編輯改為覆蓋層

已實作於 `src/main/data/provenance.ts`（純函式）與 `src/main/ipc/matches.ts`（兩處呼叫點）。

**依值比較，不依出現與否。** 編輯視窗每次存檔都送整份表單，所以 payload 裡有 `my_class` 完全不代表
有人改過它。若以「欄位有出現」當作編輯，只要打開視窗按存檔，整列就會被標成人工改寫 —— 這會讓
`edited_fields` 在最常見的操作下失去意義。

**快照只花用一次，且只在真的要摧毀觀測值時花用。** 改備註或指定牌組不會破壞任何統計讀得到的東西，
所以不得消耗那唯一一次記錄機會；只有改到 `OBSERVED_COLUMNS` 才快照，而且快照的是**整組**觀測欄位
—— 之後再改別的欄位就沒有第二次機會了。

**涵蓋全部編輯路徑，不只編輯視窗。** `matches:updateBP`、`updateNote`、`updateDeck` 這三個行內編輯
共用 `updateAndReload`，改的是跟視窗一樣的真實欄位。provenance 記在那個共用點上，「有沒有被手改過」
才不會取決於使用者剛好用了哪個控制項。標籤變更以 `'tags'` 記錄（它不是 `Match` 的欄位），且不消耗
快照。

**順帶修掉 roadmap Priority 2 的「`update_match` 不是原子的」。** 引擎那支（`store.rs`）一個 patch
最多發出八個獨立 UPDATE，中途崩潰會留下半套：結果寫了、數字沒寫。改為單一交易，用
`unchecked_transaction` 以保留 `&self` 簽章 —— 否則得把 `&mut` 一路傳到 `live::persist` 與
`LiveOptions`，而這個連線本來就只有一個行程持有。

完成條件（已達成）：`tests/main/provenance.test.ts` 11 個測試，涵蓋「原封不動重送不算編輯」「只改
備註不消耗快照」「第二次修正不覆蓋原始快照」「edited_fields 是集合不是流水帳」「JSON 壞掉不阻斷
使用者的編輯」；`store.rs` 新增一個測試，斷言 patch 中途失敗不留下任何一半。

### P3｜rollup 純函式

已實作於 `src/main/telemetry/rollup.ts`：`rollup(rows, now) -> TelemetryDay[]`。純函式，不碰網路。

**沒有 watermark，改用滑動視窗。** 初版設想 `(matches, watermark)`，實作改成每次都送最近 14 個
UTC 日的完整桶（含空日），伺服器以 `(installId, date)` 覆寫。這一個改動同時解掉 D-5（watermark
要存哪）和 J-8（舊日期的編輯要不要回補）：14 天內的任何刪除、修正都在下次上傳自然反映，不需要
dirty-day 追蹤；超過 14 天的編輯不回補，接受。`TelemetryState` 表（migration 012）仍照 D-5 放在
資料庫，但存的是 install id 與最後上傳結果，不是 watermark。

**tier 是四個具名值，不是 A/B/C。** `clean` / `edited` / `flagged` / `legacy`，定義見
`rollup.ts` 的 `classifyRow`。命名而非排序，因為 P0b 還沒回答「flagged 是否真的比 edited 差」，
排序會預設答案。四種都上傳，伺服器端決定哪些進公開圖表（目前 `/v1/meta` 只算 `clean`）。

**手動新增的列只計數。** `matches:create` 已存在（`source='manual'`），照「明確不做的事」的規定
無條件排除於桶之外，以 `manual` 計數上報讓維護者看得到手動輸入的量。有測試守著。

完成條件（已達成）：`tests/main/telemetryRollup.test.ts` 19 個測試 —— 分層順序（manual >
abandoned > legacy > edited > flagged > clean）、`ranked-no-numbers` 不降級、UTC 切日、空日必出、
視窗外忽略、非詞彙列丟棄、輸出決定性、輸出欄位白名單。

### P4｜把 provenance 資料變成可讀的數字

已實作於 `src/main/data/provenanceStats.ts`（純函式）、`matches:provenanceStats`、
`src/renderer/src/components/Diagnostics/DataProvenance.tsx`。

**原本寫的兩件事只有一件成立。** 初版的 P4 是「用自己的資料把圖表跑通」＋「顯示修正統計」。前半
是誤寫：`Analyzer.tsx` 早就有 `MatchupHeatmap` 與 `MatchupBars`、可切換、接 `AdvancedFilterBar`，
meta 圖表在呈現上就是同一張對位熱圖，差別只在資料來源。那半已刪除。

**核心產出是旗標與修正率的交叉表。** 帶 `weak-mode-accepted` 的對局被修正 mode 的比例，對照未被
標記的對局的同一比例。若兩者差距顯著，這個旗標就有預測力，可以直接當上傳的排除條件，R-1 留下的
「該用什麼當信任閘門」就有答案；若兩者相同，旗標是裝飾，閘門得用別的東西建。**這就是 P0b 的實驗
本體**，不是順便顯示的數字。

**對照組必須從 `source='engine'` 的總數推導，不能從抓到的列去數。** 乾淨的對局沒有任何 provenance
JSON，根本不會被抓出來；若從抓取結果去數「未被標記的列」，得到的會是「未被標記**且剛好被編輯過**
的列」——一個以待測結果本身做篩選的群體，會讓任何旗標都顯得毫無用處。

**放 Settings 獨立一節，不受辨識診斷開關影響，也不進診斷匯出包。** provenance 是無條件寫入的（來源
標記若會因為使用者關掉某個開關而消失，那些列就變成不可信），放進受開關控制的區塊會與資料的實際
行為自相矛盾；而匯出按鈕在沒有診斷紀錄時是 disabled 的，正好是最需要獨立訊號的情況。

**時機：必須與 P1/P2 同版發布。** provenance 只對從現在開始的資料生效，既有使用者的歷史全部沒有。
所以這個面板在發布前近乎空白，真正的數字要等發布後累積數週。晚一版做，就晚一版開始收資料。

完成條件（已達成）：`tests/main/provenanceStats.test.ts` 9 個測試（含對照組推導、一列多旗標不重複
計入對照組、編輯與修正的區分、連續值不進轉移表、pre-008 列不進交叉表任一側）；`ipcSmoke.test.ts`
新增一個端對端測試，走真實 IPC 編輯路徑再讀回統計 —— 計數邏輯與寫入路徑寫在不同檔案，此前沒有
任何東西檢查兩者是否一致。

### P5｜伺服器 ingest

已實作於 `server/telemetry/`（Cloudflare Worker + D1；KV 暫不需要，見下）。Settings 有開關
（2026-09-02 起**預設開啟**，見 `telemetry-dau-plan.md`「隱私原則」）、一次性告知、以及
「檢視會送出的內容」；告知顯示之前不會送出任何東西。

**收全部模式與全部 tier，不只 ranked／Tier A。** 初版寫「先只收 ranked、只收 Tier A」。改為
client 送全部、伺服器篩選，因為：(1) 隱私成本相同 —— 都是計數；(2) 維護者需要「總共記錄了多少場」
這個使用量指標，不分模式；(3) 篩選條件放伺服器可以不發版就改。`/v1/meta` 目前只回 `ranked` ×
`clean`。

**與 DAU 合併為一條管線。** `telemetry-dau-plan.md` 原本說兩者不共用，理由是不該把對局資料塞進
第三方產品分析服務；自己寫 Worker 後理由消失。一次上傳同時是活躍度心跳（`activity` 表，以抵達日為
鍵）和對局桶（`match_days` / `buckets`，以對局日為鍵）。

**公開彙總先 on-demand + 邊緣快取，不先做 cron → KV。** 目前量級每次 cache miss 掃幾千列，遠低於
D1 免費額度；量級成長兩個數量級再搬到 scheduled handler 寫 KV，回應格式不變。

**防偽依 R-5：** 列舉白名單、單日 500 場上限、body 256KB 上限、逐日拒收、覆寫冪等。沒有簽章。

完成條件（已達成）：`tests/main/telemetryServer.test.ts` 直接拿 `rollup()` 的輸出餵
`validatePayload()`，確保 client 寫得出來的伺服器一定收得下；`tests/main/telemetry.test.ts` 對
真實 migration 後的資料庫走完整 IPC 上傳路徑。Worker 本體以 `wrangler dev --local` 對本機 D1
煙霧測試過 ingest → meta → overview。

### P6｜公開圖表（延後）

需 P0b 的準確率數字、P5 的實際樣本量、以及樣本偏差的明確標註同時到位。**且 J-4 必須先確認。**

資料來源已定：`GET /v1/meta`（回每格 `wins` / `total` 與貢獻的安裝數，不回勝率）。呈現端沿用
`Analyzer` 既有的 `MatchupHeatmap` / `MatchupBars`，差別只在資料來源；Wilson 區間與低樣本標記照
D-8 在 renderer 算。側邊欄按鈕與網頁版都讀同一個端點（已開 CORS）。

---

## 候選功能：起手牌與留牌勝率（延後）

> **不在目前的路線圖上。** 記錄於此是為了保住論證，不是為了排程。要等 P1–P6 那條線走完，
> 再當成一件獨立的事專心做。這裡只定案「如果要做，該怎麼做」。

### 為什麼它值得記下來

class 層級的對位矩陣（49 格）是現在唯一做得到的粒度，而牌組層級卡在兩件事：引擎不辨識個別卡牌，
且牌組名稱是使用者自由輸入的文字，跨使用者無法彙總。

起手牌辨識繞過了兩者。它給的是「這張卡留在起手時勝率多少」——一個玩家每局都要做、而且逐張做的
決策。

### 辨識：這是最有利的時機，不是最不利的

換牌畫面卡片放大、位置固定、靜止、且玩家會停留數秒；**一場只需辨識一次**，不是每 tick 都跑。對戰
中打出的卡才是難的（動畫中、重疊、縮放、只閃現幾幀）。

所以這件事與 roadmap Priority 7 的通用卡牌辨識難度不同級，不應被那一項的成本評估連坐。

### 決策：存感知雜湊，不存卡圖

現有 `resources/templates/` 是二十幾個固定 ROI；卡表是幾千張且每次卡包更新都會長。塞一套完整卡圖
進 repo 與 `ASSETS_POLICY.md` 的「只保留辨識所需的最小區域」「每份圖片說明用途與來源版本」有張力，
體積也會失控。

改為對卡圖 ROI 算感知雜湊（dHash 之類），一張卡 8 bytes，幾千張只有幾十 KB。辨識時算一次雜湊做最
近鄰查找，比模板比對更快。從 64 bit 還原不出原圖，所以散布的是衍生資料而非 Cygames 的美術素材。
卡包更新只需重跑雜湊產生器，不必提交任何圖片。

### 決策：以「單張卡的留牌勝率」為 key，不以「整手」為 key

40 張牌抽 4 張約 9 萬種組合，任何一手都只會有個位數觀測，永遠攤不出信賴區間。

以單卡為 key 則可行：一張三張入的卡約出現在 28% 的起手，300 場即約 83 次觀測，Wilson 區間約
±10%。**單一使用者靠自己的資料就有用**——不需要伺服器、不需要同意、不需要任何分類法，與 P1/P2
一樣是本機先有價值。

先後手的起手張數若不同，兩組必須分開統計；`play_order` 引擎本來就記了。

### 決策：卡片 ID 是比牌組更好的聚合鍵

卡片有官方 ID，**是跨使用者天生共用的詞彙；牌組名稱永遠不是**（那是每個人自己打的字）。

因此跨使用者彙總可直接用 `(my_class, card_id, 留/換)` 當 key，**完全不需要牌組分類法**。「用巫師、
起手留這張牌的人勝率如何」在所有使用者之間可比，「快攻妖精」則否。

這是這個功能相對於牌組分類法的真正優勢：路徑更短，且不必維護一份會過時的原型清單。

### 限制

只解決**自己那側**。對手換了什麼牌看不到，所以「對手起手」這個維度不存在。留牌決策本來就只跟自己
有關，所以這個限制不太傷——但它同時說明：這條路不會長成 OP.GG 的對手側資訊。

### 開工前要確認的事

- 卡圖 ROI 在各解析度下的座標，需與 `calibration.rs` 同一套正規化空間。
- 雜湊在不同縮放與抗鋸齒下的穩定性，需有跨解析度的 fixture 才能定門檻。
- 卡表來源與更新流程（官方公開後才可加入，見 `ASSETS_POLICY.md`）。
- 換牌前後兩個狀態都要記（留下的與換掉的），否則「換掉的勝率」無從比較。
- 資料表設計：起手牌是一場多列，不能塞進 `Match` 的欄位。

---

## 判斷題（開工前需定案）

**J-1｜這份資料是給誰看的？** ✅ **已決定：(c)，維護者先。** 2026-09-02 專案擁有者定案：先能記錄，
維護者看活躍數、版本分佈與彙總；數據夠了、系統穩了，下個版本才在側邊欄做使用者看的頁面，之後再做
網頁版。P5 因此先於 P6 落地，P6 延後。

**J-2｜pre-008 的舊資料怎麼處理？** ✅ **已決定：上傳，標 `legacy`，伺服器排除。** 不在 client 端
丟棄 —— 丟了就再也無法知道有多少；上傳成獨立 tier，公開圖表不算它，維護者看得到量。

**J-3｜上傳範圍？** ✅ **已決定：client 送全部模式，伺服器篩。** 桶本來就帶 `mode`，多送的隱私成本
為零；維護者需要不分模式的使用量；`/v1/meta` 只算 `ranked`，之後要改不用發版。

**J-4｜Cygames 服務條款。** 蒐集並公開發布對戰統計是否踩線，需要專案擁有者確認（其他遊戲的類似
工具有被要求下架的先例）。

**J-5｜開源導致端點完全公開，是否接受？** ✅ **已接受。** 見 R-5 與 `server/telemetry/README.md`
的防線清單。需要時加 Cloudflare WAF rate limit，不改程式。

**J-6｜免費額度需實查。** 2026-09 查閱的數字記在 `server/telemetry/README.md`；結論不變（目前量級
遠低於門檻），部署前再看一次。

**J-7｜要不要做 per-row 辨識分數？** 目前 class / play_order / result 沒有任何信心度，信任分層只
覆蓋四個統計維度中的 mode 一個。要補的話需讓引擎把 template score 隨 patch 帶出來，牽動
`reading.rs` / `protocol.rs` / `store.rs`，範圍不小。

**J-8｜舊日期的編輯要不要回補？** ✅ **已決定：14 天內自動回補，之外不回補。** 每次上傳都重送
最近 14 個 UTC 日的完整桶並覆寫，不需要 dirty-day 追蹤；三個月前的修正不會反映到聚合，接受。

---

## 已知缺陷與風險

- **樣本偏差無法消除。** 會安裝分析工具的玩家，段位與行為分佈都與母體不同；願意讓它繼續開著的人
  又疊一層（改成 opt-out 之後這層薄了，但沒有消失）。
  只能標註，不能修。
- **雙重計數。** 對戰雙方都使用本工具時同一場被計兩次。勝率對稱不受影響，總場次會膨脹。
- **版本斷點。** 遊戲改版後 meta 斷裂，桶必須帶版本標記，圖表預設只顯示當前版本區間。這也是要保留
  日期桶而非只存累計的原因 —— 累計值無法回溯切段。
- **系統性辨識偏差不會被大樣本平均掉。** 一萬個使用者只會讓錯誤的信賴區間變窄。
- **`matches:delete` 是硬刪除**，已上傳的桶無法對帳。可接受（桶是當日快照），但需知情。

---

## 修訂紀錄

- 2026-08-30：初版。合併原先分開構想的「provenance」與「meta 聚合」兩份計畫，理由見「為什麼兩層
  必須一起審查」。R-1 至 R-5 記錄已否決的方案；J-1 至 J-8 為未定案項。
- 2026-08-30：**P1 實作完成**，並據實作修正初版兩處錯誤 ——
  (1) `source` 由 `NOT NULL DEFAULT 'engine'` 改為可 NULL，否則 migration 會替 J-2 先做決定；
  (2) 原 P0 拆成 P0a（CI replay，現在可做）與 P0b（準確率量測，依賴 P1 的實地資料），初版把
  「不迴歸」與「準確率」當成同一件事，且順序放反了。
  另記錄旗標改走 `MatchPatch` 而非攔截 `Change::Noted` 的理由。
- 2026-08-30：**P2 實作完成**。編輯改為覆蓋層，涵蓋編輯視窗與三個行內編輯路徑；引擎的
  `update_match` 收進單一交易。
- 2026-08-30：**P4 實作完成**，並修正初版定義 —— 刪掉「本機圖表」那半（Analyzer 早已具備），
  明確 P4 的產出是旗標 × 修正率的交叉表，也就是 P0b 的實驗本體。記錄兩項設計定案：對照組
  從 engine 總數推導而非從抓取結果計數；統計面板獨立於辨識診斷開關之外。
- 2026-09-02：**P3、P5 實作完成**，並據實作修正三處 —— (1) watermark 改為 14 天滑動視窗覆寫，
  同時解掉 D-5 的存放問題與 J-8；(2) tier 由 A/B/C 改為四個具名值，四種全部上傳、伺服器篩選；
  (3) 上傳範圍由「只 ranked、只 Tier A」改為全部，篩選移到伺服器。與 `telemetry-dau-plan.md`
  合併為一條管線。J-1／J-2／J-3／J-5／J-8 定案；J-4、J-7 仍開放。P6 明確延後到之後的版本。
- 2026-08-30：新增「候選功能：起手牌與留牌勝率」。明確延後，不排程；記錄的是四項設計定案
  （雜湊而非卡圖、單卡而非整手為 key、卡片 ID 優於牌組作為聚合鍵、只解決自己那側），
  以免日後重新論證一次。
