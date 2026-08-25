# 素材與商標政策

本文件界定 SVWB Analyzer repository 中原創程式碼、第三方依賴及與
Shadowverse: Worlds Beyond 相關素材的權利範圍。它不是法律意見；上游權利人的
條款與所在地法律優先適用。

## 1. 授權範圍

根目錄的 [LICENSE](LICENSE)（Apache License 2.0）只授權本專案貢獻者擁有著作權的原創程式碼與文件。它**不**授權下列內容：

- Cygames, Inc. 的商標、名稱、標誌、遊戲畫面、卡片、角色、文字、音訊或其他智慧財產。
- 從遊戲畫面裁切、擷取、重建或衍生的辨識範本，例如 `resources/templates/` 內的圖像。
- OpenCV、Tesseract 與 npm/Rust 套件等第三方元件；其權利依各自的授權條款。
- 使用者建立的對局紀錄、截圖或個人資料。

`NOTICE` 保留必要的權利聲明。本專案為非官方社群工具，並非 Cygames 的產品，亦未獲其合作、推薦、贊助或個別核准。

## 2. Cygames 素材

所有涉及 Shadowverse: Worlds Beyond 的素材，均應依 Cygames 當時有效的
[Content Guidelines](https://shadowverse-wb.com/en/guideline/) 使用。尤其是：

- 不得提交或發布未由 Cygames 公開的卡片、遊戲文字、原型、截圖或其他資訊。
- 不得暗示本專案受 Cygames 建立、贊助或認可。
- 不得加入鼓勵作弊、破解、輸入自動化、記憶體讀取、封包攔截或規避遊戲機制的內容。
- 不得把 Cygames 素材用於未獲明確許可的付費功能、商品或其他商業用途。

卡包更新時，請等官方公開後才提交新的辨識範本或測試圖片。

## 3. 提交素材的規則

提交 PR 前請確認：

1. 你有權提交該內容，且內容沒有包含帳號、玩家名稱、聊天室、付款資訊或其他可識別個資。
2. 截圖只保留修正辨識所需的最小區域；優先使用裁切、匿名化後的 PNG。
3. 每一份遊戲衍生圖片都要說明用途、來源遊戲版本與對應的辨識測試。
4. 不要提交完整對局影片、完整 UI dump、未公開內容或與修正無關的大型二進位檔。
5. 大型且獲准追蹤的二進位素材必須使用 Git LFS。

維護者可以因權利、隱私、容量或可維護性理由拒絕或移除素材。

## 4. 發行版

發行者應確認 About／Legal 頁、README 與發行說明皆保留以下要點：

- `© Cygames, Inc.` 與 Shadowverse: Worlds Beyond 商標歸屬。
- 本應用程式並非 Cygames 的官方或核准產品。
- 對 Cygames 素材的使用受官方 Content Guidelines 約束。

官方規範可能更新；每次發行前都應重新確認。
