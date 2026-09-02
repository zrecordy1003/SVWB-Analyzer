# 計畫：牌組版本化與卡表維度統計

Last updated: 2026-09-02（評估後補上：家族範圍的刪除與改名、`isDefault` 封存規則、
以 `id` 排序、同指紋 no-op、凍結判斷的 transaction 邊界）

本文件是「讓統計認得牌組的卡表，而不只是牌組的名字」這件事的唯一計畫來源，並且是
`docs/deck-import-plan.md` 判斷題 **J-2（一個 Deck 對應幾份卡表？）** 的結論。
相關文件：`docs/deck-import-plan.md`（匯入與編輯器，四階段已完成）、
`docs/meta-stats-plan.md`。

> 狀態：**三個階段全部實作完成**（2026-09-02）。設計過程中實測過的事情記在文末附錄，
> 其中幾條推翻了先前的設計方向。
>
> **階段 1**：`resources/migrations/011_add_deck_family.sql`、`ipc/decks.ts`（凍結／fork／
> 家族刪除與封存、`decks:stats` 的 `groupBy`、`decks:deleteImpact`、`saveLocal` 的
> `forceInPlace`）。**階段 2**：`ipc/deckScope.ts`（對局篩選的家族展開述詞，
> `QueryPayload.myDeckScope`）、`decks:deleteVersion` / `decks:versionImpact`、
> `components/DeckCards/DeckVersionsPanel.tsx`、`DeckVersionDiffDialog.tsx`、`deckVersions.ts`
> （純函式）、DeckPerformance 的家族折疊與「顯示已封存」、Analyzer 的整副牌／單一版本切換、
> DeckBuilder 的「修正，不建立新版本」。**階段 3**：`ipc/cardStats.ts`（`cards:stats`）、
> `shared/cardStats.ts`、`components/DeckCards/CardStatsPanel.tsx`、
> `Analyzer/component/AnalyzerCardStats.tsx`。
>
> **2026-09-02 UI 重構**（依 `docs/card-stats-research.md` 的調研結論）：家族展開區只剩
> **版本時間線**（`DeckVersionsPanel.tsx`：實際打過期間、內嵌換卡 chip、同尺度勝率條與
> 相對上一版差值、動作收進 `⋯` 選單；`decks:stats` 每列多回 `firstPlayedAt` / `lastPlayedAt`）。
> 卡片統計移出牌組戰績與分析器，成為獨立側欄頁面「卡片」（`components/Cards/`：
> `CardsPage.tsx`、`CardsTable.tsx`、`CardDrilldownDrawer.tsx`、`cardsFilterState.ts`），
> 定位是「以卡片為軸的檢索與下鑽」——`cards:stats` 每張卡多回 `decks[]` 分解；
> 費用曲線與 Analyzer 的 `'cards'` 圖表模式已移除。
>
> **2026-09-02 降低心智負擔的第二輪精簡**：UI 文案只用「牌組」「版本」「刪除」三個詞
> （封存／捨棄／家族／凍結不再出現在使用者可見字串，後果只在確認框用白話說明）；分析器與
> 卡片頁移除「整副牌／單一版本」切換，牌組選單改成兩層（勾牌組 = 全部版本，展開才能勾單一版本，
> `Common/filters/deckSelection.ts` 在渲染層解析成具體 deck id 後一律送 `myDeckScope: 'deck'`）；
> DeckBuilder 存檔旁不再有版本相關選項，「修正卡表…」移到版本列的 `⋯` 選單；卡片頁只剩一個
> 開關「顯示樣本不足的卡」，勝率與相對差值兩欄永遠並列，涵蓋率與免責文字收進 ⓘ。
>
> 測試：`tests/main/deckVersioning.test.ts`（22）、`deckDeleteVersion.test.ts`（7）、
> `deckScopeFilter.test.ts`（8）、`cardStats.test.ts`（13）、`tests/renderer/deckVersions.test.ts`
> （12），以及驅動真實 app 的 `tests/e2e/deckVersioning.spec.ts`（8 個情境，含「fork 前後畫面
> 一模一樣」這條相容性承諾）。

