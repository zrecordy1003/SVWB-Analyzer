# 重構計畫：感知引擎獨立化

Last updated: 2026-08-28

本文件是這次重構的唯一計畫來源。背景診斷見「動機」一節；分期執行見「路線圖」。
相關既有文件：`docs/architecture.md`、`docs/recognition-optimization-status.md`。

---

## 動機

現況每個 500ms tick 實際發生的事：

```text
[Rust svwb-capture-tool.exe]  DWM frame（BGRA，記憶體）
        │  PNG 編碼
        ▼
    svwb.png.tmp.png → rename → svwb.png        ← 磁碟
        │
        ▼
[JS utilityProcess]  loadFrame(path)
        │            └→ [Rust addon] PNG 解碼 → 灰階 → 裁切 → 3 scale + integral
        │  每個 ROI 一次 napi 來回（每 tick 20 次 match()）
        ▼
    JS 狀態機（forkedImageAnalyzer.ts, 1270 行）
        │  tesseract.js WASM 讀數字
        ▼
    addMatch / modifyMatchX（21 處）→ Prisma engine（21MB DLL）→ SQLite
```

### 三個結構性缺陷

**D-1｜兩個 Rust 程式透過磁碟上的 PNG 溝通，中介是 JS。**
`tools/capture` 與 `tools/vision-node-addon` 同屬一個 Cargo workspace，卻要靠
PNG 編碼 → 寫檔 → rename → 讀檔 → PNG 解碼 才能傳遞一張 bitmap。這是系統中
最大的固定成本，且無法用調參解決。

**D-2｜狀態機在錯的位置，導致測試測的是副本。**
`forkedImageAnalyzer.ts` 模組頂層直接執行 `process.parentPort.on(...)`（:230），
`analyzeOnce(port: MessagePortMain)` 直接吃 Electron 型別（:529），中途直連
Prisma（:899）。因此**無法被載入測試**。
於是 `tools/vision-node-addon/replay-recording.cjs` 長出 953 行手抄副本，該檔案
自己的註解已載明可能與正式版漂移（:26）。
結果：`vision:replay-*` 六個綠燈證明的是副本正確，不是產品正確。這比沒有測試
更危險，因為它讓人以為有覆蓋。

**D-3｜用 Tesseract WASM 讀固定字體、固定位置的 0-9 數字。**
已有帶 integral image 的多 scale 模板比對器，卻額外背 5MB traineddata + WASM
runtime，並衍生整套重試 / 游標遮擋補償邏輯（`--fail-first-ocr` 選項即其證據）。

### 佐證數據（2026-08-28 量測）

| 項目                         | 實測                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `app.db` 大小 / `Match` 筆數 | 250 KB / 324                                                                       |
| `node_modules/.prisma`       | 183 MB（含 8 份殘留的 21MB `.tmp*` DLL）                                           |
| 打包進安裝檔的 Prisma engine | 22 MB                                                                              |
| `forkedImageAnalyzer.ts`     | 1,270 行（註解 402、空行 102、`console.*` 44、**實際邏輯 ≈700**，狀態機核心 ≈400） |
| `replay-recording.cjs`       | 953 行（狀態機手抄副本）                                                           |
| renderer                     | 11,044 行（本計畫不動）                                                            |
| 既有 Rust                    | 1,480 行                                                                           |

查詢效能不是問題，現在不是、將來也不會是：324 筆資料、已建 11 個索引。
「效能」在本計畫中指的是啟動延遲、tick 預算、安裝檔體積，不是查詢吞吐。

---

## 目標架構

**一個 Rust 行程擁有從畫格到落地的完整感知鏈；Electron 只負責呈現。**

```text
[svwb-engine.exe]  Rust，單一行程，全程記憶體內
    capture ─→ frame ─→ 辨識（含數字模板）─→ 狀態機 ─→ SQLite 寫入
        │  stdout: 事件流（JSON Lines）    stdin: 指令
        ▼
[Electron main]  薄殼：視窗 / 托盤 / 更新 / HUD / 監督引擎行程
        ▼
[Renderer]  React + MUI（不動）
            讀 SQLite（統計查詢 + 使用者編輯）via Kysely + better-sqlite3
```

### 已定案的決策

| #   | 決策                                                                   | 理由                                                                                                                              |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | 引擎是**獨立 exe**，不是 napi addon                                    | ① 可脫離 Electron 執行 → replay 測試跑的就是出貨的狀態機，D-2 在結構上被消滅 ② 崩潰隔離（連續運行數小時）③ 不被 Electron ABI 綁定 |
| A-2 | 協定用 **JSON Lines over stdio**                                       | 事件率每秒個位數，序列化成本無意義；人眼可讀、可 `> log.jsonl` 存證、測試不需 harness                                             |
| A-3 | **DB 檔案共用**，引擎寫入 / UI 讀取 + 使用者編輯，WAL + `busy_timeout` | 明確否決「UI 所有查詢都問引擎」：那會讓改一個 SELECT 要 `cargo build`，把 UI 迭代綁死在 Rust 編譯上                               |
| A-4 | `resources/migrations/*.sql` 維持唯一 schema 真相，由引擎在啟動時套用  | 避免再次出現 `schema.prisma` 這種平行真相                                                                                         |
| A-5 | 數字辨識改用**模板比對**，移除 tesseract.js                            | 固定字體、固定 ROI、只有 0-9；既有比對器可直接使用                                                                                |
| A-6 | **不換 Electron**（不轉 Tauri）                                        | HUD 點擊穿透、`node-window-manager`、`extract-file-icon` 皆為 Electron/Node 綁定。本架構完成後外殼變成可抽換，決定被推遲而非鎖死  |

### 明確不做的事

- 不動 renderer 的 11,044 行 UI。
- 不引入第二套 schema 定義（ORM 產生器、Rust 端 migration DSL 皆不採用）。
- 不讓引擎變成 query server。
- 不在本計畫內改變任何辨識閾值或 ROI 座標；那是獨立議題。

---

## 路線圖

七期。**每一期都獨立可驗收、可單獨回退，且不產生之後要丟棄的成果。**

### P0｜止血（0.5 天）

先讓現況停止惡化，與後續無耦合。

- [x] `package.json` 的 `dev` / `start` / `build` / `db:migrate:dev` 把裸 `prisma` 改為 `pnpm exec prisma`
      —— 錯誤訊息「datasource property `url` is no longer supported」來自 Prisma 7 CLI，本專案鎖 6.12.0，
      是 `pnpm dlx` / 編輯器擴充等外部 CLI 造成。**不升 Prisma 7**（即將移除，不值得建 `prisma.config.ts`）。
- [x] 清除 `node_modules/.prisma/client/*.tmp*`（8 份 × 21MB 殘骸）。
- [x] `package.json` 的 `files` / `extraResources` 中 `node_modules/.prisma/**/*` 加排除規則，
      避免殘骸被打包進安裝檔。
- [x] 修 `plazaDetect` 跨 tick 殘留（見「已知缺陷」B-1）。

**驗收**：`pnpm build` 產物中不含 `.tmp*`；`pnpm vision:verify` 全綠。

**執行結果（2026-08-28）**：四項全部完成。`node_modules/.prisma/client` 183 MB → 22 MB。
`pnpm typecheck:node`、`pnpm lint`、`pnpm vision:verify`（14 項，exit 0，cargo test 13 passed）皆通過。

註：`vision:verify` 對本次改動**不具鑑別力** —— `replay-recording.cjs` 不 import
`forkedImageAnalyzer.ts`，六個 `vision:replay-*` 也不在 verify 鏈中。這正是 D-2 的現場示範：
改了產品狀態機，測試套件在結構上感覺不到。P2 完成後這條註記即失效。

---

### P1｜引擎骨架 + 探測搬入（**不碰 capture，不碰狀態機**）

建立 `tools/engine` crate，把探測（template matching）搬進去。
**幀來源此期照舊是磁碟上的 `svwb.png`** —— 這一期刻意不動 capture，理由見「修訂紀錄 R-1」。

