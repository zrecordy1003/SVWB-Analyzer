# 架構說明

SVWB Analyzer 是一個 Windows Electron 桌面應用，將遊戲視窗畫面轉換成可查詢的對戰紀錄與統計。

## 執行流程

```text
shadowversewb.exe
  │  PID / HWND 驗證
  ▼
Electron main process ──啟動──> Rust capture helper
  │                                  │ Windows Graphics Capture
  │                                  ▼
  │                           svwb.png（原子替換）
  ▼
utilityProcess: forkedImageAnalyzer
  │ OpenCV 範本比對 + Tesseract 數字 OCR
  ▼
SQLite / Prisma ──IPC──> React + MUI main window / HUD
```

## 主要目錄

| 路徑                              | 職責                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| `src/main/`                       | Electron main process、遊戲偵測、擷取器生命週期、資料庫、IPC、更新程式。 |
| `src/main/forkedImageAnalyzer.ts` | 獨立 utility process：讀取最新畫面、場景／職業／模式／勝敗辨識及 OCR。   |
| `src/renderer/src/`               | React + MUI 介面、對局列表、統計與 HUD。                                 |
| `src/preload/`                    | 安全地暴露 renderer 所需 IPC API。                                       |
| `resources/templates/`            | OpenCV 範本；遊戲 UI 改版後優先更新此處。                                |
| `resources/migrations/`           | 使用者正式 SQLite 資料庫的 migration，為 runtime 真正使用的來源。        |
| `prisma/`                         | Prisma schema、開發資料庫與開發 migration。                              |
| `tools/capture/`                  | Rust 截圖器原始碼、Windows 編譯腳本與協議文件。                          |
| `tools/svwb-capture-tool.exe`     | Electron 打包時攜帶的 Windows 截圖器產物。                               |

## 視窗、擷取與分析

1. `svwbDetector.ts` 先查詢 `shadowversewb.exe`，再以 PID 對可執行檔路徑驗證，避免僅由視窗標題誤判。
2. `index.ts` 取得已驗證遊戲視窗的 HWND，僅在視窗存在且未最小化時啟動截圖。
3. `manageCaptureTool.ts` 將 HWND、輸出路徑與間隔傳給 Rust helper，並接收其 JSON Lines 健康事件。
4. 截圖器以 Windows Graphics Capture 產生 frame，寫入 `svwb.png.tmp.png` 後以原子 move 替換 `svwb.png`。
5. `forkedImageAnalyzer.ts` 每次只讀取完整的最新 PNG，先正規化至 1280×720，再使用固定 ROI 與範本辨識。

截圖器與分析器維持檔案協議是刻意的第一階段設計：便於獨立重啟與偵錯。若 profile 顯示 PNG 編碼或磁碟 I/O 是瓶頸，再升級為 named pipe 或 shared memory 傳遞最新 BGRA frame。

## 對局資料生命週期

`forkedImageAnalyzer.ts` 在確認對戰開始時建立 `Match`，並保存 `activeMatchId`。後續 BP、CR、模式與勝敗更新皆使用這個 ID，而不是依賴「資料庫最新一筆」，以避免快速連戰時寫錯場次。

當模式沒有被辨識時，場次結束會標記為 `unranked`。每一筆對局包含職業、先後攻、模式、BP／CR、時間、牌組、標籤與備註等資料。

## 範本更新原則

新卡包不會直接影響卡牌資料，因為本程式不辨識個別卡片。只有 UI、職業／模式圖示、結果畫面或數字區域改變時，才需更新範本或 ROI。

更新前後都應保留原始截圖樣本：對戰中、勝利、敗北、階級結算、2Pick、CPU、廣場與自訂對戰。這些樣本是後續回歸測試的基礎。
