# Windows 發行流程

## 發行前檢查

OpenCV 發行內容採白名單，只會納入 `opencv_world4110.dll`、FFmpeg 與 Media Foundation 支援 DLL。PDB、Debug DLL、`.lib`、header 與 OpenCV 工具都不會進入安裝程式。

在 Windows x64 機器上執行：

```powershell
git pull
git lfs pull
pnpm install
pnpm run capture:check
pnpm run runtime:check
pnpm run typecheck:node
pnpm run lint
pnpm run build:win
```

`build:win` 會依序編譯 Rust 截圖器、產生 Electron bundle，最後使用 electron-builder 建立 NSIS 安裝程式。

## 實機驗證清單

- [ ] 安裝程式可於乾淨的 Windows 10／11 x64 環境啟動。
- [ ] 遊戲關閉時不啟動擷取器。
- [ ] 遊戲視窗化、無邊框／全螢幕化可開始擷取。
- [ ] 遊戲最小化時擷取停止；恢復後可重新開始。
- [ ] 截圖器 stdout 有 `started` 與持續的 `frame_saved` 事件。
- [ ] 對戰開始只新增一筆 Match；BP、CR、模式與勝敗皆更新同一筆。
- [ ] 勝利與敗北、階級與 2Pick 至少各驗證一場。
- [ ] 既有使用者資料庫升級後保留牌組、標籤與歷史對局。
- [ ] 自動更新檢查、下載與重啟安裝流程正常。

## 版本與發佈

1. 更新 `package.json` 的 `version` 與 release notes。
2. 重新執行完整發行前檢查。
3. 以 GitHub Release 上傳 electron-builder 產物。
4. 確認 GitHub release 的 tag、版本號與安裝檔名稱一致。
5. 在另一台 Windows 機器從 GitHub Release 安裝，驗證自動更新與資料庫升級。

`publish:win` 會使用 `.env` 中的發佈憑證設定；此檔案不得提交。發佈授權與 token 應只存在於受信任的本機或 CI secret。
