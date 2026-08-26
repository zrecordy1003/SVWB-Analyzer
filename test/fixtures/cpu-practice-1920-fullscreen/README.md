# 1920 全螢幕練習模式回歸素材

來源為使用者錄製的 CPU 對戰失敗影片。`recording.mp4` 保存完整操作流程，PNG 為分析器測試與人工檢查使用的關鍵畫面。

| 檔案 | 時間點 | 預期用途 |
| --- | --- | --- |
| `01-home.png` | 0s | 首頁不應誤判為對戰或 CPU。 |
| `02-cpu-deck-label.png` | 6s | 開戰前偵測到 CPU 牌組；必須暫存為下一場對戰的模式。 |
| `03-matchmaking.png` | 10s | 排隊／進場轉換期間不應清除已暫存的 CPU 模式。 |
| `04-battle.png` | 30s | 對戰中應保有先前辨識到的 CPU 模式。 |
| `05-game-set.png` | 41s | 中途結算；可先記錄勝敗，但不可過早回填自由對戰。 |
| `06-result-cpu-label.png` | 42s | 最終 RESULT 畫面中的 CPU 牌組標籤，作為模式辨識補強。 |

此素材的基準解析度是 1920×1080 全螢幕。新增或調整偵測規則時，至少應驗證 CPU 模式在 `02-cpu-deck-label.png` 與 `06-result-cpu-label.png` 都能被正確辨識，且 `01-home.png` 不會產生誤判。