---

## 一、要解決什麼

**卡片目前完全沒有進入統計。** 統計只認 `my_deckId` 這個標籤與職業：

- `decks:stats`（`ipc/decks.ts:455`）是 `GROUP BY my_deckId`，沒有任何 card join。
- 對局篩選（`ipc/matches.ts:137`）只有 `my_deckId in (...)`、職業、模式、標籤、日期。
- `DeckCard` 全專案只出現在 `db/client.ts`（型別）、`ipc/decks.ts`（讀寫牌表與發代碼）、
  `shared/deckImport.ts`（指紋）。統計路徑一次都沒碰。

所以「這 40 張牌的勝率」問不出來，只能問「這個牌組名稱的勝率」。

**而牌表是就地破壞性覆寫**（`ipc/decks.ts:260`）：

```
await tx.deleteFrom('DeckCard').where('deckId', '=', params.replaceDeckId).execute()
```

`replaceDeckId` 有兩個來源：使用者在 DeckBuilder 編輯存檔、以及同指紋重新匯入
（`decks.ts:707` / `decks.ts:759`）。任一次發生後：

- 舊的戰績被歸給**新的**卡表，勝率跨版本混算；
- 舊卡表無處可查（`rawJson` 也一併被覆寫，只留最新一版）；
- 事後無法補救——`Match` 沒有留下當時的任何線索，migration 也推不回來。

也就是說「改兩張卡之後勝率變化」這種分析，每編輯一次就永久少一份資料。這是現在進行中的
損失，不是未來的風險。

---

## 二、結論：Deck 列不可變

J-2 選 **(b) 保留版本歷史**，但實作方式不是「在 Deck 上加版本欄位」，而是：

> **一副牌組的卡表一旦有對局引用它，就永不改動。**
> 使用者編輯它 → 系統自動 fork 出一列新的 Deck（新版本），舊列連同它的戰績原封不動。
> 同一副牌的歷代版本用 `familyId` 串起來。

這個模型的關鍵性質是：**`Match.my_deckId` 從「一個標籤」變成「一份確定的 40 張牌」**。

於是既有的 `decks:stats` 一行都不用改，就已經在回答「這份卡表的勝率」。不需要在 `Match`
加欄位、不需要 trigger、不需要卡表快照表、不需要指紋歷史表。第四節記錄了這些被否決的
方案，以及為什麼它們比這個模型糟。

`deck-import-plan.md` 的 J-2 原本擔心 (b) 會讓 `Match.my_deckId` 的語意變模糊（指向哪個
版本？）。在這個模型裡它不模糊，反而更精確：它永遠指一份確定的卡表。模糊性被移到「UI 要
怎麼把版本分組顯示」，那是顯示問題，不是資料完整性問題。位置對了。

---

## 三、資料模型

`Match` 完全不動。只有 `Deck` 加兩個 nullable 欄位——沿用 008/009 的慣例，NULL 有明確意義。

```sql
-- resources/migrations/011_add_deck_family.sql

-- 同一副牌歷代版本的共同 id。新建牌組時等於自己的 id，fork 時繼承來源的值。
-- 統計要「這副牌一路以來」就 GROUP BY 這個，要「這一份卡表」就 GROUP BY id。
ALTER TABLE "Deck" ADD COLUMN "familyId" INTEGER;

-- 封存時間。NULL = 未封存。
-- 有對局引用的牌組不再硬刪，因為在這個模型裡 Deck 那一列就是卡表本身；
-- 硬刪一列有戰績的牌組，等於刪掉那幾十場對局的內容。見第 3.3 節。
ALTER TABLE "Deck" ADD COLUMN "archivedAt" DATETIME;

-- 既有牌組各自成家（真的回填：複製既有資料，不含任何猜測）。
UPDATE "Deck" SET "familyId" = "id" WHERE "familyId" IS NULL;

CREATE INDEX IF NOT EXISTS idx_deck_familyId ON Deck(familyId);
```

