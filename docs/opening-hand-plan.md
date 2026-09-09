# 計畫：起手手牌記錄（換前 / 換後）

Last updated: 2026-09-07

本文件是「記錄一場對局的起手四張牌，換牌前與換牌後各一組」這件事的唯一計畫來源。相關既有
文件：`docs/deck-import-plan.md`（卡表、卡池、卡圖快取的來源）、
`docs/project-status-roadmap.md`、`docs/engine-refactor-plan.md`（引擎為何是這個形狀）、
`ASSETS_POLICY.md`（卡圖不得散布）。

> 狀態：**規劃中，尚未實作任何一行。** 階段 0（量測）是先決條件，不是暖身——它的四個問題
> 會改變後面所有階段的規模，其中一個甚至可能讓階段 4 整個不必做。

---

## 動機

現在一場對局記錄的是「誰對誰、先後手、勝負、模式、分數」。牌組匯入之後，Analyzer 知道那 40
張牌是什麼（`DeckCard`），卻不知道**這一場實際抽到了什麼**。起手手牌是牌組調整時最常被問的
問題（這張留不留、換幾張、後手起手三費以上幾張），而它剛好是整場對局裡唯一「位置固定、時間
充裕、可以慢慢看」的一個畫面。

本計畫**不實作卡片層級的勝率分析**。`docs/deck-import-plan.md` 已經把那劃為另一個計畫，這裡
維持同一條界線：本計畫只負責讓資料存在且可信。

---

## 現況查證（2026-09-07，逐項對照程式碼）

| 事實                                                                    | 依據                                                    | 影響                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| tick 是 500ms，超支會發 `SlowTick`                                      | `calibration.rs:556`、`live.rs:207`                     | 新工作必須關在 mulligan probe 後面，不能每 tick 都付錢    |
| 每格正規化到固定 1280x720 畫布，元件有量測過的窗口                      | `calibration.rs:11`                                     | 卡片位置可以是常數，不需要搜尋                            |
| `TemplateStore` 是灰階 NCC 掃描小圖示，一個 set 十來張                  | `templates.rs:141` `best_in`                            | **不能**拿來比對 199 張全彩卡圖，會吃光整個 tick          |
| 先後手覆蓋層只在畫面上約 1 秒，classes / emblems 同屬 versus 畫面       | `calibration.rs:44-47`                                  | 換牌畫面就緊接在 `MatchStarted` 之後                      |
| 讀不出來是合法結果，不是錯誤                                            | `reading.rs:64` `read_play_order`                       | 認不出的 slot 要能存成「不明」，不能猜                    |
| 多幀共識已經有現成機制                                                  | `accumulate.rs`                                         | 發牌動畫的前幾幀不必自己另寫防抖                          |
| host 端有 tesseract seam，引擎送裁圖、host 回字串                       | `protocol.rs:238` `ReadNumber`                          | 讀費用/攻防不必在引擎裡塞 OCR                             |
| tesseract worker 只載 `eng`，白名單只有 `+-0123456789`                  | `engineNumbers.ts:43-49`                                | **讀卡名需要另一組語言資料與另一個 seam**                 |
| 開局時 `my_deckId` 已由「該職業的預設牌組」預填                         | `store.rs:196`                                          | 候選集在換牌當下就拿得到——但它是猜測，可能是錯的牌組     |
| 2Pick 之後會清掉 `my_deckId`（`clear_my_deck`）                         | `store.rs:242`                                          | 2Pick 沒有候選集，必須有退化路徑                          |
| migration 由引擎讀目錄依序套用，檔名 `NNN_name.sql`                     | `store.rs:126`                                          | **新增 SQL 檔即可，不必改 Rust**                          |
| 現有最新 migration 是 `013_add_oppo_name_crop.sql`（工作區）                     | `resources/migrations/`                                 | `013` 已被對手名牌佔用、`014` 由帳號同步保留，本計畫用 `015_`                                           |
| `Card` 每張卡只有一個 `imageHash` / `bannerHash`                        | `009_add_deck_import.sql:88-89`                         | 見下節：官方資料**無法列舉插畫版本**                      |
| 卡池與卡圖是「使用者自己的機器抓到自己硬碟」，不進 repo 與 installer    | `cardImages.ts:1-19`、`ASSETS_POLICY.md` §1             | 任何新的圖像樣本也必須留在本機                            |
| `replay.rs` 能拿檔案當 frame source，測試不需要開遊戲                   | `replay.rs`                                             | fixture 驅動的測試是可行的                                |
| 上傳的 telemetry 只有計數 bucket                                        | `src/main/telemetry/rollup.ts`                          | 手牌資料**預設不進上傳路徑**                              |

---

## 決定性的限制：一張卡有很多種插畫

畫面上的一張卡與 portal 給的那張圖，可能不是同一張圖。三種版本破壞的東西不同：