- [x] 新增 `tools/engine` crate 至 workspace，依賴既有 `svwb-vision-native`。
- [x] 定義事件協定 struct（`src/protocol.rs`）。
- [x] 定義 `FrameSource` trait 與 `FileSource` 型別（`src/frame_source.rs`），實作待填。
- [x] ROI 表、template set 名稱、scale、threshold 搬進 Rust（`src/calibration.rs`），成為唯一來源。
- [x] `FileSource::next_frame` 實作 + `Frame::from_image` 正規化（`src/frame.rs`）。
- [x] `TemplateStore`（`src/templates.rs`）：模板載入 + `best_in`，scale 由 set 決定而非由呼叫端傳入。
- [x] `BP_LAYOUT` / `MP_CURSOR_WINDOWS` 補搬（先前只搬了 `visionNative.ts` 的，漏了 `forkedImageAnalyzer.ts` 的）。
- [x] `calibration::PROBES` 探測登錄表：一個 tick 探測哪些窗口，從此有單一答案可列舉。
- [x] 比對工具：`svwb-engine probe-dump` + `dump-probes.cjs` + `check-engine-parity.cjs`，
      已納入 `vision:verify`（現為 16 項）。

**驗收**：對全部既有 fixture，引擎算出的每個 ROI 分數與 napi addon **逐項相同**。
**回退點**：JS 側 `visionNative.ts` 完整保留，此期不刪任何東西。

**驗收結果（2026-08-28）：通過。**

```
engine vs addon parity: 34 fixtures x 21 probes = 714 comparisons
  probes that found nothing: 0
  identical on every row - the engine reproduces the addon
```

714 筆逐行比對零差異，涵蓋 1280 windowed 與 1920 fullscreen 兩種版面、7 個 fixture 目錄。
非空洞比對：0 個 null 命中、641 個相異分數、範圍 0.000–1.000。
`pnpm vision:verify` 16 項 exit 0；workspace 測試 25 passed。

比對工具的關鍵設計：**探測登錄表只有一份定義**。`svwb-engine probes` 輸出它，Node 端讀取它。
兩邊各自維護一份表的話，比對測的就只是「我有沒有把表抄對」，而不是正規化與比對邏輯是否等價 ——
而手抄表正是本專案長出 `check-rois.cjs` 與 953 行 replay 副本的起點。

`dump-probes.cjs` 與 `check-engine-parity.cjs` 是**有明確結束日期的暫時產物**：P3 addon 退場時一併刪除。

**已定案的協定決策（2026-08-28）**：

- `MatchRef(u64)` 是**引擎自己配發的 handle，不是資料庫 id**。P4 之前由 host 建立資料列
  並持有 `MatchRef -> Match.id` 的對應。引擎絕不能知道資料庫 id，否則狀態機又變成
  「沒有資料庫就測不了」—— 正是本計畫要消滅的缺陷。P4 落地時消失的是那份對應表，不是這個型別。
- `MatchPatch` 所有欄位帶值，`None` 表示「本次事件未解出」而非「清空」。落實判斷題 D-4。
- `BattleStatus` 用 `ownClass` / `enemyClass`，`MatchStarted` 用 `myClass` / `oppoClass`。
  兩套詞彙刻意保留：renderer 已在用前者、`Match` 資料表已在用後者，統一就得改 renderer，
  而本計畫明訂不動 renderer。
- `Confidence` derive `Ord` 而非手寫查表，弱訊號不得覆蓋權威訊號這件事交給型別系統。

---

### P2｜狀態機移植 + 消滅全部手抄品（消滅 D-2）★ 本計畫核心

狀態機移入引擎，引擎往 stdout 發事件，**DB 寫入仍由 JS 用現有路徑執行**。
幀來源仍是 `svwb.png`。刻意不與 P4 合併：「移植狀態機」與「換資料層」必須是兩次獨立可驗證的變更。

- [x] 依「狀態盤點」建立 `Phase` enum（`src/phase.rs`），取代 `inBattle` / `isMatchRecord` /
      `isResultMidDetect` / `activeMatchId` 四個變數的隱式編碼。涵蓋性由
      `every_analyzer_guard_maps_onto_exactly_one_shape` 驗證，非目測。
- [x] 移植純函式與去抖，依詞彙表改名（`best_above` / `read_play_order` / `parse_signed_int`）。
- [x] **時鐘注入**：`Machine::tick(&mut self, reading, now: Instant)`（見判斷題 D-2）。
- [x] 去抖收斂為單一 `Debounce`（見判斷題 D-3），位置穩定性檢查成為**預設**而非 plaza 特例。
- [x] `tick` 轉移邏輯（`src/machine/tick.rs`）：suppression / mode / start / splash /
      final screen / hold / timeout 七段。
- [x] 情境測試（`src/machine/scenarios.rs`）：14 個，每個對應一則事故註解。
- [x] `Reading` 產生器（`src/reading.rs`）：探測分數 + 門檻 -> `Reading`。
      唯一比較分數與門檻的地方。含 `best_above` / `read_play_order`（含敵方側反轉）/
      `read_score_system`。
- [x] crate 改為 lib + bin，讓整合測試能驅動真實管線（`tests/fixtures.rs`，8 個，
      對 34 張出貨 fixture 斷言**結論**而非分數）。
- [x] `svwb-engine read-dump` 子命令。
- [x] `NumberReader` 接縫（P6-a，`src/numbers.rs`）：trait + `NoNumbers` 實作 +
      `read_all()`（版面位移、BP/MP 分支、2Pick 自有版面、游標遮擋判定）。
      「該讀哪些窗口」放在這一層決定，因為那取決於畫面而非辨識器。
      `parseBPGain` 依詞彙表改名為 `parse_signed_int`。
- [x] `HostChannel`（`src/host.rs`）：stdin 解多工（command 與 reply 同管道）、
      `Inbox` 三態（含 HostGone 乾淨退出）。引擎送二值化裁切 PNG（base64，約 460 bytes），host 回傳文字。
      live 模式下 Electron 走完全相同的協定；replay 時由一個**單一長駐**的 Node helper
      扮演 host（維持一個 tesseract worker，不是每次讀取 spawn），它同時是 host 端的參考實作。
      **這是刪除 `replay-recording.cjs` 的前提**，因為 `bp: 8` 是引擎唯一還做不到的斷言。
- [x] `svwb-engine live`（`src/live.rs`）+ Electron 監督端（`engine.ts`）。

**已知覆蓋缺口**：沒有任何靜態 fixture 呈現「對戰開始」的職業 + 先後手畫面，
因此 `Reading::versus`（職業對、徽章 fallback、敵方側反轉）只有單元測試涵蓋邏輯，
沒有任何真實畫面證明它會觸發。`tests/fixtures.rs::no_still_fixture_shows_a_versus_screen`
把這個缺口寫成一個會失敗的測試 —— 哪天有 fixture 開始呈現 versus 畫面，它會失敗並要求
把該 fixture 升級成正式斷言。缺口在引擎能端到端 replay 錄影後關閉。

- [x] 接合面定案（`src/machine.rs`）：`Reading`（本 tick 看到什麼）/ `Change`（決定了什麼）/
      `Machine`（持有跨 tick 狀態）。`Machine::tick(&mut self, reading, now) -> Vec<Change>`，
      不碰影像、資料庫、message port。
      **修正**：初版設計成回傳 `Outcome { phase, changes }`，那假設了 `Phase` 就是全部的狀態。
      不是 —— mode + confidence、累積中的 `MatchPatch`、三個 debounce、每個數字的共識、
      `MatchRef` 計數器都跨 tick 存在，且都不屬於 phase。可測性靠的是**不做 I/O**，不是不可變。
- [x] `Debounce` / `Consensus` 收斂（`src/accumulate.rs`），含 `Agreement::Consecutive`
      （動畫值）與 `Agreement::Tally`（靜態值，落實 P6-b）。
- [x] 事件協定落地：`Change` -> `Event` 映射（`live.rs::apply`，total match，新增
      `Event::MatchAbandoned` 與 `Event::NearMiss`）。
      **事件 payload 必須帶值**，不可只當「請重新查詢」的訊號（見判斷題 D-4）。