`familyId` 在 migration 之後不該再出現 NULL；寫入端負責維持。因為 `id` 是
`AUTOINCREMENT`，插入前拿不到自己的 id，所以新建牌組是「插入後補一句
`UPDATE Deck SET familyId = id WHERE id = ? AND familyId IS NULL`」，在同一個 transaction 內。

`archivedAt` 不建索引：牌組數量是幾十到幾百的量級，`archivedAt IS NULL` 全表掃就夠了。

### 3.1 規則一：凍結的界線是「打過」，不是「建好」

剛建好、還沒打過的牌組，改它弄壞不了任何歷史——沒有對局指著它。而調卡最頻繁的時刻正是
這時候：匯入完發現漏一張、換一張試試看。這時候逼使用者新建只會製造一堆從沒打過的牌組。

**界線：一旦有 `Match` 引用它（`my_deckId` 或 `oppo_deckId` 任一），卡表凍結。**
判斷成本是一句 `SELECT 1 FROM Match WHERE my_deckId = ? OR oppo_deckId = ? LIMIT 1`。

**這句判斷必須放在寫入的同一個 transaction 裡**，不能先查再開 transaction。因為 `Match`
有第二個寫入端在另一個 process（Rust engine，`store.rs:179`），而它寫 `Match` 的時機正是
對局結束的當下——「一邊打牌一邊調牌」是最常見的使用情境，不是邊角案例。查與寫分開的話，
中間 engine 剛好插進一場（靠 `isDefault` 指到這副牌），舊卡表就被無聲覆寫。放進同一個
transaction 之後，WAL 下的衝突會以 busy/snapshot 錯誤炸出來而不是靜默錯——那是可接受的，
但寫入端要處理重試。

名稱、分類、`isDefault`、`archivedAt` 不是卡表事實，**永遠可改**——否則改個錯字都要生一個
版本。`decks:setDefaultForClass` 因此完全不受影響。

**但名稱與分類是「這副牌」的屬性，不是「某個版本」的屬性**（2026-09-02 使用者決定）：
`name` / `categoryId` 雖然逐列存，`decks:update` 改的時候要 `WHERE familyId = ?` 一次改
整個家族。否則改名只動當前版本，版本歷史裡會出現不同名字、甚至被分進不同分類的同一副牌，
家族在清單上的歸屬也會看分類而裂開。fork 時繼承名稱與分類（見 3.2）維持這個不變量的另一半。

### 3.2 規則二：編輯打過的牌組 = 自動 fork，不是拒絕

「請使用者自己新建或複製一副」有兩個問題，所以不採用：

1. **它把系統知道怎麼做的事變成手工勞動**：複製 → 改名 → 換那兩張 → 記得把 `isDefault`
   移過去。漏掉最後一步的後果是 engine 繼續替新對局填舊版本（`store.rs:167` 是靠
   `isDefault` 抓的），而且是安靜的錯誤資料。
2. **連結會斷**：手工複製出來的牌組跟原本那副在資料上毫無關係，於是「這副牌這個月整體打得
   怎樣」再也算不出來，只剩下十二副名字很像的牌組各自三十場。使用者**今天**有一副牌一路
   累積的數字，那樣做會把它拿走——是退步。

所以 fork 由系統做，使用者體感就是「我改了牌」：

- 新建一列 `Deck`：新卡表、`familyId` 繼承來源、`name` / `categoryId` / `class` 繼承；
- `isDefault` 若在來源身上，移到新版本（沿用 `decks.ts:241` 既有的「清掉同職業其他預設」）；
- 來源那一列完全不動。

**兩個 fork 的邊界條件**：

- **卡表沒變就不 fork。** 存檔前先比指紋：與來源版本相同 → no-op（只更新名稱等可變欄位）。
  否則「打開 DeckBuilder 看一眼按存檔」「同指紋重新匯入選更新」都會生出一模一樣的假版本，
  版本歷史被稀釋，正好毀掉這個功能的價值。匯入判重（`decks.ts:707` 的 fingerprint 查詢）
  在新模型下也會撞到封存的舊版本，回給 UI 的語意要改成指向**家族**，不是那一列。