| 版本            | 畫面上差什麼                             | 破壞什麼                              |
| --------------- | ---------------------------------------- | ------------------------------------- |
| 閃卡 / premium  | 同一張插畫，加上動態光澤、粒子、框飾特效 | 破壞**單幀**像素比對；幾何沒變        |
| 替代插畫        | 整張圖不一樣                             | 插畫比對**必然失敗**，無法補救        |
| 語言 / 稀有度框 | 名稱文字、框飾                           | 只影響拿卡框當特徵的做法              |

而 `card_details.<id>.common` 只有一個 `card_image_hash` 與一個 `card_banner_image_hash`
（`tests/fixtures/deck-import/witch-pool.json`），**沒有任何列舉版本的欄位**。所以「把所有版本
的卡圖抓下來建索引」這條路沒有資料來源——這不是準確度問題，是資料上不存在。

**結論：插畫不能當身分的主判準。** 身分必須來自版本不變量。

---

## 辨識架構

四層，成本由低到高，前面的層做掉大部分工作：

1. **候選集限縮**：`my_deckId` 的 `DeckCard`，unique 卡約 25~30 張。退化順序是
   「預設牌組 → 該職業卡池 + 中立 → 放棄並記為不明」。2Pick 直接落到第二層。
   注意這一層是**猜測**：使用者可能用了非預設牌組。因此下面每一層都必須能說「這四張裡有一張
   不在候選集裡」，而不是硬塞一個最接近的。
2. **主判準：卡面數字與形制**（費用、攻擊、生命、類型）。跨版本不變，費用又本來就能用現成的
   `ReadNumber` seam 讀。
3. **Tiebreak 一：卡名 OCR**。文字跨版本不變。代價是要帶 `chi_tra`（或使用者語系）的
   traineddata，數 MB，而且現有 worker 的白名單是純數字，需要第二個 seam（`ReadText`）。
   只在第 2 層有碰撞時才跑，一場最多 4 次，不進 tick 熱路徑。
4. **Tiebreak 二：插畫比對**，**命中加分、不命中不否決**。這條規則是重點：替代插畫不該讓一張
   已經靠數字與文字確定的卡變成不明。

### 插畫比對怎麼做（若階段 0 判定值得做）

固定 ROI + 指紋比對，不是搜尋：裁出插畫中央區（避開會噴粒子的邊框、避開費用數字與名稱條），
縮到小尺寸灰階、去均值正規化成向量，在候選集裡取最近鄰。

- 特徵要對亮度不敏感（去均值 NCC 或梯度方向），不要用原始像素——閃卡的光澤會整體壓低分數。
- 門檻用「第一名與第二名的差距」，不是絕對分數，理由同上。
- 多幀取最佳並交給 `accumulate.rs` 共識，不相信任一幀。

### 參考指紋在哪裡算

**不要在 host 用 sharp/jimp 算。** 那條 pipeline 與 frame 的灰階／縮放不一致，比對會系統性
偏掉。新增一個 stdin 指令 `indexCards { cards: [{ cardId, path }] }`，由引擎用它自己的
`to_gray_opencv` / `downscale` 算，結果寫進 `CardArtSample`，開機不重算，換演算法時用
`algoVersion` 整批失效。

### 替代插畫的長尾：讓它自己學

一旦某張卡靠第 2、3 層被確定，就把當下的裁圖指紋存成該 `cardId` 的 `source='observed'` 樣本。
下一次同一個替代插畫出現就直接命中。這是唯一能覆蓋「官方沒告訴你的版本」的辦法，而且它是
本機觀測資料、不散布素材，與卡圖快取同一套立場。需要每張卡的樣本數上限。

---

## 資料模型

新增 `resources/migrations/015_add_opening_hand.sql`。

```sql
-- ---------- MatchOpeningCard ----------
-- 一列一張卡，不是八個欄位：之後要問的是「起手有 X 的勝率」，那是 join，不是欄位掃描。
CREATE TABLE IF NOT EXISTS MatchOpeningCard (
  matchId    INTEGER NOT NULL,
  stage      TEXT    NOT NULL,  -- 'pre' | 'post'
  slot       INTEGER NOT NULL,  -- 0..3
  cardId     INTEGER,           -- NULL = 認不出來，這是合法狀態
  confidence REAL,
  swapped    INTEGER,           -- 只有 pre 列有意義：這張被選中換掉了嗎
  decidedBy  TEXT,              -- 'numeric' | 'name' | 'art-portal' | 'art-observed'

  PRIMARY KEY (matchId, stage, slot),
  FOREIGN KEY(matchId) REFERENCES Match(id) ON DELETE CASCADE
);

-- ---------- CardArtSample ----------
CREATE TABLE IF NOT EXISTS CardArtSample (
  cardId      INTEGER NOT NULL,
  source      TEXT    NOT NULL,  -- 'portal' | 'observed'
  algoVersion INTEGER NOT NULL,
  vector      BLOB    NOT NULL,
  seenAt      DATETIME NOT NULL,

  PRIMARY KEY (cardId, source, algoVersion, seenAt)
);

CREATE INDEX IF NOT EXISTS idx_openingcard_cardId ON MatchOpeningCard(cardId);
```