- [x] `svwb-engine replay <video> --expect '{...}'`（`src/replay.rs`）：ffmpeg 分段抽幀 +
      合成時鐘，跑**出貨的狀態機**。五個錄影全數通過。
- [x] **刪除 `replay-recording.cjs`（953 行）**、`forkedImageAnalyzer.ts`（1,281 行）、
      `analyzer.ts`（161 行）。

**執行結果（2026-08-28）**：五個錄影全部通過，含職業對、先後手、模式、勝敗。
`witch vs bishop (second)` 等結果**關閉了 `Reading::versus` 的覆蓋缺口** —— 敵方側先後手反轉
首次由真實畫面證明會觸發。診斷亦如設計般運作：ranked 錄影報 `ranked-no-numbers Some(Bp)`，
custom 錄影報 `final-screen-never-seen closed-by-timeout`。

**已刪除（2026-08-28）**：`replay-recording.cjs`、`forkedImageAnalyzer.ts`、`analyzer.ts`，
共 2,395 行。host 端新增 498 行（`engine.ts` 325、`engineNumbers.ts` 83、
`replay-with-numbers.cjs` 90），**JS 側淨減 1,897 行**。

解鎖的關鍵是 `svwb-engine replay --numbers host`：BP 值現在由引擎斷言
（`bp=Some(8)`），那是舊 harness 最後一項引擎做不到的事。

驅動它的 `replay-with-numbers.cjs` 只有 90 行且**不含任何決策邏輯** —— 只回答問題、轉發輸出。
這是它與那 953 行副本的根本差別：**它不可能與出貨邏輯漂移，因為它裡面沒有邏輯。**
而且它與 Electron 用的是同一套協定，所以協定破掉會在數秒的 fixture 執行裡爆，
而不是在使用者的對戰記錄裡。

**引擎已成為正式路徑**：`index.ts` 的延遲載入改指 `engine.ts`，
`extraResources` 與 `build:win` 都已包含 `svwb-engine.exe`。

#### 子計畫收尾：check 套件手抄品處置（2026-08-28，完成）

一個早前的文件編輯誤刪了本子計畫的清單段落；此處為權威記錄。
**刪除任何測試都必須指名接手者**，對照如下：

| 已刪除                                              | 職責由誰接手                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `check-rois.cjs`                                    | 職責（兩份 ROI 表是否一致）在單一來源下不存在                                           |
| `check-scales.cjs`                                  | `tests/fixtures.rs` 以出貨 scale 走完整管線斷言判定                                     |
| `check-score-system.cjs`                            | `fixtures.rs::ranked_result_screens_report_their_score_system`                          |
| `check-unattributable.cjs`                          | `fixtures.rs::quiet_screens_stay_quiet` + 各結算畫面測試                                |
| `check-custom-roi.cjs`                              | `fixtures.rs::the_custom_room_is_recognised...` + quiet screens                         |
| `check-history-roi.cjs` / `check-replay-chrome.cjs` | `fixtures.rs::replay_signals_are_found_at_both_resolutions`                             |
| `check-cpu-label.cjs`                               | `fixtures.rs::the_cpu_label_is_found_on_both_screens_that_show_it`                      |
| `check-result-fade.cjs`                             | `fixtures.rs::a_fading_in_result_screen_has_a_banner_but_no_label_yet`                  |
| `scan.cjs`                                          | `svwb-engine probe-dump` 做同一件事，且吃單一來源的登錄表                               |
| `verify.cjs`                                        | 驗證的是已完成的窄窗口遷移，歷史任務結束                                                |
| `bench-tick.cjs`                                    | 量的是 addon 路徑，已非出貨形狀，留著會誤導；正式環境由引擎發 `SlowTick`                |
| `visionNative.ts`（437 行）                         | 死碼：唯一使用者已刪。`matches_the_typescript_table` 守衛測試依其自述的刪除條件一併退役 |

`check-ocr-numbers.cjs` **保留但改接引擎**：12 個硬編窗口歸零，裁切改由 `svwb-engine crop`
供給 —— 走 `number_window -> shift_roi -> binarize_to_png` 的正式路徑，所以它從此驗證的是
**引擎實際送去 OCR 的像素**。11/11 通過。

`check-diagnostics.cjs` / `check-bundle.cjs` 保留（純記帳，host 端仍擁有的職責）。
frame 節流/上限的測試移至 `tools/engine/src/diagnostics.rs::tests`。

`vision:verify` 鏈由 16 項縮為 7 項，exit 0：
cargo test（含 fixtures 整合測試）→ clippy → check-diagnostics → check-bundle
→ engine:build → check-ocr-numbers → engine parity。

`tools/vision-node-addon/` 由 19 個 `.cjs` 縮為 7 個，其中 `dump-probes` 與
`check-engine-parity` 於 P3 addon 退場時一併刪除。

---

### P3｜capture 併入引擎（消滅 D-1）

此時探測與狀態機都已在引擎內，本期是**純內部改動**：`FrameSource` 換一個實作而已。
沒有任何跨行程傳遞畫面的橋接程式碼需要寫，也沒有需要刪的。

- [x] `CaptureSource`（`src/capture_source.rs`）：WGC free-threaded 進單幀 slot，BGRA→RGBA
      （PNG 路徑的通道序是所有閾值的量測基準，不換序會靜默偏移每個分數）。
      `tools/capture` crate 保留為回退點，`svwb-capture-tool.exe` 暫續打包。
- [x] `manageCaptureTool.ts` 已刪除；host 只送 `attach {hwnd}` / `detach`（HWND 偵測是
      Electron 綁定，依 A-6 留在 host）。attach **冪等**：host 每秒輪詢重送，
      這同時就是引擎重啟後自動恢復擷取的機制。
- [x] `svwb.png` 不再有任何寫入者。`clearCaptureImage` 保留一次性清理舊版殘檔；
      `FileSource` watch 模式保留供測試（`live --image`）。

**驗收**：`svwb.png` 不再被寫入磁碟；六個 replay fixture 仍全綠（`FileSource` 保留供測試用）。
**回退點**：保留舊 capture exe 至本期驗收通過。

**執行結果（2026-08-28）**：對真實視窗（VS Code，HWND 實測）端到端擷取成功：
attach → 4 秒 8 幀（每 tick 一幀）→ detach 回報 `framesSeen: 8` → stop 乾淨退出。
壞 HWND → `Failed{fatal:false}`，引擎續跑。cargo 70 tests、clippy 0、replay 全綠。

**兩個實測抓到的行為差異，已修**：

1. **WGC 只在內容變化時送幀**（靜止的 VS Code 4 秒只送 1 幀），而舊管線每 tick 重讀同一個
   PNG —— 共識規則（`Tally(3)`）建立在「靜止畫面也被重複讀」之上。`CaptureSource` 因此
   clone-and-keep 而非 take：把「畫面停止動畫」和「畫面消失」區分開，否則每個 Tally 共識
   都會靜默餓死。
2. **attach 必須冪等**：host 每秒重送，重啟 WGC session 會每次輪詢都掉幀。

**新增 `Event::CaptureChanged { attached, frames_seen }`**：「attached 但零幀」與
「畫面上沒有遊戲」從外部無法區分，而那正是使用者回報「沒記錄到」時需要拆解的歧義。

**尚待使用者以真實遊戲驗證**（本機無遊戲執行中）：對 SVWB 視窗的實際擷取、
最小化/還原的 detach/attach 循環、以及一場完整對戰的記錄。驗證通過前，
舊 capture exe 與 crate 保留為回退點。

---

### P4｜引擎直寫 SQLite

- [x] rusqlite（bundled）寫入（`src/store.rs`），WAL + `busy_timeout 5s`。
      **相容性即契約**：DateTime 存 epoch 毫秒 INTEGER（對真實使用者 DB 驗證，非文件推測）、
      `result` 0/1、`year/month/day` 本地時區（鏡射 JS `getFullYear()`）、
      `durationTime` 整數秒。7 個 store 測試以出貨的 `resources/migrations/*.sql` 驗證。
