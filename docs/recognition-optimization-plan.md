# 核心辨識優化計畫書

日期:2026-08-26。依據:本日完整影片重播驗證(`CALIBRATION.md` §6)、
`forkedImageAnalyzer.ts` 現行實作、以及 replay harness 實測。
所有問題都有既有工具可以驗證,不需要新素材(P2 除外)。

## 現況

單張畫面的比對與 OCR 視窗已由 9 項離線檢查 + 13 個 Rust 測試 + 影片重播固定住,
兩段錄影(CPU / ranked)的欄位全數正確。剩下的問題**全部是時序與資源層面的**,
單張 fixture 測不到,只有 replay 和實跑會暴露。

---

## P0-1:數值 OCR 一場只有一次機會(最高價值)

**證據**:結算畫面上,`score_system` 標籤第一次過門檻的那個 tick,`result` 橫幅
(0.7 門檻)也同時過線並執行 `finalizeMatchResult` → `activeMatchId = null`。
之後所有 `!isModifyBP && activeMatchId !== null` 的 OCR 守衛全部失效。
重播實測:結算畫面實際停留 ≥2.5 秒(約 5 個 tick),但 OCR 只在第一個 tick 跑一次。
第一次重播正是這樣丟失 BP 的(`bp unreadable: not-an-integer("")` → 同 tick MATCH CLOSED)。

**失敗情境**:游標剛好停在數字上(`cursor-block`)、數字動畫未定格、或 tick 撞上
畫面轉場 — 任一情況該場數值永久遺失,只留下 `ranked-no-numbers` 診斷。

**修法**:把「寫入結果」與「關閉對戰」分離。偵測到 `result` 橫幅時先寫 result、
記下 `pendingFinalize`,但保留 `activeMatchId`,讓 OCR 在後續 tick 繼續重試;
直到 (a) 所需數值全部到手,或 (b) 結算畫面消失 / 寬限 5 秒到期,才真正 finalize。
既有的 `RESULT_MODE_GRACE_MS` 機制可以直接沿用同一模式。

**驗證**:replay harness 已能模擬 — 對 ranked 錄影加一個「第一個結算 tick 故意讓
OCR 失敗」的注入模式,斷言第二個 tick 補讀成功。`vision:replay-cpu` 迴歸不變。

**工作量**:小(狀態機改動約 30 行 + replay 鏡像同步)。風險:中 — 動到對戰
生命週期,必須同步更新 replay 鏡像與 `check-unattributable`。

## P0-2:OCR 路徑每次呼叫重載畫格 + 重建 Tesseract worker

**證據**:`recognizeNumber(imgPath, ...)` 收檔案路徑而非 frame — 每次呼叫
`loadFrame()` 重新解碼 PNG、重建灰階/積分圖(約 20MB 緩衝);MP 結算一個 tick
最多 4 次 OCR = 同一張圖解碼 5 次。且每次呼叫 `createWorker` → `terminate`,
Tesseract worker 冷啟動是數百 ms 級。

**影響**:不只是浪費 — tick 超時會直接造成辨識遺漏(先後攻 overlay 只有
約 0.9 秒 ≈ 2 個 tick),所以這是正確性問題,`tick-over-budget` 診斷已在收集證據。

**修法**:
1. `recognizeNumber` / `recognizeBPGain` 改收 `frame: VisionFrame`,由 `analyzeOnce`
   傳入當前 tick 的 frame(它本來就在 `finally` 統一 dispose)。
2. 模組層持有單一 lazy worker,`stop` 訊息時 terminate;OCR 失敗時重建一次。

**驗證**:`check-ocr-numbers.cjs` 不變(它自己管理 worker);`bench-tick.cjs`
量測 MP 結算 tick 前後耗時;replay 兩段錄影欄位不變。

**工作量**:小。風險:低 — 純資源管理,辨識邏輯不動。

## P1:累計值是遞增動畫

**證據**:累計 BP 實測 88638 → 88754 → 88762 逐格遞增(MP/CR 累計值同理)。
目前 `isModify*` 一讀到就 latch,取到的是第一格 = 賽前值。`database.ts` 註解
聲稱存的是賽前值 — 若這是有意設計,現狀「碰巧」正確,但依賴的是動畫起點,脆弱。

**修法**(與 P0-1 天然配合):累計欄位改為「連續兩個 tick 讀到相同值才接受」;
delta 欄位(+124 / +15)不是動畫,維持一次即收。若確認要存賽前值,改為
明確存「定格值 − delta」,不再依賴動畫時序。**需要你先裁決語意**。

**驗證**:replay 對 ranked 錄影斷言定格值;`check-ocr-numbers` 加定格幀案例。

**工作量**:小。風險:低,但語意決定在先。

## P2:未校準的搜尋範圍與版面

- `history` 是唯一的全畫面搜尋(每 4 tick 一次),無 fixture、位置未觀測。
- `custom` / `modesPlaza` 用 leftHalf / rightHalf / topRight 半畫面搜尋,無正樣本。
- 1280 視窗與 1920 視窗版面無素材;windowed fixture 只有一種(1276×754)。

**修法**:錄一段含歷史回放、自訂房、廣場賽的素材 → `calibrate` 量位置 → 收 ROI
→ 加進 `check-rois` / `check-scales`。**被素材阻塞,列入待錄清單即可**。

## P3:replay 鏡像與 analyzeOnce 的重複

狀態機在 `forkedImageAnalyzer.ts` 與 `replay-recording.cjs` 各有一份,已知會漂移。
根治 = 把狀態機抽成無 Electron/Prisma 依賴的純模組,兩邊共用。工程中等、
回報是防未來漂移 — 建議**等 P0/P1 落地後再評估**,不要與其同時進行。

## 明確不做

- FFT / SIMD:現行 8 核 100ms、單核 473ms,預算內(CALIBRATION.md §4)。
- 降低 tick 間隔:0.9 秒 overlay 在 500ms tick 下已由重播證實抓得到。

## 建議順序

1. **P0-2**(小、零風險、立即釋放 tick 預算)
2. **P0-1**(最高價值;P0-2 先做可縮短結算 tick,降低 P0-1 的時序壓力)
3. **P1**(騎在 P0-1 的新生命週期上,先要語意裁決)
4. P2 等素材、P3 等前三項穩定。

每步的驗收:`pnpm vision:verify` + `pnpm vision:replay-cpu` + ranked 錄影重播
全綠,且 `bench-tick` 顯示結算 tick 耗時下降。