理由與慣例：

- **`cardId` 不設 FK 到 `Card`**，與 `DeckCard`、`CardPool` 一致：`Card` 是別人資料的快取，會被
  清掉或換語言重抓。這裡該退化成「卡號 10573310，詳情不明」，不是壞掉。
- **`matchId` 用 CASCADE，且只掛在 `Match` 上。** 不碰 Deck 家族——`ON DELETE SET NULL` 會觸發
  既有 trigger（見牌組版本化的那個坑）。
- **`decidedBy` 不是裝飾。** 上線初期一定會問「這批資料能不能拿來算勝率」，而只有這個欄位能
  回答。同理 `confidence` 是調門檻用的。
- `Match` 上另加一個 `openingRecognized`（或以「四列齊全且 cardId 皆非 NULL」推導），讓統計能
  排除只認出兩張的對局。兩者選一，別兩套並存。

---

## 狀態機的位置

換牌畫面在先後手覆蓋層之後，也就是 `MatchStarted` 已發出、`Phase::InBattle` 剛開始的那幾秒。
照 `phase.rs` 的紀律，**這是 InBattle 底下的一段等待，不是新的頂層 phase**（那個模組開頭就在
講「pre-battle 模式偵測不是一個 phase，只是帶 TTL 的資料」）。

- 新增一個 mulligan 面板的 probe（面板 chrome 或確定鈕），加進 `PROBES`。只有它夠強時才跑卡片
  辨識，其餘 tick 完全不付錢。
- 用 `accumulate.rs` 穩定四個 slot。
- 面板消失 = 換前定稿；接著依階段 0 的結果讀換後。
- 結果透過 `MatchUpdated` 的 patch 送出，與 mode / bp 走同一條路，不另開事件種類。

---

## 階段

### 階段 0：量測（先決條件）

錄一段 1280x720 的換牌過程，逐格回答：

1. 四張卡的中心座標與尺寸是否 pixel-stable（正規化到 1280x720 之後）。
2. 被選中要換的卡有沒有穩定的視覺標記（勾勾／變暗／外框）。
3. **按下確定之後，新的四張有沒有停在同一個面板上。**
4. 順帶量：替代插畫與閃卡在真實對局裡有多常見。

第 3 點決定整個計畫的規模。若換後不在同一面板，就只能從第一回合的手牌區讀——斜置、重疊、會
動的扇形排列，難度差一個量級。退路（換後 = 換前 − 換掉的 + 未知抽牌）會產生「已知不完整」的
資料，比沒有更糟，**不建議當主線**。

第 4 點決定要不要做插畫比對：若大多數人用預設插畫，第 4 層與自我學習可以延後；若閃卡滿場飛，
第 2、3 層就是主線而插畫比對可能根本不值得做。

產出：ROI 常數、一組 replay fixture、以及「真實 40 張牌組裡 `(cost, atk, life, type)` 的碰撞
率」這個數字。**不要拿 `witch-pool.json` 算這個**——那份 fixture 是被裁過的低費子集（只有兩種
費用），碰撞率不可信。已知最壞情況是法術：`atk`/`life` 都是 0，同費法術只靠數字分不開，那裡
一定得靠文字。

### 階段 1：偵測換牌畫面 + 哪幾張被換掉

不辨識卡片。這階段本身就有價值（換牌率、換幾張與勝率的關係），而且會順便累積真實裁圖，當作
階段 2 的樣本來源與 fixture。

### 階段 2：卡片辨識

第 1~3 層（候選集、數字、卡名 OCR），加上 `ReadText` seam 與語言資料。第 4 層與
`indexCards` / `CardArtSample` 視階段 0 第 4 點的結論決定是否納入本階段。

### 階段 3：落庫與 UI

`015_` migration、`MatchUpdated` patch 欄位、比賽詳情顯示起手手牌。

### 階段 4：卡片層級統計

另案。本計畫到階段 3 為止。

---

## 測試

- **純函式**：slot 讀取與候選集比對照 `reading.rs` 的寫法寫單元測試，「分數不夠就是 `None`」
  要有自己的案例。
- **fixture 驅動**：階段 0 的錄影切成 frame 檔，走 `replay.rs`。至少要有：正常四張、閃卡、
  替代插畫、換 0 張、換 4 張、面板淡入的第一幀。
- **migration**：照 `store.rs` 既有 migration 測試的作法驗證 `015_` 可套用且冪等。
- **成本**：在 fixture 上量單 tick 成本並記錄在此文件，合併前確認沒有 `SlowTick`。

---

## 兩件別忘的事

- **telemetry**：現在上傳的只有計數 bucket（`rollup.ts`）。起手手牌明顯更細，**預設不要進上傳
  路徑**；真要進 meta-stats，得先改 `docs/meta-stats-plan.md` 並重新檢視隱私敘述。
- **tick 預算**：`timing::TICK` 是 500ms，`live.rs` 已會在超支時發診斷。新工作必須關在 mulligan
  probe 後面。