- [x] **migration 所有權一次性交棒**（判斷題 D-5）：`svwb-engine migrate --db --migrations`
      為唯一 owner。host 的 `initDb.ts` 縮為薄殼（~55 行）：解析路徑 → 同步跑 migrate →
      設 `DATABASE_URL` 給 UI 的 Prisma。備份邏輯（保留最近 5 份）一併移入引擎。
      實測冪等：乾淨 DB `applied:7`，再跑 `applied:0`，6 表 / Match 21 欄與 DDL 一致。
- [x] **寫入時機（判斷題 D-1 結案，與原提案不同）**：逐項即時寫入，不批次。
      批次的動機是 Prisma engine 的每呼叫開銷；in-process sqlite UPDATE 是微秒級，
      動機已消失，而即時寫入保留了「提早寫結果以求當掉存活」的性質。
      `isModifyX` 旗標早在 P2 由 `Consensus` 消滅。
- [x] JS 側 analyzer 寫入路徑全數移除：`database.ts` 整檔（196 行）已無人 import，刪除。
      `engine.ts` 的 `ref -> Match.id` 對應表移入引擎的 live 層（狀態機仍不知道 row id）。
      host 對 match 事件只剩 broadcast / 通知 / 快取失效。

**驗收**：replay fixture 產生的 DB 內容與 P2 前逐欄位一致。

**執行結果（2026-08-28）**：cargo 75 tests、clippy 0、typecheck/lint 0、replay 回歸 OK。
`live` 亦接受 `--db/--migrations`（不傳則 events-only，供測試）；host spawn 兩者皆傳。
**驗收的逐欄位比對與 P3 的真機驗證合併**：需要一場真實對戰寫進 DB 後與舊版列比對，
本機無遊戲執行中，待使用者驗證。

---

### P5｜UI 端 Prisma 退場

- [x] Kysely + better-sqlite3（`src/main/data/db/client.ts`）。`Database` interface 手寫，
      **描述既有 schema 而非宣告新 schema** —— `resources/migrations/*.sql` 仍是唯一真相。
      邊界 mapper 完整重現 Prisma 的轉換（epoch 毫秒→`Date`、0/1→boolean），renderer 無感。
- [x] 全部 ORM 呼叫移植完成：`tags.ts`（pattern）→ `decks.ts` → `matches.ts` → `helper.ts`
      → `supportPrompt.ts`（盤點時漏掉的第五個消費者）。keyset 分頁的 row-value 比較
      維持 raw SQL（OR 展開會退化成 index scan，理由與舊版相同）。
- [x] 刪除 `prisma/` 整目錄、`prismaClient.ts`、`database.ts` 殘餘、Prisma 相依與打包 glob。
      24 個檔案的 `@prisma/client` 型別 import 改指自有的 `src/shared/domain.ts`
      （enum 以 const 物件 + union type 重現，值用法 `GameMode.ranked` 等不變）。
- [x] 三個 3 秒 TTL 快取全刪（helper.ts、decks.ts、statsCache.ts 本體），連同 version 記帳。
      in-process 聚合是微秒級，快取的存在理由隨 Prisma 一起消失。

**驗收**：拔掉快取後切換 filter 仍流暢（即證明 overhead 已消失）；安裝檔縮減約 22 MB。

**執行結果（2026-08-28）**：typecheck/lint 0、**vitest 48/48**、engine replay 回歸 OK。
對真實使用者 DB 副本冒煙：多鍵排序、聚合、winrate groupBy、keyset cursor 正確接續、
關聯 join、毫秒→Date 轉換全過。`node_modules/.prisma`（22MB）與 `@prisma/*` 已消失。

**測試套件本身也是本期產物**：先前盤點漏了 `tests/`（複數）目錄 —— 7 個 vitest 檔中
6 個 import 已刪模組。全數移植：`helpers/db.ts` 改由 `svwb-engine migrate` 建測試庫
（migration owner 進了測試迴路）；`ipcSmoke` 揭露 `getPage` 回樞紐形
`tags:[{tag}]` 而 `queryList` 回攤平形 —— **回傳形狀是 IPC 契約**，已補 `toPivotShape`
還原。`statsCache.test`（主體已刪）與 `resultLayout.test`
（斷言由 `calibration.rs` 的 shift/offset 測試接手）退役。

**待真機驗證**（與 P3/P4 同批）：UI 實際開起來滑動列表、編輯對戰、看統計。

---

### P6｜數字讀取的可靠度（取代原「數字模板取代 tesseract.js」）

**原本的 P6 是「換掉 tesseract」。重新評估後，這個框架是錯的**：那是辨識器層的選擇，
而可靠度應該來自**冗餘與交叉驗證**，也就是系統層。做完系統層之後，用哪個辨識器的重要性大幅下降。

原本對 tesseract 的四條指控，兩條站不住（見「修訂紀錄 R-5」）。且目前**沒有任何證據**顯示
tesseract 在正式環境讀錯 —— `check-ocr-numbers.cjs` 的 11 個案例全數通過。

#### P6-a｜`NumberReader` 接縫（無阻塞，優先）

照 `FrameSource` 的模式開一個邊界，而非一座橋：

- `HostReader` —— 問 JS 的 tesseract（現行）
- `TemplateReader` —— 數字模板（條件性，見 P6-c）
- 測試 stub —— 讓狀態機測試完全不碰數字辨識

這不是權宜之計。數字讀取有多種來源本身就是合理的，正如 `FileSource` 不是鷹架
（replay 永遠會用它）。

#### P6-b｜靜態值多幀共識（**已完成**，隨 P2 落地）

結算畫面停留 2.5s+，保留期另有 5s —— 同一個靜態數字有 **5 到 10 次觀察機會**，目前只用一次。

現況有一個講不通的不對稱：

| 欄位                         | 性質                              | 現行接受條件           |
| ---------------------------- | --------------------------------- | ---------------------- |
| `totalMp` / `currentCr`      | **會跑動畫**（88638→88754→88762） | 連續兩 tick 相同才接受 |
| `bp` / `deltaMp` / `deltaCr` | **靜態，畫出來就不動**            | **第一次讀成功就接受** |

反了。會動的值拿了共識，不會動的值反而單次採信 —— 而後者的共識是免費的。
改成靜態值也取多幀共識，且**與辨識器無關**。

#### P6-c｜模板收割（**收集機制已完成 2026-08-28**，接手條件未達）

正常遊玩時，每次 tesseract 讀出值就把該 ROI 切成字形、以 tesseract 的答案為標籤存下，
只保留乾淨分割的（字形數 == 字串長度）。累積數十場後 0-9 兩種尺寸自然齊全。

模板因此從「要人工蒐集的資產」變成**自動衍生的資產**，消除下述阻塞。
驗收：拿收割的模板在留出資料上與 tesseract 比對，**贏了才接手**。

**實作（2026-08-28）**：兩條收割路徑都已上線 ——
`replay-with-numbers.cjs --harvest <dir>`（對錄影，實測 3 張 `+8`）與
`engine.ts::harvestDigits`（正常遊玩，存入診斷目錄 `digits/`，每次啟動上限 300 張、
跟隨診斷 opt-out）。`TemplateReader` 本身**刻意不寫**：接手條件（在留出收割資料上
贏過 tesseract）尚無資料可判。

#### 為什麼現在不能直接做模板（2026-08-28 實測）

`resources/templates/` 14 個 set 中**沒有數字集**。從現有 fixture 擷取並逐字元分割後：

| 字元    | 觀察到的尺寸（寬×高）                   |
| ------- | --------------------------------------- |
| `+`     | 8x10, 8x11 ×3, 8x12                     |
| `-`     | 6x2                                     |
| `1`     | 8x16 ×2, 9x16, 10x16 ×2, 9x20 ×2, 10x20 |
| `2`     | 12x16 ← 僅 1 樣本                       |
| `3`     | 10x16, 14x23, 15x23                     |
| `4`     | 11x16, 12x16, 14x22                     |
| `5`     | 10x16, 12x22 ×2, 13x22                  |
| `6`     | 11x16 ← 僅 1 樣本                       |
| `7`     | 12x16, 14x22                            |
| `8`     | 10x16, 13x21, 14x21                     |
| `9`     | 13x23 ← 僅 1 樣本                       |
| **`0`** | **不存在**                              |