- **fork 出的新列不繼承 `rawJson` / `sourceRef` / `sourceKind` / `importedAt`。** 那些
  provenance 描述的是舊卡表；新版本是本機編輯的產物，`sourceKind = 'local'`，其餘為 NULL。
  繼承會讓「用 rawJson 重看原始匯入內容」讀到一份跟卡表對不上的資料。

**逃生門**：手動輸入卡表打錯字是真的會發生（少打一張）。這時 fork 出一個「版本」是假的
歷史。所以 `decks:saveLocal` 要有一個明確的「修正這副牌，不建立新版本」模式，走今天的
就地覆寫，UI 要警告它會改寫既有戰績的解讀。**預設 fork，例外要使用者明講。**

### 3.3 規則三：刪除分兩種

今天 `decks:delete`（`decks.ts:640`）是裸 `DELETE`，後果全靠外鍵：

| 對象 | 外鍵行為 | 結果 |
|---|---|---|
| `Match.my_deckId` / `oppo_deckId` | `ON DELETE SET NULL`（migration 001） | 對局倖存，牌組連結斷掉 |
| `DeckCard` | `ON DELETE CASCADE`（migration 009） | **卡表直接消失** |
| `Deck.id` | `AUTOINCREMENT` | id 不回收，不會錯配到後來的牌組 |

在新模型下這會變糟，因為卡表只存在 `DeckCard`，所以刪除的性質從「失去一個標籤」升級成
「失去那副牌到底是什麼」。而 fork 會讓舊版本累積，使用者最自然的動作就是「刪掉那些舊的」
——正好刪掉整個設計存在的目的。

**改成：`decks:delete` 作用在整個家族**（2026-09-02 使用者決定），逐列套用：

- **沒有任何對局引用**（兩側都查）→ **真刪**。沒有東西要保護，建錯的、試一下沒用的牌組
  應該乾乾淨淨消失。
- **有對局引用** → **封存**，寫 `archivedAt`，列保留，統計照常。

範圍是家族而不是單列，因為清單上顯示的是「每個家族的當前版本」，使用者按刪除的意思是
「刪掉這副牌」。若只處理當前版本那一列，家族的「當前版本」定義會往前退一格，**上一個版本
立刻重新出現在清單上**——使用者刪了一副牌，冒出一副舊版，體感就是刪除失敗。「捨棄單一
版本」是另一個操作，屬於階段 2 的版本 UI，不掛在清單的刪除手勢上。

**封存時若該列持有 `isDefault`，必須一併清掉。** engine 用
`SELECT id FROM Deck WHERE class = ? AND isDefault = 1`（`store.rs:167`）替新對局填牌組，
封存不清的話，新對局會繼續安靜地掛到一副「已刪除」的牌組上。清掉之後該職業暫時沒有預設，
這是正確狀態，由使用者重新指定。

`decks:delete` 要回傳它做了哪些（真刪幾列、封存幾列），讓 UI 講對話。

**封存牌組的可見性規則**（很重要，弄錯的話封存就等於刪除）：

| 位置 | 行為 |
|---|---|
| 挑牌組的選單（`DeckPicker`、`InlineDeckSelect`、`NewDeckDrawer`） | 過濾掉 |
| `decks:stats` 及其他統計查詢 | **不過濾**，照算 |
| `DeckPerformance`、Analyzer 的牌組篩選 | 預設隱藏，給「顯示已封存」開關；列上灰階加標記 |

刪除確認框的文字（`DeckManagerControl.tsx:978`，現在寫「這不會移除既有對局紀錄，但此操作
無法復原」）要改掉，並顯示「這副牌有 N 場對局」，讓使用者知道會走封存那條路。

### 3.4 版本編號與「當前版本」都用推導，不存欄位

- **版本序號**：`ROW_NUMBER() OVER (PARTITION BY familyId ORDER BY id)`。兩邊的
  SQLite 版本都支援 window function。存下來的序號會在某個版本被刪掉之後變成錯的。
- **家族的當前版本**：家族內 **`id` 最大**且未封存的那一列。使用者從舊版本 fork 出來的
  新列 `id` 也是最新的，所以這個定義自然成立。

