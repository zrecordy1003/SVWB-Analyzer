# 1280×720 視窗化階級對戰（BP 制・敗北）回歸素材

來源為使用者錄製的 1280×720 **視窗化**階級對戰（敗北）。`recording.mp4` 為完整流程，PNG 為關鍵畫面。

| 檔案                    | 時間點 | 內容                                                                    |
| ----------------------- | ------ | ----------------------------------------------------------------------- |
| `01-result-lose-bp.png` | ~1:41  | 最終結算：`result` = lose，`BP` 標籤在 **(1070, 321)**，TOTAL 為 `+8`。 |
| `02-game-set-mid.png`   | ~1:38  | 中途結算橫幅（`result_mid` = gameset）。                                |
| `03-battle.png`         | ~0:34  | 對戰中，用來確認 `score_system` 錨點視窗不會在戰鬥畫面誤判。            |

## 這份素材要防的是什麼

**結算畫面的獎勵清單行數不固定，下方的「階級／BP」整塊會跟著上下位移。**

- 勝利：對戰勝利 ＋ 對戰表現獎勵 ＋ 3 條子項 ＋ TOTAL＝ 6 行
- 敗北：對戰表現獎勵 ＋ 時間獎勵 ＋ TOTAL＝ 3 行

少 3 行 × 每行 33px＝下方整塊上移 **99px**。實測 `BP` 標籤在
`ranked-bp-1920-fullscreen/01-result-win-bp.png` 是 y=420，在這裡是 y=321。

原本 `scoreSystemCr` / `scoreSystemBp` 是照勝利版面各切一個小窗，於是這張圖：

1. `bp` 掉出 `scoreSystemBp`（y 390–480）之外；
2. 反而落進 `scoreSystemCr`（y 275–360）裡，但那裡只認 `cr` 這個名字，所以被丟掉；
3. `detectScoreSystem` 兩邊皆未命中 → 回傳 null → **整場對戰從未被判定為 ranked**，
   模式與 BP 都沒有寫入。

修正後改為單一高視窗 `ROI.scoreSystemAnchor` 找標籤，再用 `resultLayoutOffset()`
算出位移量，把所有數值視窗一起平移。注意標籤在數字 count-up 動畫期間**水平**也會飄
（實測 1053 → 1105），但獎勵清單本身不動，所以只有垂直位移會被採用。

順帶一提，就算模式判對，未平移的 BP 視窗在這張圖上切到的是下面那行 `BP：88794`
（累計總分），OCR 讀出 `"077"`——**不是空字串**，是會被當成本場得分寫進資料庫的錯誤數字。

## 關於 `recording.mp4`

錄影本身**不會進 git**（`.gitignore` 已排除 `tests/fixtures/captures/**/*.mp4`），
只留在本機。上面表格中的 PNG 才是 committed 的部分，`pnpm vision:verify` 底下所有
靜態畫面檢查都只靠 PNG，不需要錄影。

只有 `pnpm vision:replay-*` 這類「整段重播」的腳本需要錄影檔；在沒有它的環境下會直接
以 exit code 2 結束並說明原因。

## 驗證

```bash
pnpm vision:check-score-system   # 標籤辨識 + 位移量
pnpm vision:check-ocr-numbers    # 平移後讀到 +8；未平移則讀到別行
pnpm vision:check-unattributable # 這張圖不得再觸發 mode-unattributable
pnpm vision:replay-ranked-lose   # 整段錄影跑完應得 mode=ranked, bp=8, result=lose（需本機錄影）
```

此素材的基準是 1280×720 視窗化，且錄影只含 client area（無標題列），長寬比恰為 16:9，
因此不會走標題列偵測與 letterbox 裁切——**解析度本身從來不是問題**，MP 版面（Grand
Master 以上）沒有獎勵清單，因此完全不受此位移影響。