四個問題：

1. **`0` 在所有 fixture 中一次都沒出現。** 10 個期望值湊巧無 0，而 0 在真實資料極常見
   （CR 1500、MP 41,0xx、BP +20）。無樣本即無法建模板，也無法推導。**此項單獨即構成阻塞。**
2. **字型有兩種尺寸。** 小字（~16px 高）用於**差值列**與 BP；大字（~21-23px）用於**累計列**。
3. **數字會黏連。** `41743` 分割成 4 塊（`43` 併成 29px 連通區）。故不可「先切再分類」，
   必須滑動窗口比對 —— 既有比對器即是如此，不成問題，但確認了沒有捷徑。
4. **樣本過少。** `2` / `6` / `9` 各僅 1 樣本，且只在小字尺寸。

P6-c 的收割機制正是為了自動解除第 1、4 項。

#### P6-d｜算術一致性：**只作輔助，不得作為判準**

`本場.mp - 本場.delta_mp == 上一場.mp`（CR 同理）這條等式，曾被考慮拿來做錯誤偵測與修復。

**不可以。使用者不一定每次打牌都開著本應用**，因此資料庫中相鄰的兩場在現實中未必相鄰。
跨賽季重置與手動編輯只是次要的加重因素。

關鍵在於它是一個**不對稱訊號**：

| 情況           | 意義                                                 | 允許的行動                       |
| -------------- | ---------------------------------------------------- | -------------------------------- |
| 等式**成立**   | 有資訊。兩個獨立來源（本場讀值、上一場存值）互相印證 | 可用於**提升信心**               |
| 等式**不成立** | **無資訊**。無法區分「讀錯」與「中間有未記錄的對戰」 | **不得有任何行動，連診斷都不報** |

因此唯一正當的用法是**縮短共識門檻**：某次讀值若與 `上一場 + 差值` 相符，
可以用較少的幀數接受它（P6-b 的共識要求下修）。

**明確禁止**：據此修復讀不到的值、據此否決讀到的值、據此發出診斷或警告。
失敗方向的誤報率過高，任何以它為判準的機制都會製造雜訊或錯誤資料。

---

## 修訂紀錄

保留原因與結論同等重要 —— 沒有這一節，之後很容易把順序改回去。

**R-1｜2026-08-28：capture 併入從 P1 移到 P3，探測改為 P1。**

原始計畫的 P1 是「把 capture 併進引擎、frame 留在記憶體，辨識邏輯照舊由 JS 驅動」。
這是矛盾的：frame 在引擎行程的記憶體裡，辨識卻在 JS 的 utilityProcess —— 另一個行程。
`svwb.png` 一旦消失，JS 就拿不到畫面，必須新寫共享記憶體或把原始 bitmap 灌過 stdio，
而這套機制在狀態機搬入的當下整個作廢。這違反本計畫「每一期都不產生之後要丟棄的成果」。

根因：**探測需要 frame、狀態機需要探測，三者是一個原子單位**，原計畫切在錯的位置。

新順序（探測 → 狀態機 → capture）讓每一期都只換一層，且 capture 那一期退化成純內部改動。
同時修正一個優先序倒置：原順序讓 D-1（浪費）先於 D-2（危險）被處理，而 D-2 才是嚴重的那個。

附帶效果：P1+P2 完成即取得本計畫最大一塊價值（手抄品消失、測試開始有意義），
P3 之後皆為可延後的體積與效能優化。計畫因此在中途停下仍然有意義。

**R-2｜2026-08-28：P2 範圍上修，新增「check 套件的 10 份手抄品」子計畫。**

原始計畫只點名 `replay-recording.cjs` 一份手抄品。實測後發現手抄是系統性的：
9/11 個 check 腳本註解含 "Mirrors"，全套件 40 處硬編 ROI 字面量，
且 `check-rois.cjs` 是以文字解析 `visionNative.ts` 的方式在做交叉比對。
常數收進 Rust 後這些全部斷線，必須一併處置。範圍約為原估的兩倍。

**R-5｜2026-08-28：P6 從「換掉 tesseract」改為「數字讀取的可靠度」，並降為條件性。**

原本對 tesseract 的四條指控，重新檢視後兩條站不住：

- 「`--fail-first-ocr` 是不可靠的證據」—— **錯**。該選項測的是**保留期機制**，而保留期存在的
  原因是游標遮擋與計數動畫，兩者都是**遊戲畫面的問題**，換模板比對後原封不動仍在。
- 「冷啟動數百毫秒」—— **已解決**。程式碼早已改為整個行程共用一個 worker。

站得住的只剩體積（5MB traineddata + WASM，佔安裝檔約 2%）與 `O`→`0` 正規化怪癖，兩者都弱。
且沒有任何證據顯示 tesseract 在正式環境讀錯。真正該問的是
`noteEvent('ranked-no-numbers')` 的實際觸發率 —— 那在診斷資料裡，不在推理裡。

真正的問題不是「OCR 好不好」而是「引擎要不要能獨立讀數字」，那是架構問題，
由 P6-a 的接縫解決，與辨識器選擇無關。

**R-3｜2026-08-28：新增判斷題 D-4（事件順序）、D-5（migration 所有權）。**

兩者皆為原計畫的規格空洞，見「判斷題」一節。

## 命名規範

移植不是逐字翻譯。`forkedImageAnalyzer.ts` 有一批名稱在現況已經誤導，照搬過去只會把
問題固化在一個更難改的地方（Rust 改名要重編譯，JS 改名不用）。**P2 的移植必須落在下表
的目標名稱上**，不得沿用來源名稱。

### 原則

1. **名稱說「是什麼」，不說「怎麼實作」。** `isModifyBP` 描述的是一次 DB 呼叫的副作用；
   它真正的意思是「BP 這個欄位已經有值了」，那就該是 `Option<i32>`。
2. **布林旗標若彼此互斥，就不是布林。** 四個旗標編碼一個狀態機（見狀態盤點）→ 一個 enum。
3. **單位進名稱。** `POSITION_TOLERANCE` → `POSITION_TOLERANCE_PX`；`elapsed` → `elapsed_ms`。
4. **名稱不得比實際範圍窄。** 見下表 `parseBPGain`。
5. **與外部資產同名的識別字不自行改名。** template 目錄、SQLite 欄位名是跨系統契約，
   只能整組改或都不改。此類情況改為補註解說明語意（例：`RESULT_MID`）。

### 詞彙表（P2 移植對照）