**排序鍵刻意用 `id` 不用 `createdAt`**，兩個理由：

1. `createdAt` 的儲存型別不保證一致：TS 寫入端塞的是毫秒整數（`upsertDeckWithCards` 的
   `params.now`），但 schema 預設是 `CURRENT_TIMESTAMP`（文字）。SQLite 排序時**整數
   永遠排在文字前面**，歷史資料庫裡只要有任何一列走過預設值，整個排序就錯，而且錯得安靜。
2. 同毫秒內 fork 兩次會平手，順序不定。

`id` 是 `AUTOINCREMENT`：單調、無平手、不回收（附錄實測過），在單機單 DB 下「id 較大」
與「較晚建立」等價，正是這裡要的語意。

---

## 四、被否決的方案

記在這裡，因為每一個都看起來合理，而否決的理由多半是實測出來的；不留下來會再想到它們。

### 4.1 在 `Match` 存卡表指紋 + 用 trigger 自動蓋章

設計是 `Match` 加 `my_deck_fingerprint`，用 `AFTER INSERT` / `AFTER UPDATE OF my_deckId`
兩個 trigger 從 `Deck.fingerprint` 蓋章。吸引力在於它能同時覆蓋 TS 與 **Rust engine** 兩個
`Match` 寫入端（`ipc/matches.ts:710`、`tools/engine/src/store.rs:179`），不必把同一條規則
複製到兩種語言、五個變動點。

否決，四個理由：

1. **外鍵會連帶觸發 trigger（實測確認）。** `Match.my_deckId` 是 `ON DELETE SET NULL`，
   而 FK 的 SET NULL **會**觸發 `AFTER UPDATE OF my_deckId`。所以使用者刪一副牌組 → 那副牌
   所有對局的指紋被清空。為了防資料流失加的東西，自己造出一條新的、安靜的、不可回復的流失
   路徑。可以用 `WHEN ... AND NEW.my_deckId IS NOT NULL` 守住，但——
2. **守住之後，清除必須明寫**，因為 trigger 分不出「FK 連帶」與「使用者說這場沒有牌組」。
   於是要動 `store.rs:215`（2Pick 清除）加 TS 兩處，Rust 也得跟著改，原本的優點消失大半。
3. **兩個 process 用的 SQLite 版本不同**：better-sqlite3 13.0.3 → **3.53.4**，
   libsqlite3-sys 0.30.1 → **3.46.x**，兩邊各自執行同一組 trigger。任何依賴「FK action 與
   trigger 執行先後」這類無文件保證的行為都不能用（這也順帶否決了「用
   `EXISTS(SELECT 1 FROM Deck ...)` 判別是不是 FK 連帶」這個技巧）。
4. **卡表快照的時機找不到對的位置。** 指紋只是個鍵，要能查回卡表就得存快照；而
   `decks:delete` 是裸 DELETE，`DeckCard` 會 cascade 掉，這條路徑不經過
   `upsertDeckWithCards`。改成「寫入時存快照」可以補上，但那就變成又一張表加又一個不變量。

不可變模型把這四個問題**全部消滅**，而不是逐一繞過：卡表不會被改，所以根本不需要蓋章記錄
「當時是什麼」。

### 4.2 回填舊資料的指紋

不做。回填時手上唯一的值是牌組**現在**的卡表，把它蓋到三個月前那場對局上，做的正是要避免的
事——用今天的卡表解讀昨天的勝負，只是規模更大、更主動。

也找不到「只回填安全子集」的辦法：`Deck.updatedAt` 被改名（`decks.ts:625`）、設預設
（`decks.ts:666`）、發代碼（`decks.ts:999`）都會動到，分不出「換過兩張牌」與「只是改了名字」。

「這場用的卡表未知」不是缺漏待補，而是一個有內容的、而且永遠為真的答案。

**對比**：從 `DeckCard` 複製既有卡表的那種回填是**正當的**——複製現有資料、用 `Deck` 已經
帶著的指紋當鍵，沒有猜測。第三節 `familyId = id` 的回填同理。兩者性質不同，不要混為一談。

### 4.3 禁止舊牌組取得卡表

