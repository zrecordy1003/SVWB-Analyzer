# 架構說明

SVWB Analyzer 是一個 Windows Electron 桌面應用，將遊戲視窗畫面轉換成可查詢的對戰紀錄與統計。

重構的完整決策記錄（為什麼是這個形狀、否決過什麼）在 `docs/engine-refactor-plan.md`。

## 執行流程

```text
shadowversewb.exe
  │  PID / HWND 驗證（Electron main，node-window-manager）
  ▼
svwb-engine.exe（Rust，單一行程，全程記憶體內）
  capture(WGC) ─→ frame ─→ 模板辨識 ─→ 狀態機 ─→ SQLite 寫入
        │  stdout: 事件流（JSON Lines）    stdin: attach/detach/stop + 數字回覆
        ▼
Electron main（薄殼）
  ├─ 監督引擎行程、以 HWND attach/detach 擷取
  ├─ 回答引擎的數字讀取請求（tesseract.js）
  └─ 廣播事件給 renderer、寫診斷記帳
        ▼
React + MUI renderer / HUD
  讀同一個 SQLite（Kysely + better-sqlite3；WAL 讓讀取不擋引擎的寫入）
```

沒有任何畫面資料落地成檔案：舊管線的 `svwb.png` 中繼已移除。

## 主要目錄

| 路徑                          | 職責                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `tools/engine/`               | 感知引擎：擷取、辨識、狀態機、對局持久化、migration owner。可獨立執行。   |
| `src/main/`                   | Electron main：視窗/托盤/更新（`windows/`）、引擎監督與數字回答（`recognition/`）、UI 資料層（`data/`、`ipc/`）。 |
| `src/main/recognition/engine.ts` | 引擎行程的監督者：spawn、事件套用、attach/detach。                       |
| `src/main/data/db/client.ts`  | UI 的資料存取（Kysely + better-sqlite3），含 Prisma 相容的邊界轉換。       |
| `src/main/telemetry/`         | 匿名使用統計（opt-out，告知前不送）：對局列→計數桶的純函式、排程與上傳、IPC。見 `docs/telemetry-dau-plan.md`。 |
| `server/telemetry/`           | 接收上述上傳的 Cloudflare Worker + D1；不屬於 app 打包，獨立部署。         |
| `src/shared/domain.ts`        | 領域詞彙（ClassName / GameMode / PlayOrder / model 型別），24 個檔案共用。 |
| `src/renderer/src/`           | React + MUI 介面、對局列表、統計與 HUD。                                   |
| `resources/templates/`        | 辨識範本；遊戲 UI 改版後優先更新此處。                                     |
| `resources/migrations/`       | SQLite schema 的唯一真相，由 `svwb-engine migrate` 套用。                  |
| `tools/vision-node-addon/`    | 檢查工具（OCR oracle、引擎 parity、診斷記帳測試）。addon 本體僅供 parity 比對。 |
| `tools/capture/`              | 舊獨立截圖器，保留為回退點；正式路徑已由引擎內建 capture 取代。            |

## 視窗、擷取與分析

1. `svwbDetector.ts` 先查詢 `shadowversewb.exe`，再以 PID 對可執行檔路徑驗證，避免僅由視窗標題誤判。
2. `index.ts` 每秒輪詢：遊戲在跑且未最小化 → 對引擎送 `attach {hwnd}`；否則 `detach`。
   attach 冪等，重送即是引擎重啟後自動恢復擷取的機制。
3. 引擎以 Windows Graphics Capture 取得 frame（記憶體內），正規化至 1280×720，
   以校準窗口（`tools/engine/src/calibration.rs`，唯一來源）做模板辨識，狀態機決策後直接寫入 SQLite。
4. 需要讀數字時，引擎送出二值化裁切 PNG，host 以 tesseract 回答；`NumberReader` 是接縫，
   辨識器可換而狀態機無感。

## 對局資料生命週期

引擎在確認對戰開始時建立 `Match` 列並持有 engine-local 的 `MatchRef`（狀態機永遠不知道
資料庫 id，這是它能離線測試的原因）。後續模式、勝敗、數字更新皆寫向該列。

當模式沒有被辨識時，場次結束會標記為 `unknown` 而非 `unranked`，讓「自由對戰」的統計只包含
真正的自由對戰。重播（觀戰記錄）期間開出的場次會被**刪除**而非留白 —— 留白是一筆缺欄位的
幽靈記錄。

數字採多幀共識：靜態值（BP、ΔMP、ΔCR）取多數決，會跑動畫的累計值（MP、CR）要求連續兩幀
一致，避免計數動畫的起始幀被當成結果。

每一筆對局包含職業、先後攻、模式、BP／MP／CR、時間、牌組、標籤與備註等資料。

## 測試

- `cargo test`（`tools/`）：狀態機情境（每個對應一則歷史事故）、校準表、共識/去抖、
  store 對出貨 migrations 的驗證、34 張 fixture 的整合斷言。
- `pnpm engine:replay`：五份錄影跑**出貨的**狀態機端到端，含 BP 值斷言（數字經 host tesseract）。
- `pnpm test`（vitest）：UI 資料層對真實 schema 的 IPC 契約（回傳形狀是契約的一部分）。
- `pnpm vision:verify`：上述 cargo 測試 + clippy + OCR oracle + 引擎/addon parity。

## 範本更新原則

新卡包不會直接影響卡牌資料，因為本程式不辨識個別卡片。只有 UI、職業／模式圖示、結果畫面或
數字區域改變時，才需更新範本或 ROI（`calibration.rs`，附量測記錄）。

更新前後都應保留原始截圖樣本：對戰中、勝利、敗北、階級結算、2Pick、CPU、廣場與自訂對戰。
這些樣本是回歸測試的基礎 —— `tests/fixtures/captures/` 底下的每張圖都被斷言。