| 現況（JS）                                                                                | 目標（Rust）                                          | 為什麼                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `inBattle` / `isMatchRecord` / `isResultMidDetect` / `activeMatchId`                      | `Phase` enum                                          | 四個變數編碼同一個狀態機，32 種組合只有 4 種合法                                                |
| `isMatchRecord`                                                                           | （併入 `Phase::InBattle`）                            | 讀起來像型別判斷，實際意思是「有一列開著」                                                      |
| `isResultMidDetect`                                                                       | （併入 `Phase::Resolving`）                           | 實際意思是「已看到戰鬥結束的中央大字」                                                          |
| `isModifyBP` / `isModifyMp` / `isModifyDeltaMp` / `isModifyCurrentCR` / `isModifyDeltaCR` | `MatchPatch` 的 `Option<i32>`                         | 「已寫入 DB」是實作副作用；「已有值」才是語意                                                   |
| `mode` + `modeConfidence`                                                                 | `resolved_mode: Option<(GameMode, Confidence)>`       | 兩者永遠同進退，分開就可能只更新一半                                                            |
| `MODE_CONFIDENCE` 查表                                                                    | `Confidence` derive `Ord`                             | 「弱不得覆蓋強」交給型別系統                                                                    |
| `cpuDetectionHits` / `plazaDetectionHits` / `customDetectionHits` / `lastPlazaHit`        | `Debounce { hits, last_pos }`                         | 三份手抄的同一個東西                                                                            |
| `pendingCumulative`                                                                       | `settling: SettlingCounters`                          | 它擋的是計數動畫尚未停止，不是「待處理」                                                        |
| `ocrGraceUntil`                                                                           | `numbers_deadline`                                    | 綁在 OCR 這個實作上；換成模板比對後名稱就過期（P6）                                             |
| `resultModeDeadline`                                                                      | `mode_deadline`                                       | 對稱化                                                                                          |
| `preBattleModeExpiresAt`                                                                  | （併入 `Phase::Idle { hint: ModeHint { expires } }`） | 不是獨立狀態，見上                                                                              |
| `replayLatchUntil` / `replayLatched`                                                      | （併入 `Phase::ReplaySuppressed { until }`）          | `latched` 只是邊緣偵測的暫存                                                                    |
| `requiredNumbers: 'bp' \| 'mp'`                                                           | `owed: Option<NumberBlock>`                           | 「這張結算畫面欠我們哪一組數字」                                                                |
| **`parseBPGain`**                                                                         | **`parse_signed_int`**                                | **名稱比實際範圍窄**：實際餵給它的有 BP、MP、deltaMp、CR、deltaCR 共 6 個呼叫點，只有 2 個是 BP |
| `recognizeNumber`                                                                         | `read_number`                                         | `recognize` 是 Tesseract 的詞彙，P6 之後不再適用                                                |
| `recognizeGainedMp` / `recognizeTotalMp`                                                  | `read_delta_mp` / `read_cumulative_mp`                | delta / cumulative 是這兩者真正的差別，也正是兩 tick 一致性檢查只套用在後者的原因               |
| `modifyMatchBP` / `modifyMatchMode` / ...                                                 | `MatchPatch` 欄位                                     | `modify` 沒有資訊量；9 個函式塌縮成一個結構                                                     |
| `scoreAndName`                                                                            | `Hit`                                                 | 型別名複述欄位，且順序與宣告相反                                                                |
| `pickBestResult`                                                                          | `best_above(threshold)`                               | 說出門檻語意                                                                                    |
| `bestMatch`                                                                               | `best_of`                                             | 與 `match` 關鍵字撞名                                                                           |
| `layoutDy`                                                                                | `layout_offset_y`                                     |                                                                                                 |
| `SET`                                                                                     | `templates`                                           | 它是 template 目錄名，不是抽象的「集合」                                                        |
| `THRESHOLD`                                                                               | `threshold` 模組                                      |                                                                                                 |
| `ROI`（模組層級）                                                                         | `calibration` 模組                                    | 該模組同時含窗口、scale、門檻、版面位移，`roi` 只涵蓋其一                                       |

### 不改名的部分

- **`forkedImageAnalyzer.ts` 內部不做改名。** 它在 P2 被整檔刪除，改名是純消耗，
  且會讓移植期間的逐行對照失效。
- **renderer（11,044 行）不動**，見「明確不做的事」。
- **`resources/templates/` 目錄名不動**，它同時被 `calibrate.rs` 等校準工具引用。
- **SQLite 欄位名不動**，它是既有資料的契約。`my_class` / `oppo_class` 與 renderer 的
  `ownClass` / `enemyClass` 兩套詞彙並存是刻意的（見 `protocol.rs` 的 `BattleStatus`）。

### 待確認

- `result_mid` 的 `mid` 語意是「畫面中央」還是「中途結果」？目前由窗口位置與呼叫點推斷為
  前者，已在 `calibration.rs` 註記為推斷而非查證。這影響的是註解正確性，不影響行為。

---

## 狀態盤點（P2 的施工圖）

`forkedImageAnalyzer.ts` 模組層共 31 個 `let`。

### 真狀態（實測 20 個，非原估 21 個 —— `inBattle` 不是狀態）

**四個變數在編碼同一個狀態機** —— 32 種布林組合中只有 4 種合法，現無任何機制阻止其餘 28 種：

| 現有條件式                                                              | 真正語意     |
| ----------------------------------------------------------------------- | ------------ |
| `inBattle && !isMatchRecord && !isResultMidDetect`                      | 開場         |
| `isMatchRecord && activeMatchId !== null && resultMid > 0.3`            | 中場結果浮出 |
| `!isMatchRecord && isResultMidDetect && result > 門檻`                  | 最終結算畫面 |
| `activeMatchId !== null && ocrGraceUntil > 0 && pendingResult !== null` | 結算後保留期 |

```rust
// 實際落地版本，見 tools/engine/src/phase.rs
enum Phase {
    Idle             { hint: Option<ModeHint> },
    InBattle         { match_id: MatchRef },
    Resolving        { match_id: MatchRef, result: bool, awaiting: Awaiting },
    ReplaySuppressed { until: Instant },
}

enum Awaiting {
    /// 已看到戰鬥結束大字，最終結算畫面尚未出現；逾時即關閉。
    FinalScreen { deadline: Instant },
    /// 最終結算畫面已出現，保留供數字重試。
    Numbers     { deadline: Instant },
}
```

**兩項與原草案不同，是逐一列舉四個變數的讀寫之後才發現的：**

**① `inBattle` 根本不是狀態。** 它在 `:873` 由當 tick 的探測重算
（`if (!isMatchRecord) inBattle = myValid && oppoValid && turnValid`），唯一的讀取在 10 行後的
`:883`，而該分支要求 `!isMatchRecord` —— 也就是重算必定先跑過。因此它三處 `inBattle = false`
賦值（`:603`、`:969`、`:996`）**全是死碼**：下一 tick 覆蓋之前沒有任何讀取。對外 IPC payload 裡的
`inBattle` 是字面量，不是這個變數。所以它是 tick 區域推導值，不進 `Phase`。

**② 沒有 `PreBattle` 這個狀態。** `:783` 的守衛是
`activeMatchId === null && !isMatchRecord && !isResultMidDetect`，正好等於 `Idle`，而且它不改動
四個變數中的任何一個 —— 只是寄放一個帶 TTL 的提示。原草案的 `PreBattle` variant 不存在，
它是 `Idle` 攜帶的資料。

**③ `Resolving` 有兩種形狀，不是一個計時器。** 原草案用 `ocr_deadline: Option<Instant>` 表示，
實際上 `:988` 的 `ocrGraceUntil === 0` 是一個**再進入守衛**：一旦進入數字保留期，開啟保留期的
那個分支就不得再跑一次去重設它。改成 `Awaiting` 兩個 variant 後，這件事變成結構上不可能。

其餘真狀態分組：

| 組             | 現有變數（行號）                                                                                        | 目標                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 模式 + 信心    | `mode`(342)、`modeConfidence`(391)                                                                      | `Option<(GameMode, Confidence)>` — 綁一起就不可能只更新一半 |
| 數字已寫入旗標 | `isModifyBP/Mp/DeltaMp/CurrentCR/DeltaCR`(344-348)                                                      | P3 重整後消失                                               |
| 數字收集       | `requiredNumbers`(424)、`pendingCumulative`(433)                                                        | `NumberCollector`                                           |
| 四個 deadline  | `resultModeDeadline`(356)、`ocrGraceUntil`(422)、`preBattleModeExpiresAt`(358)、`replayLatchUntil`(411) | 全部依賴 `Date.now()` → 必須注入時鐘                        |
| 去抖           | `cpuDetectionHits`(350)、`plazaDetectionHits`(351)、`customDetectionHits`(354)、`lastPlazaHit`(353)     | 收斂為單一 `Debounce`                                       |
| 其他           | `pendingResult`(355)、`preBattleMode`(357)、`replayLatched`(413)                                        | 併入 `Phase`                                                |

### 應為 tick 區域變數（5 個）

`twoPickDetect`(496)、`cpuDetect`(497)、`plazaDetect`(498)、`ownCustomDetect`(499)、`enemyCustomDetect`(500)

### 純設定（移植後為 const / 建構參數）

`imagePath`(224)、`isPackaged`(225)、`resourcesPath`(226)、`cacheDir`(227)、
`BP_LAYOUT`、`MP_CURSOR_ROIS`、`THRESHOLD`、5 個 `*_MS` 常數、`PLAZA_POSITION_TOLERANCE`