「手建的舊牌組不准補卡表」堵得住一個真實的洞（今天 `decks:saveLocal` 帶著既有 `deckId`
存檔時，會把卡表寫進一副 2023 年手建、底下掛了 200 場戰績的牌組，那 200 場當場全部被歸給
今天選的 40 張牌），成本也低。

但它管不到「有卡表、而且會被改的牌組」，而那是往後的多數情況；而且它有 UX 代價：一個累積
三年手記牌組的使用者最想做的事，大概就是幫這副牌補上真正的卡表。

不可變模型不需要這個禁令：舊牌組補卡表之後，**補之前**的對局指著的那一列從此不動，
**補之後**的對局指著的是有卡表的版本。逐場正確，不必逐副牌禁止。

### 4.4 使用者手動新建／複製

見 3.2：手工勞動 + 連結會斷。

---

## 五、實作階段

### 階段 1 — 資料從第一天就正確（不改 UI 外觀）

目標：凍結、fork、封存三條規則進資料層，而**畫面看起來跟今天一樣**。做法是牌組清單只顯示
每個家族的當前版本，所以 fork 出來的舊版本不會突然冒出來變成一堆同名項目。

| 檔案 | 改什麼 |
|---|---|
| `resources/migrations/011_add_deck_family.sql` | 新增，內容見第三節 |
| `src/main/data/db/client.ts` | `DeckRow` += `familyId: number \| null`、`archivedAt: number \| null` |
| `ipc/decks.ts:229`（`upsertDeckWithCards`） | 凍結判斷（同 transaction 內）+ fork；指紋沒變則 no-op；`familyId` 繼承；`isDefault` 移轉；provenance 不繼承 |
| `ipc/decks.ts:205`（`hasNameDuplicateCI`） | 同家族不算重名（fork 會沿用名稱） |
| `ipc/decks.ts:521`（`decks:create`） | 插入後補 `familyId = id` |
| `ipc/decks.ts:625`（`decks:update`） | 名稱／分類改成 `WHERE familyId = ?` 全家族套用 |
| `ipc/decks.ts:637`（`decks:delete`） | 作用整個家族：逐列數引用 → 真刪或封存；封存列若持有 `isDefault` 要清掉；回傳各做了幾列 |
| `ipc/decks.ts:394`（`decks:all`） | 只回每個家族的當前版本，且濾掉封存；另開參數才回全部版本。**MatchList 等把 deckId 對成名字的地方必須改用全部版本**，否則指向舊版本的對局會顯示成未知牌組 |
| `ipc/decks.ts:455`（`decks:stats`） | 加 `groupBy: 'family' \| 'deck'`，**預設 `family`**；不濾封存；多回一列「未指定牌組」 |
| `ipc/decks.ts:739`（`decks:import`） | `replaceDeckId` 語意改為「fork 進這副牌的家族」 |
| `ipc/decks.ts:854`（`decks:saveLocal`） | 加「修正、不建立新版本」模式（3.2 的逃生門） |
| `DeckManagerControl.tsx:978` | 刪除確認框文字 + 場次 + 封存說明 |

`decks:stats` 預設 `groupBy: 'family'` 是刻意的：**使用者今天看到的數字不會變**。這是這個
階段最重要的相容性保證，也是回歸測試要盯的那一條。

多回一列「未指定牌組」是順手補的顯示問題：現在 `decks:stats` 有
`WHERE my_deckId IS NOT NULL`（`decks.ts:477`），而 `DeckPerformance` 是把 stats 對到牌組
清單上（`DeckPerformance.tsx:185`），所以沒有牌組的對局既不在任何一列、也沒有一列收容它們，
分項合計就是對不上總場次，而畫面不會說差額去哪了。

**驗收**：編輯一副打過的牌組，DB 裡多出一列新版本、舊列與其戰績不動、`isDefault` 在新版本
身上、而畫面上的牌組清單與勝率數字跟改動前一模一樣。

**測試**（`tests/main/`，沿用 `deckImportIpc.test.ts` 與 `matchCreate.test.ts` 的架子；
`tests/helpers/db.ts` 跑的是真 migration，不用改）：