### 移植後消失

`ocrWorker`(73) 及其生命週期管理（P5）、`timer`(278)、`tickCount`(507)

### 外部相依

| 相依                  | 用量                                                                             | 歸屬                  |
| --------------------- | -------------------------------------------------------------------------------- | --------------------- |
| `MessagePortMain`     | 17 次 postMessage，僅 3 種訊息（`inBattle`×2、`matchResult`×2、`modifyMode`×13） | JSON Lines 事件       |
| Prisma                | 21 次呼叫 / 9 個函式                                                             | 引擎內 rusqlite（P3） |
| tesseract.js          | worker + 4 個 recognize 包裝                                                     | 消失（P5）            |
| `visionNative`        | 20 次 `match()` + `detectScoreSystem` + `resultLayoutOffset` + `loadFrame`       | 同行程呼叫，napi 消失 |
| `fs`                  | `existsSync`/`statSync` 輪詢                                                     | 消失（P1）            |
| `diagnosticsRecorder` | `captureFrame`×5、`noteEvent`×3、`noteScore`×3、`noteSlowTick`×1                 | 引擎內模組            |

`modifyMode` 那 13 次都只是叫前端重新查詢 —— 移植後是**一種**事件，不是 13 個呼叫點。

---

## 判斷題（非機械翻譯，需在該期開工前定案）

**D-1｜21 處分散寫入 → 累積後一次落地？**（P4）
`isModifyX` 五個旗標是分散寫入的產物。改為記憶體累積後，它們變成 `Option<i32>::is_some()` 而消失。
建議折衷：開場 INSERT 與結果寫入保留即時（HUD 需求 + 當掉存活），數字累積至 finalize。
數字僅在結算畫面出現，暴露窗口最多 5 秒，風險可忽略。

**D-2｜時鐘必須注入**（P2）
四個 deadline 全基於 `Date.now()`。若 Rust 版直接用 `Instant::now()`，replay 只能實時跑
（5 分鐘錄影跑 5 分鐘）。`replay-recording.cjs` 現正是靠自行重算時間戳繞過此事 ——
這也是它必須手抄狀態機的原因之一。做對之後全套 fixture 迴圈時間從分鐘級降到秒級。

**D-3｜去抖統一**（P2）
三份手抄實作，其中 plaza 版多一個位置穩定性檢查。該檢查的理由（UI 標籤在正規化畫布上
像素穩定、飄動卡牌文字不穩定）**對所有弱訊號都成立**，應成為預設而非特例。

**D-4｜事件與寫入的順序**（P2 定案，P4 生效）
現有的 `port.postMessage({type:'modifyMode'})` 共 13 次，語意是「請重新查詢」。
一旦 P4 把數字延後到 finalize 才落地，事件先發、寫入後到，renderer 回查就會讀到舊值。
**結論：事件 payload 必須帶值**，renderer 不再回查。這同時省掉 13 次無謂往返。
`MatchUpdated { match_id, field, value }` 而非 `MatchUpdated { match_id }`。

**D-5｜migration 所有權**（P4）
引擎與 `initDb.ts` 若都在啟動時套 migration，就是兩個 writer 競爭。
**結論：一次性交棒，絕不並存。** P4 之前 Electron 獨佔 migration，引擎只讀寫資料列；
P4 起引擎接管，`initDb.ts` 的對應邏輯在同一批變更中移除。

---

## 已知缺陷

**B-1｜`plazaDetect` 跨 tick / 跨對戰殘留**（P0 修）
僅在 :1003 賦值（位於 `if (scoreSystem === null && canApplyMode('authoritative'))` 巢狀條件內），
卻在 :1130 另一分支的 `mode-unattributable` 診斷條件中被讀取。
所有 reset 區塊都清了 `plazaDetectionHits` 與 `lastPlazaHit`，唯獨沒清 `plazaDetect` 本身。
**影響**：不影響任何寫入正確性，僅使上一場殘留的 ≥0.7 讓本次該觸發的診斷靜默。
該診斷存在的唯一目的就是抓靜默失效。P2 後此類缺陷結構性消失。

**B-2｜`cpuDetectionHits` 雙重累加語意不明**（P2 釐清）
:772 用 pre-battle 探測累加，:789 用合併分數累加，兩處語意重疊。原意待確認。

---

## 進度

| 期                         | 狀態                                  | 消滅的缺陷 | 淨行數變化（估）               |
| -------------------------- | ------------------------------------- | ---------- | ------------------------------ |
| P0 止血                    | **完成 2026-08-28**                   | B-1        | ~0                             |
| P1 引擎骨架 + 探測搬入     | **完成 2026-08-28**                   | —          | +1,100 Rust                    |
| P2 狀態機移植 + 消滅手抄品 | **主體完成 2026-08-28**               | **D-2**    | +3,900 Rust / −1,897 JS（淨）  |
| P3 capture 併入            | **主體完成 2026-08-28（待真機驗證）** | **D-1**    | +230 Rust / −220 JS            |
| P4 引擎直寫 DB             | **主體完成 2026-08-28（待真機驗證）** | —          | +330 Rust / −340 JS            |
| P5 UI 端 Prisma 退場       | **主體完成 2026-08-28（待真機驗證）** | —          | −900 JS 淨（含 22MB 依賴退場） |
| P6 數字模板                | 未開始                                | D-3        | +300 Rust / −300 JS            |

行數為估計值，僅用於判斷相對規模。時程以週計，非以日計。
P2 的估計已依 R-2 上修（原為 +1,200 / −2,200，未計入 check 套件的 9 份手抄品）。

**真機驗證記錄（2026-08-28）**：dev app 對真實環境完整啟動 ——
引擎 migrate 對真實使用者 DB（`applied:0`）、`Engine ready, 32 templates`、
capture 成功 attach 真實遊戲視窗（ShadowverseWB 執行中）、UI 完整渲染
（對局列表 3 筆，勝敗/先後攻/模式/「未辨識」標籤/時長全部正確）。
`pnpm build` production bundle exit 0。
尚未親眼見證的只剩「新管線記錄一場完整對戰」—— 監看已架好，等一場對戰發生。

啟動驗證順帶抓到並修復：冪等 attach 重送會重複發 `captureChanged`
（host 每秒輪詢重送是設計，事件去重必須在引擎的 live 層做）。
修正已進源碼與測試（67 lib tests）；release 二進位被執行中的 app 鎖住，
下次 `pnpm engine:build` 生效。

**首戰驗證（2026-08-28 下午，通過）**：新管線記錄了第一場真實對戰（Match 339）——
巫師 vs 巫師、先攻、階級對戰、敗北、**BP +24**（引擎裁切 → host tesseract → 三幀共識 →
引擎寫入，全鏈路）、時長 856 秒與 endedAt−playedAt 精確吻合、預設牌組自動帶入、
本地時區 ymd。HUD 於遊戲前景時正確顯示同一場（近期戰績、勝率環、BP 標籤）。
診斷鏈同場驗證：near-miss 聚合進 `events.jsonl`、設定頁計數器即時更新、
live 收割在首戰即取得 3 張帶標籤數字樣本。

對照組：前一列 338 是舊版 app 同日稍早所記 —— `mode: unknown`、零數字。
同一天、同一台機器，這就是重構前後的差距。

**quit 路徑修復（2026-08-28）**：Electron 退出時連續觸發 `window-all-closed` 與
`before-quit`，兩者都 detach+stop，第二輪對已 `end()` 的 stdin 寫入 →
未捕捉 `ERR_STREAM_WRITE_AFTER_END` 彈錯誤框。修法：所有寫入集中到單一
`send()` 檢查 writability，`stopEngine` 先清引用。已以真實 quit 流程驗證
（關閉應用 → 無錯誤、引擎行程 0、`HostGone` 路徑正確收尾）。

**2Pick 校準（2026-08-28，使用者提供 1083 秒全螢幕錄影）**：這是專案第一份 2Pick
素材。先前所有 2Pick 常數都是從舊管線原封搬過來、標記 UNVERIFIED，而這份錄影能查的
兩個常數**都是錯的**。

錄影揭露的事實：結算畫面的獎勵區是**輪播**，「2Pick階級」是最後才轉進來的面板，
實測在結果橫幅出現後 **5.5 秒**才定位於 (783,268)，此後穩定 0.840。

由此連出兩個缺陷，皆已修復並以測試釘住：

1. `MODES_2PICK = (780,295,180,50)` 整個落在標籤**下方**，在標籤明明在畫面上的幀
   只拿到 0.052。`two_pick` 因此從未觸發，`resolve_mode` 掉進 score-system 分支，
   整場 2Pick 敗北被記成 `mode: ranked` —— 污染使用者的階級戰績。
   新值 `(728,248,220,80)`：2Pick 命中 22/39，既有 34 張 fixture **零誤觸**（最高 0.331）。

2. `NUMBERS_GRACE`（5 秒）名義上管數字重試，實際上**也是模式能被確立的全部時間**。
   標籤要 5.5 秒。兩個理由被綁在同一個常數上，是這個 bug 能存在的原因。
   拆出 `timing::MODE_SETTLE = 12s` 作為結算畫面的獨立下限：ranked 只要數字收斂
   仍即刻關閉，不受影響；缺東西的路徑（2Pick 正是如此，它沒有數字可收斂）才等滿。

**順帶抓到的無關缺陷**：score-system 錨點在**應用自己的 HUD** 上誤觸 ——
「階級對戰」徽章拿到 0.759（門檻 0.7），85 幀中 2 幀；同時真正的「BP 0」沒被匹配，
因為 `bp` 模板帶冒號而 2Pick 版面沒有。兩幀就足以定案，因為這是**唯一沒有 debounce
的模式訊號**，且信心度為 Authoritative。已補上 `Machine::ranked` debounce。

**刻意不做的部分**：`BP_LAYOUT_2PICK` 直接刪除，不留猜測值。2Pick 結算畫面有兩個
BP 數字且不可互換 ——「獲得BP +N」是本場獲得（`bp` 欄要的），標籤起於 x1010,y265-292；
右下「BP N」約 (1178,303) 是生涯累計，寫進 `bp` 會把累計當成單場。而這份錄影裡
**使用者自己的 HUD 正好蓋住獲得列**，讀不到 —— 這是真實使用情境，不是錄影瑕疵。
所以 2Pick 現在記錄為「模式正確、`bp` 空白」，即實際已知的部分。修正 `MODES_2PICK`
若不同時拿掉這個窗口，反而會開始把垃圾數字寫進每一場 2Pick。

驗證：76 → 79 測試全通過（新增 2 個 fixture 測試 + 1 個輪播時序情境），
parity 37 fixtures × 20 probes 全等，custom / CPU 錄影回歸重跑無變化。

**2Pick 判定改由 VS 畫面負責（2026-08-28，第二份錄影 win）**：使用者指出
「2pick 在進入對戰的畫面其實就可以被判斷出來」，並回報模式又被記錯。這份 win 錄影
證明他是對的，而且我前一輪的修法根本不夠。

前一輪把 `MODES_2PICK` 修正、把 `MODE_SETTLE` 拉到 12 秒後，這份錄影**仍然**replay
成 `mode: ranked`。原因是勝利會先播 RANK UP 動畫：

| 時點                     | t                   |
| ------------------------ | ------------------- |
| WIN 橫幅過門檻           | 1033s               |
| RANK UP 動畫             | 1035–1039s          |
| 2Pick階級 才可讀（0.82） | **1048s，晚 15 秒** |

15 秒超過機器所有的寬限期；而把寬限期再拉長，只是等第三份錄影來打破它。

更關鍵的是這 15 秒不是空白 —— 畫面上有它自己的「BP 100」，對 ranked 的
「BP :」模板拿到 **0.757–0.787，連續九幀**。所以結算畫面不只是「沒說 2Pick」，
它是**明確地說 ranked**，而且穩定到任何 debounce 都擋不住。

**這同時推翻了我前一輪寫下的推論**：我當時說「`bp` 模板帶冒號，2Pick 版面沒有，
所以不會匹配」。錯的。相關註解與 fixture README 都已更正。

**改法**：新增 `modes_2pick_versus/2pickVersus.png`（80x18，從正規化畫布切出），
配 `TWO_PICK_VERSUS_OWN` / `TWO_PICK_VERSUS_ENEMY` 兩個窗口 —— VS 畫面上**雙方**
都標示「2Pick階級」，任一側即可作答，單角落被遮擋也拿不走訊號。實測 16 幀 VS 序列：
我方 0.962–1.000、對手方 0.851–0.870，全幀命中；對既有 37 張 fixture 最高 0.398。

連帶把 score-system 的 ranked 訊號從 `Authoritative` **降為 `Strong`** —— 它分不出
2Pick 與 ranked 的結算畫面，就不該有權推翻分得出來的訊號。這是事實修正，不是權宜。

**順帶收尾了上一輪掛著的缺口**：lose 錄影裡使用者 HUD 蓋住「獲得BP」，win 錄影沒有，
所以 `BP_LAYOUT_2PICK` 終於量得出來（值在 x1117-1163, y274-290）。兩份錄影的
「獲」「得」「B」落在完全相同的欄位（一份 +0、一份 +100），證實這行是**固定左對齊**
而非置中，所以窗口的餘裕留在右側、停在 ⓘ 標記 x1182 之前。

新增 fixture 集 `2pick-1920-fullscreen-win`（VS 標籤／RANK UP 期的假 ranked 訊號／
遲到的結算標籤各一張）。工具面新增 `svwb-engine canvas` 子命令輸出正規化畫布 ——
模板只能從這裡切，從原始 1920x1080 截圖切出來的模板尺度不對、永遠不會命中。

**自我檢討補上的負例**：我原本用「對既有 37 張 fixture 零誤觸」來背書這個新探測，
但回頭一查，那 37 張裡**一張 VS 畫面都沒有**（全是主畫面、戰場、結算畫面），
也就是說最該測的負例根本沒測到。這個 slot 是遊戲用來寫模式名稱的位置 ——
2Pick 寫「2Pick階級」，階級對戰寫「階級 分組 BP」—— 誤判的代價是把階級對戰記成 2Pick。
補上 `ranked-versus` fixture 集（全螢幕與視窗化各一張），實測 own 0.303–0.316、
enemy 0.346–0.388，門檻 0.7。

**第三份錄影：1282x752 視窗化（2026-08-28）**：使用者再補一把視窗化的過程，補足了
「所有 2Pick 素材都是 1920 全螢幕」這個尺度缺口（1282x752 帶 2px 邊框與 32px 標題列，
連裁切路徑一起測到）。VS 探測**無需任何調整**即命中：12 秒取樣中命中構成
**單一連續 15 幀（7.5 秒）**，邊界乾脆、0.4–0.85 之間無任何邊緣幀，代表這是
「畫面出現」而不是「訊號衰減」。峰值 0.908 低於全螢幕的 0.962–1.000（模板切自
全螢幕畫布，視窗化重採樣不同），但對 0.7 門檻餘裕充足，不需要為每個尺度再切一份模板。
BP 窗口同樣直接沿用，讀出「+130」——與全螢幕那份的「+100」不同值，證實版面一致
不是單一數字寬度的巧合。全鏈路：`mode=TwoPick result=true bp=Some(130)`。

這份也**重演**了結算畫面的陷阱：橫幅 1044.5s、錨點誤報 ranked 至 1046.5s、
2Pick 標籤 1053.5s —— 延遲 **9 秒**，而全螢幕那份是 15 秒。九秒**會**擠進
`MODE_SETTLE` 的 12 秒，這正是危險所在：兩份錄影兩個延遲，都落在一個當初只是
猜出來的窗口裡。把判定移到 VS 畫面，延遲多久就不再有意義。

**價值分界線**：P1 + P2 完成即取得本計畫最大一塊價值（手抄品消失、測試開始有意義）。
P3 之後皆為可延後的體積與效能優化，中途停下仍然有意義。