- 打過的牌組編輯 → fork；沒打過的 → 就地改
- fork 之後 `groupBy: 'family'` 的數字等於 fork 之前的數字（相容性回歸）
- `groupBy: 'deck'` 能把兩個版本的戰績分開
- 有戰績的牌組刪除 → 封存且統計不變；沒戰績的 → 真的消失
- 同家族可同名，跨家族仍擋
- fork 之後 `isDefault` 在新版本，且 engine 的
  `SELECT id FROM Deck WHERE class = ? AND isDefault = 1` 抓到的是新版本
- 封存牌組不出現在 `decks:all`，但仍出現在 `decks:stats`
- 「修正模式」不產生新版本
- 卡表沒變的存檔／重新匯入不產生新版本（no-op）
- 刪除多版本家族 → 全家族處理完，`decks:all` 不會冒出舊版本
- 封存持有 `isDefault` 的列之後，engine 的 `isDefault = 1` 查詢抓不到任何封存牌組
- fork 出的新列 `rawJson` / `sourceRef` 為空，`sourceKind = 'local'`
- `decks:update` 改名 → 家族全部列同步改名

### 階段 2 — 版本 UI

目標：讓使用者看得到版本。這是這整件事唯一貴的部分。

- 牌組清單：一個家族折疊成一列，可展開看版本（`DeckManager`、`DeckPerformance`）
- Analyzer 的牌組篩選：選家族或選單一版本
- 「顯示已封存」開關（3.3 的可見性規則）
- 版本之間的卡表 diff（「這一版比上一版換了哪兩張」）——這是使用者真正想看的東西
- Analyzer 篩選剔除已不存在的 deckId 時給提示，而不是安靜放寬。
  `Analyzer.tsx:183` 會把已不存在的 id 從篩選裡剔掉（刻意的，註解也寫了），但選中的 id
  **全部**被剔掉時 `deckIds` 變成空陣列，而空陣列的意思是「所有牌組」，於是「只看這副牌」的
  分析會靜靜變成「看全部」，數字看起來還很合理。

**驗收**：改兩張卡之後，能在一個畫面上看到 v1 與 v2 各自的場次與勝率，以及差異的那兩張卡。

**注意樣本數**：換兩張卡前後各三十場，勝率差異幾乎全是雜訊。這不是設計缺陷而是統計現實，
但它決定了預設值——預設看家族，要看版本再展開，且版本層級一定要顯示場次讓人自己判斷可信度。

### 階段 3 — 卡片維度統計

到這裡「卡片有沒有進統計」才算真正做完。因為 `my_deckId` 已經是一份確定的卡表，這階段
不需要任何新的資料結構，只是查詢：

- 單卡勝率：`Match` join `DeckCard`（用 `my_deckId`）group by `cardId`
- 「有帶這張卡 vs 沒帶」的對照
- 費用曲線與勝率的關係

**要記得**：以卡表分組時要一併 `GROUP BY my_class`。`fingerprintDeck`（`deckImport.ts:271`）
不含職業，理論上兩個職業的全中立牌組會有相同指紋；`Match.my_class` 本來就在，加上去即可。

**「同一份卡表」的分組鍵是 `fingerprint + class`，不是 `deckId`**：使用者把牌改回舊版
卡表時會 fork 出一列與舊版本內容相同的新列（時間語意上這是對的，v3 就是不同於 v1 的一段
時期），所以同一份 40 張牌可能散在多個 deckId 上。問「這份卡表的勝率」時要用指紋合併，
問「這個版本（這段時期）的勝率」才用 deckId。

---

## 六、判斷題

**J-2（來自 `deck-import-plan.md`）一個 Deck 對應幾份卡表？** ✅ **已決定：(b) 保留版本
歷史**，實作為「不可變的 Deck 列 + `familyId`」。理由見第二節。原本擔心的
「`Match.my_deckId` 語意模糊」在這個模型裡不成立。

**V-1 「修正、不建立新版本」要不要做？** 建議做。手動輸入打錯字是真實情況，沒有逃生門會
逼使用者用更糟的方式繞（新建一副，然後手動改一堆對局）。但預設必須是 fork，且要警告。

**V-2 有戰績的封存牌組要不要出現在 `DeckPerformance` 預設清單？** 建議預設隱藏、可切換、
灰階加標記。全都不顯示的話使用者會以為資料不見了；全都顯示的話清單會被退役牌組淹掉。

**V-3 版本序號要不要存成欄位？** 建議不存，用 `ROW_NUMBER()` 推導。見 3.4。

**V-4 清單上的刪除作用在單列還是家族？** ✅ **已決定（2026-09-02）：整個家族**。理由與
`isDefault` 的連帶規則見 3.3。「捨棄單一版本」是階段 2 版本 UI 的另一個操作。

**V-5 改名／改分類套用到家族還是單一版本？** ✅ **已決定（2026-09-02）：整個家族**。
名稱與分類是「這副牌」的屬性；規則見 3.1。

---

## 七、已經失去、追不回來的東西

- **011 上線之前已經被編輯或覆寫過的牌組**：舊卡表已經不存在，`Match` 也沒有留下線索，
  推不回來。這是必須接受的損失，不要試圖用「牌組現在的卡表」去填。
- **卡片維度的統計只涵蓋 011 上線之後的對局**（更精確地說：涵蓋那些指向一列從此不再改動的
  Deck 的對局）。這件事要在 UI 上講一句，不能讓使用者以為那個數字涵蓋全部歷史。
- **對手牌組（`oppo_deckId`）的卡表維度**：不做。對手牌組是使用者貼的標籤，幾乎不會有
  卡表。凍結與封存規則對它一樣適用（引用計數兩側都查），但不打算為它做卡片統計。

---

## 附錄：設計時實測過的事

在真的 `svwb-engine migrate` 建出來的資料庫上，用 better-sqlite3（與 app 同一個 driver）驗過。
列在這裡是因為其中幾條推翻了先前的設計，日後重新評估時值得先看一眼。

| 驗證的事 | 結果 |
|---|---|
| FK `ON DELETE SET NULL` 會不會觸發 `AFTER UPDATE OF` trigger | **會**——這條推翻了 4.1 |
| `PRAGMA recursive_triggers` 預設 | `0`（關閉） |
| `RETURNING` 看不看得到 trigger 改的值 | **看不到**（回 trigger 之前的值） |
| trigger 內層 UPDATE 會不會污染 `changes()` | 不會（樂觀鎖 `numUpdatedRows` 安全） |
| trigger 內層 UPDATE 會不會影響 `last_insert_rowid()` | 不會（`store.rs:196` 依賴它） |
| engine 的 `execute_batch` 吃不吃 `CREATE TRIGGER ... BEGIN ... END;` | 吃得下 |
| 兩個 process 的 SQLite 版本 | better-sqlite3 → 3.53.4；libsqlite3-sys 0.30.1 → 3.46.x |
| `Deck.id` 會不會被回收再用 | 不會（`AUTOINCREMENT`） |
| engine 會不會寫 `Deck` / `DeckCard` | **不會**（`tools/engine/src/*.rs` 零命中），TS 是唯一寫入者 |
| `DeckCard` 有幾個寫入點 | 一個：`upsertDeckWithCards`（`decks.ts:260` / `:271`） |
| `Deck.fingerprint` 與 `DeckCard` 內容是否必然一致 | 是（`deckImport.ts:373` 的 `count <= 0 continue` 與 `fingerprintDeck` 的 filter 條件相同，且同一 transaction 寫入） |
| engine 會不會在 insert 之後指定牌組 | 不會，只會清（`clear_my_deck` 是唯一路徑） |
| engine 在第一次 schema 變更前會不會備份 | 會（`store.rs:139`，保留五份） |
| `Match` 的寫入端有幾個 | 兩個：`ipc/matches.ts:710` 與 `tools/engine/src/store.rs:179` |
| `DeckBuilder` 是自動存還是明確存 | 明確按存檔才寫（`DeckBuilder.tsx:372`），所以編輯過程不會產生版本 |
