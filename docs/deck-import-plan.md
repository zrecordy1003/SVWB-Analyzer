# 計畫：牌組匯入、檢視與編輯

Last updated: 2026-08-31

本文件是「讓使用者把遊戲裡的牌組帶進 Analyzer，並在 Analyzer 裡看懂與調整它」這件事的唯一
計畫來源。相關既有文件：`ASSETS_POLICY.md`（素材與商標，本計畫會擴充其中一節）、
`docs/project-status-roadmap.md`。

> 狀態：**四個階段全部實作完成**（匯入、文字檢視、卡圖、卡池與編輯器、回寫遊戲）。
> 整條閉環已對真實 API 驗證：卡表 → hash → 4 碼代碼 → 在遊戲中解回同一副牌。
>
> **階段 A**：`src/shared/deckImport.ts`（純函式）、`src/main/data/svwbApi.ts`（唯一碰
> 網路處）、`resources/migrations/009_add_deck_import.sql`、`ipc/decks.ts` 的
> `decks:importPreview` / `decks:import` / `decks:cards`、`DeckFormDrawer.tsx` 的貼上欄位。
>
> **階段 B**：`src/main/data/cardImages.ts`（快取 + LRU）、
> `src/main/protocol/cardImageProtocol.ts`（`svwb-card://`）、`ipc/cardImages.ts`、
> `components/DeckCards/`（卡表元件與對話框）、`Settings/CardImageSettings.tsx`。
> 入口：牌組戰績表點任一列。
>
> **階段 C**：`resources/migrations/010_add_card_pool.sql`、`ipc/cards.ts`
> （`cards:pool` / `cards:syncPool` / `cards:poolStatus`）、`decks:saveLocal`、
> `components/DeckBuilder/DeckBuilder.tsx`。入口：牌組戰績工作列的「建立牌組」。
>
> **階段 D**：`buildDeckHashPayload`、`svwbApi.ts` 的 session／CSRF 與
> `requestDeckHash` / `publishDeckCode`、`decks:publishCode` / `decks:renewCode`、
> `components/DeckCards/DeckCodeDialog.tsx`。入口：牌組卡表對話框的「發行牌組代碼」。
>
> 測試：`deckImport.test.ts`（27）、`deckImportIpc.test.ts`（21）、`cardImages.test.ts`（19）、
> `cardPool.test.ts`（22）、`deckPublish.test.ts`（19）。

---

## 動機

`Deck` 目前只是一個標籤。它有 `name` / `class` / `categoryId` / `isDefault`，沒有任何卡片資訊
（`resources/migrations/001_init.sql`、`src/shared/domain.ts:94`）。使用者要建立牌組，得手動打
名字、選職業，而且打完之後 Analyzer 對這副牌一無所知——它只能回答「這個標籤的勝率是多少」，
不能回答「用這 40 張牌的勝率是多少」。

本計畫要做三層，價值與風險都遞增：

1. **匯入**：從遊戲代碼或分享連結把牌組帶進來，取代手動建立。
2. **檢視**：用卡片網格顯示牌組，讓使用者一眼認出「這是我那套牌」。
3. **編輯**：在 Analyzer 裡調整牌組，並產生代碼送回遊戲。

第 3 層之所以可行，是因為官方的寫入路徑已驗證可用（見下）。若沒有這個閉環，編輯功能只是
一個好看的筆記本，不值得做。

**本計畫不實作任何卡片層級的勝率分析**（某張卡在勝場中的出現率等）。那是資料備齊之後的
另一個計畫。

---

## 現況查證（2026-08-31，逐項對照程式碼）

| 事實 | 依據 | 影響 |
|---|---|---|
| `Deck` 無卡片欄位 | `001_init.sql:11-19`、`src/shared/domain.ts:94` | 需要新表，不是加欄位 |
| migration 由 Rust 引擎套用，檔名 `NNN_name.sql`，讀目錄後依序套 | `tools/engine/src/store.rs:99-129`、`main.rs:202-224` | **新增 SQL 檔即可，不必改 Rust** |
| decks 的 IPC 沒有 preload bridge，渲染層直接 `window.electron.ipcRenderer.invoke` | `src/renderer/src/hooks/useDecksTags.ts:67,98` | 新 channel 不必動 `preload/index.ts` 與 `global.d.ts` |
| `ipc/decks.ts` 已有 `wrap()` / `Res<T>` / `notifyReferenceDataChanged()` 慣例 | `src/main/ipc/decks.ts` | 新 handler 沿用，不另立錯誤模型 |
| 重名檢查是「同職業 + 同分類」不分大小寫 | `hasNameDuplicateCI()` | 匯入撞名要有自己的處理，不能直接丟 `DUPLICATE_NAME` |
| `classMap.ts` 的 id 與官方 `class_id` **同名但順序不同** | `classMap.ts:3-11` | 用陣列索引轉換會把主教與夜魔對調 |
| 渲染層 CSP 是 `img-src 'self' data:` | `src/renderer/index.html:10` | 卡圖需要自訂 protocol，不能熱連結 |
| `paths.ts` 已有 `userData/cache/<name>` 慣例 | `src/main/paths.ts:26` | 卡圖快取沿用同一層 |
| 專案已聲明不得打包 Cygames 素材 | `ASSETS_POLICY.md` §1 | 卡圖不得進 repo 或 installer |

---

## 官方 API 實測（2026-08-31）

shadowverse-wb.com 的 Deck Portal 有一組公開 API。**讀取免任何憑證；寫入需要 session cookie
與 CSRF token，但都不需要登入帳號。**

### 通用規則

| 項目 | 內容 |
|---|---|
| 語系 | request header **`Lang`**：`ja` / `en` / `cht` / `chs` / `ko`。query param、`Accept-Language`、cookie、Referer 全部無效 |
| 成功判定 | `data_headers.result_code === 1`；`10200` 查無資料；`1021` 參數或憑證不合法 |
| 讀取 | 無 cookie、無 CSRF 即可 |
| 寫入 | 需要 **`sid` cookie** 與**同一 session 取得的** `X-Csrf-Token`，外加 `X-Requested-With: XMLHttpRequest` |

CSRF token 從任何一次 GET 的 `data_headers.csrf_token` 取得。**用 `GET /web/Login/status`**
——它一次同時發 `sid` cookie 並回配對的 token。

不要試著從 HTML 頁面取 cookie：`curl` 拿得到，Node 的 `fetch` 拿不到（`getSetCookie()`
回空陣列），而 `Login/status` 兩者都正常。這個差異害煙霧測試第一次跑就紅了一項。

> 實測：帶 CSRF 但不帶 cookie → `1021`；同一 cookie jar 內先 GET 再 POST → 成功。
> 兩者缺一不可。

**CSRF token 是單次使用，而且每個回應都會輪替。** 每次回應的 `data_headers.csrf_token`
是下一次寫入該用的 token；重複使用上一個會被以 `1021` 拒絕。這在單一寫入時看不出來，
但 `getDeckHash` → `publish` 這個實際流程一定會踩到——第二次寫入必失敗。
（實作時就是這樣被抓到的：單元測試的假伺服器接受固定 token，所以全綠，真實 API 卻紅。）

### 讀取端點

| 用途 | 端點 |
|---|---|
| 4 碼遊戲代碼 → 牌組 | `POST /web/DeckCode/getDeck`，body `{"deck_code":"ufj1"}` |
| 長 hash → 牌組 | `GET /web/DeckBuilder/deckHashDetail?hash=1.7.cQnG...` |
| 職業卡池 | `GET /web/DeckBuilder/cards?class=0,<classId>&battle_format=<f>` |

兩支牌組端點回傳**完全相同**的 `data` 結構，正規化只寫一份。短碼**不能**丟給
`deckHashDetail`（回 `10200`）。

卡池端點**必須逐職業抓**，格式固定是「中立 + 一個職業」（`class=0,1,2,...,7` 會回錯誤）。
單一職業約 **199 張卡 / 561KB**（`Lang: cht`），7 個職業全抓約 3~4MB。回傳含
`skill_names`、`tribe_names`、`card_set_names`、`stats_list`，篩選器需要的分類官方都給了。

### 寫入端點（完整閉環，已實測）

```
卡表 --getDeckHash--> 長 hash --DeckCode/publish--> 4 碼代碼 --> 使用者在遊戲輸入
```

**1. `POST /web/DeckBuilder/getDeckHash`** — 卡表轉 hash

參數是**扁平的編號欄位對**，不是陣列（陣列 / CSV / form-encoded 全部回 `1021`）：

```jsonc
{
  "name": "", "is_published": 1, "status": 1,
  "class_id": 7, "deck_id": null, "battle_format": 1,
  "key_card_id": 10573310,          // 牌組封面，通常取第一張
  "card_id1": 10573310, "card_num1": 3,
  "card_id2": 10771310, "card_num2": 3,
  // ... 每個「卡種」一組，直到全部列完（40 張通常是 16 組左右）
}
```

實測用既有牌組還原出的 hash **與原 hash 完全相同**，代表這是確定性編碼，可安全用於往返。

**2. `POST /web/DeckCode/publish`** — hash 轉 4 碼代碼

body `{"hash":"1.7.cQnG..."}`，回 `{"data":{"deck_code":"uj9k"}}`。實測產生的代碼可用
`DeckCode/getDeck` 解回同一副牌。**不需要登入**（登入只影響「保存到我的牌組」）。

**代碼發行後 3 分鐘失效。** 官方頁面靠每 60 秒重打一次 `DeckCode/publish` 來續期
（`deck_code_publish.js` 裡的 `Reset Timer for lasting deck code`）。我們若要讓使用者
有充裕時間切到遊戲輸入，必須實作同樣的 keep-alive，並在使用者關閉畫面時停止。

### 資料結構

```
class_id            職業
battle_format       形式
sort_card_id_list   卡片 id（已排序、去重）
deck_card_num       { cardId: 張數 }，總和 40
mana_curve          { 費用: 張數 } —— 8 以上全部併進 key "8"
num_follower / num_spell / num_amulet
total_red_ether     分解值
card_details[id].common
    card_id / name / cost / atk / life / type / rarity / tribes
    skill_text / flavour_text / is_token
    deck_enabled_num        ← 該卡的張數上限，編輯器直接用這個，不必自建規則表
    card_image_hash         ← 配 /card/ 路徑
    card_banner_image_hash  ← 配 /list/ 路徑
```

**沒有牌組名稱欄位。** 讀取端點都不回傳使用者取的牌組名——名字必須由使用者自己填，或由
我們產生預設值。這是 UI 的硬限制。

### 卡圖

```
/uploads/card_image/<lang>/card/<card_image_hash>.png          468 KB  完整卡圖
/uploads/card_image/<lang>/list/<card_banner_image_hash>.png   128 KB  橫幅小圖
```

**兩條路徑吃不同的 hash，互換回 403。** 回應有 `ETag` / `Last-Modified` 但沒有
`Cache-Control`——不過路徑本身帶內容 hash，**檔名即版本**，所以快取邏輯是「檔案在就用，
不在就抓」，不需要 TTL 或條件式請求。

官方自己沒有更小的尺寸：牌組編輯頁用 `/card/` 再靠 CSS 縮小。

規模參考：一副牌 40 張小圖約 5MB、大圖約 19MB；一個職業的完整卡池小圖約 25MB。

### 職業圖示

```
/assets/images/common/common/class/class_<name>.svg   0.9-3.5 KB
    name = elf royal witch dragon nightmare bishop nemesis neutral
```

**注意這裡的 `<name>` 是 `classMap.ts` 的 id，不是 `class_id` 數字**，正好省掉一層對照表。
八個檔案合計不到 20 KB，回應是單色填充的 SVG，`viewBox` 從 374x280 到 390x444 都有——
長寬比不一致，縮放時必須 `contain`，不可拉伸（規範 1.1 只允許等比縮小）。

與卡圖最關鍵的差別：**這條路徑不帶內容 hash**。站上多數 bundle 圖檔是
`header_logo.CJIn198….png` 這種指紋檔名，但職業圖示是固定路徑，所以「檔名即版本」的推論
在這裡不成立——改圖之後 URL 不變，永久快取會把舊圖釘死一輩子。實作因此加了 30 天重新驗證
窗口，且**讀取時不 touch mtime**（否則天天用的圖示永遠不會過期）。

填充色與 `classMap.ts` 記的完全一致（elf `#439159`、witch `#535fa3`……），那份註解就是從
這些檔案抄來的。

實作在 `src/main/data/classIcons.ts`，與卡圖共用 `svwb-card://` scheme（host `class`）、
同一個 CSP 條目、同一個開關、同一顆清除按鈕——Cygames 的素材就是 Cygames 的素材，不該有
辦法只關掉一半。快取目錄則刻意分開（`cache/class-icons/`），因為卡圖那邊會 LRU 淘汰，20 KB
的圖示沒有理由去跟幾百 MB 的卡圖搶額度、或為了騰出一張卡的空間被刪掉。

深色底的問題要正面講：這些填充色是為官網淺色頁面畫的，nightmare 的 `#8d1e41` 對本 app 的
`#111318` 只有約 2:1。最直覺的解法（用遮罩把字形塗成 app 的亮色版職業色）**正是規範不允許
的修改**，所以做法是圖不動，改在下面墊一塊淺色底板（`ClassIcon` 的 `PLATE`），職業色移到
底板外框——這也是官網自己的呈現方式。

### 對照表

```
class_id   1 elf   2 royal   3 witch   4 dragon   5 nightmare   6 bishop   7 nemesis
           ^ 與 classMap.ts 同名但順序不同，必須用明確 lookup，不可用索引

type       1 從者   4 法術   2 和 3 都是護符（推測為永續 / 倒數，兩者都計入 num_amulet）
           ^ 由 num_follower/num_spell/num_amulet 交叉驗證兩副牌反推，非官方文件

battle_format   1 指定系列   2 無限制   3 無禁則   4 起始系列
```

### 為什麼不離線解碼 hash

長 hash 是 40 個 token（`1.7.cQnG.cQnG...`），token 數與 `deck_card_num` 完全對應，
確定是一對一映射。但編碼不是標準 base64url，逆向需要蒐集多組樣本。**而且 `getDeckHash`
已經提供了確定性的編碼服務**，離線解碼帶來的唯一好處（離線可用）不值得那個成本。

---

## 已定案的設計決策

**D-1 全部走官方 API，不做離線編解碼。**

**D-2 分享連結是主要匯入路徑，短碼是輔助。** 短碼 3 分鐘就失效，只能用在「剛從遊戲產生、
立刻貼上」的即時流程；長 hash 沒有效期，是唯一能長期保存與再次解析的形式。

**D-3 判重用內容 fingerprint，不用來源代碼。** 短碼會失效並被回收再發，拿它當識別鍵是錯的。
以 `sort_card_id_list` 搭配 `deck_card_num` 排序後算 hash。

**D-4 `rawJson` 必存。** 短碼沒有第二次機會重抓。

**D-5 匯入是 preview → commit 兩段式。** 因為 API 沒回傳牌組名，這一步本來就必要。

**D-6 卡圖走自訂 protocol，不熱連結、不打包。** 在 main 註冊 `svwb-card://`，CSP 加
`img-src 'self' data: svwb-card:`。渲染層不知道官方 URL、不直接連外；快取未命中時 main 才抓。
要關閉時 handler 回空圖，UI 一行都不用改。

> **卡圖預設已改為開啟**（2026-08-31，使用者決定）。原本是 opt-in，理由是勝率分析不需要
> 卡圖；但「認不出這是哪副牌」是更糟的取捨。**開關本身與「一鍵關掉整個卡圖路徑」的性質
> 不變**——這是 Cygames 得隨時撤銷許可時唯一的退路，不要拿掉。

**D-7 卡圖存檔案系統，不進 SQLite。** BLOB 會讓 DB 膨脹到數百 MB，拖累 WAL、備份，以及
`tests/helpers/db.ts` 的 in-memory 測試。DB 只存 hash。

**D-8 卡圖快取有容量上限與 LRU。** **600MB**（2026-09-01 由 200MB 上調）。Settings 顯示
用量並提供「清除卡圖快取」。

上調的理由是實測數字：建構器的卡池網格改用**全尺寸卡圖**（530×687，約 470KB），一個職業的
卡池約 175 張 ≈ **82MB**。在 200MB 的上限下，瀏覽第三個職業就會把第一個逐出，切回去等於
重抓一次已經抓過的卡池。600MB 大約容得下七個職業。這是上限而非預先佔用。

**兩種尺寸各有其位置**：左側卡池用 `/card/`（要能認出卡片才選得下去），右側牌組內容用
`/list/` 橫幅（那是一份用來掃視的清單，全圖會讓 40 列無法捲動，而且多花四倍流量換一張
沒人在挑的圖）。

**D-9 網路請求全部在 main process。** 用 `net.fetch`；session cookie 與 CSRF 的生命週期
也由 main 管理，渲染層完全不碰。

**D-11 編輯既有牌組不得改職業。** 牌組的職業是「它記錄的那些對局是用什麼職業打的」，
而 `upsertDeckWithCards` 只在 insert 時寫 `class`。允許改職業會產生一列「描述一副沒人打過的
牌」的資料，所以 UI 鎖住職業選擇、後端也在 `decks:saveLocal` 擋一次。與 `decks:update`
一開始就不碰職業是同一個理由。

**D-10 卡池在啟動時背景補齊。**（2026-08-31，使用者決定）原本是編輯器裡的手動按鈕，
但那是一個「使用者不知道要按」的按鈕。`data/cardPoolBootstrap.ts` 在啟動後背景執行，
只抓沒有的切片，所以第二次啟動完全免費。

刻意的取捨：**7 職業 × 2 形式 = 14 個請求、約 7~8MB，一次性**，請求之間留 400ms 間隔而
不是併發——這是別人的伺服器，社群工具沒有理由對它開 14 條連線。連續失敗兩次就停，下次
啟動再試；**不 await**，視窗不等它。兩種形式都抓是因為卡池會隨輪替分歧，而
`is_include_rotation` 推導不出指定系列（175 張裡只標了 114 張）。

---

## 判斷題（動工前需決定）

**J-1 卡池瀏覽要不要顯示全部卡圖？** ✅ 已決定並實作：**(a) 卡池網格顯示小圖**，但**跟隨
`settings.cardImages` 這個總開關**——開關關閉時卡池自動退成文字網格（每列多放一張卡）。
既然決定做編輯器，半套的卡池反而難用；`/list/` 小圖加上 LRU 上限已經把成本封住。

**J-2 一個 Deck 對應幾份卡表？** 牌組會隨版本調整。選項：(a) 一對一，重新匯入就覆蓋；
(b) 保留版本歷史，讓「改了兩張卡之後勝率變化」可分析。(b) 更有價值，但會讓
`Match.my_deckId` 的語意變模糊（指向哪個版本？）。**建議階段 B 先做 (a)**，schema 預留 (b)，
等階段 D 再處理。

**J-3 匯入的牌組預設叫什麼？** ✅ 已決定並實作：產生「復仇者0831」這類預設值讓使用者可改
——3 分鐘效期下任何多餘的必填欄位都是風險。

**只有月日、沒有分隔符**，因為名稱欄位是 8 字上限（`DeckFormDrawer` 的 `maxLength`），
而最長的職業標籤「皇家護衛」已經佔 4 字。原本規劃的「復仇者 2026/08/31」放不進去。

**J-4 要不要自動偵測剪貼簿？** 能大幅降低短碼流程的失敗率，但是背景讀剪貼簿，隱私觀感需
斟酌，且 4 碼英數誤判率不低。**建議第一版不做**，先看實際失敗率。

---

## 資料模型

```sql
-- resources/migrations/009_add_deck_import.sql
ALTER TABLE Deck ADD COLUMN sourceKind   TEXT;      -- 'code' | 'hash' | 'local' | NULL（手動建立）
ALTER TABLE Deck ADD COLUMN sourceRef    TEXT;      -- 長 hash
ALTER TABLE Deck ADD COLUMN fingerprint  TEXT;      -- 卡表內容 hash，判重用
ALTER TABLE Deck ADD COLUMN battleFormat INTEGER;
ALTER TABLE Deck ADD COLUMN keyCardId    INTEGER;   -- 牌組封面，回寫 getDeckHash 時要用
ALTER TABLE Deck ADD COLUMN importedAt   DATETIME;
ALTER TABLE Deck ADD COLUMN rawJson      TEXT;      -- 整包 API 回應

CREATE INDEX IF NOT EXISTS idx_deck_fingerprint ON Deck(fingerprint);

CREATE TABLE IF NOT EXISTS DeckCard (
  deckId  INTEGER NOT NULL,
  cardId  INTEGER NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (deckId, cardId),
  FOREIGN KEY(deckId) REFERENCES Deck(id) ON DELETE CASCADE
);

-- 卡片主資料快取，跨牌組共用
CREATE TABLE IF NOT EXISTS Card (
  cardId        INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  cost          INTEGER,
  type          INTEGER,
  class         INTEGER,
  rarity        INTEGER,
  atk           INTEGER,
  life          INTEGER,
  skillText     TEXT,
  tribes        TEXT,      -- JSON array
  deckEnabledNum INTEGER,
  imageHash     TEXT,      -- card_image_hash
  bannerHash    TEXT,      -- card_banner_image_hash
  isToken       INTEGER NOT NULL DEFAULT 0,
  lang          TEXT NOT NULL,
  updatedAt     DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_class_cost ON Card(class, cost);
```

`Card.lang` 存下抓取時的語系，因為 `name` / `skillText` 是語系相依的——使用者改語言時要能
知道快取已過時並整批重抓。

既有 `Deck` 的新欄位全部可為 NULL，手動建立的牌組完全不受影響。

---

## 路線圖

四個階段，每階段自成一個可發行的增量。**階段 A 不依賴任何判斷題，可立即開工。**

### 階段 A — 匯入與文字檢視 ✅

目標：使用者貼上代碼或連結就能建立牌組，並看到卡表。**不碰卡圖。**

- `src/shared/deckImport.ts`（純函式，全部有測試）
  - `parseDeckInput(text)` → `{ kind: 'code' | 'hash', value } | null`；處理 4 碼、長 hash、
    完整分享連結、前後空白與全形字元
  - `CLASS_ID_TO_NAME` / `CARD_TYPE` / `BATTLE_FORMAT` 明確 lookup table
  - `fingerprintDeck(cards)`
- `src/main/data/svwbApi.ts` — **唯一碰網路的地方**
  - session 管理（`sid` cookie + CSRF token 快取與更新）
  - `Lang` header。**目前是常數 `cht`**：`fetchDeck` 與 `decks:importPreview` 都已收
    `lang` 參數，接口留好了，但還沒接到使用者設定——語系真正開始有意義是在階段 B
    （卡圖路徑也帶語系），屆時一起做
  - timeout、單次重試、同 hash 記憶體快取
  - 錯誤分類：`INVALID_INPUT` / `NOT_FOUND_OR_EXPIRED` / `NETWORK` / `UNEXPECTED_SHAPE`
  - `UNEXPECTED_SHAPE` 要**降級不要炸**：職業解得出來就回部分結果
- `009_add_deck_import.sql` + `client.ts` 的 row 型別與 mapper
- IPC：`decks:importPreview`（不寫 DB）、`decks:import`（收 preview 物件，**不重抓**——
  短碼在使用者填名字期間可能已過期）
- `DeckFormDrawer.tsx` 加貼上欄位；預覽顯示職業、卡表、費用曲線、從者/法術/護符比例
- 判重：`fingerprint` 命中時回 `DUPLICATE_CONTENT` 附既有 deck id，由 UI 決定
  「更新 / 另存 / 取消」

**驗收**：貼上一個分享連結，30 秒內建立出一副有完整卡表的牌組。

### 階段 B — 卡圖與視覺化檢視 ✅

目標：牌組長得像官方那樣，使用者一眼認得出來。

實作時定下來的幾件事：

- **語系設定在這一階段才真的接上**（`settings.cardLang`），因為卡圖路徑本身帶語系。
  已匯入牌組的卡名維持匯入當時的語言，設定頁有明說；整批重抓卡名留給之後。
- **匯入預覽刻意不顯示卡圖**。那一步是短碼三分鐘效期內的確認動作，不該拿來等 40 張圖。
- **卡圖失敗只掉圖不掉字**：卡名疊在圖上，`onError` 後仍然看得到是哪張卡。
- 卡表元件同時吃 `StoredDeckCard` 與 `DeckImportCard`（結構型別 `DeckCardListItem`），
  所以預覽與檢視共用同一份渲染。

- `svwb-card://` protocol handler（main）
  - `svwb-card://list/<bannerHash>` 與 `svwb-card://card/<imageHash>`
  - 查 `userData/cache/cards/<lang>/` → 未命中則 `net.fetch` → 寫檔 → 回應
  - 總開關關閉時回空圖
- `paths.ts` 加 `getCardImageCacheDir(lang)`，與 `getTesseractCacheDir()` 同層
- LRU + 200MB 上限；Settings 加「清除卡圖快取」
- CSP 加 `svwb-card:`
- 牌組檢視改成卡片網格：費用排序、張數角標、hover 顯示大圖與卡片說明
- 首次開啟卡圖時顯示一次來源與著作權說明

**驗收**：關閉卡圖開關時，功能完全正常，只是沒有圖。

### 階段 C — 卡池與編輯器 ✅

目標：在 Analyzer 裡調整牌組。

- 卡池同步：逐職業抓 `/DeckBuilder/cards`，寫進 `Card`；記錄同步時間與語系
- 卡池 UI：搜尋框 + 費用 / 類型 / 稀有度 / 系列篩選 + 網格
- 編輯器佈局照官方：**左卡池、右牌組（`n / 40`）**，使用者有肌肉記憶
- 張數上限直接用 `Card.deckEnabledNum`，不自建規則表
- 編輯結果存本機 `Deck` + `DeckCard`，`sourceKind = 'local'`

**驗收**：能從零建出一副 40 張的牌並存起來。

### 階段 D — 回寫遊戲 ✅

目標：編好的牌組送回遊戲。這是編輯功能的價值所在。

- `POST /web/DeckBuilder/getDeckHash`（扁平編號欄位）→ 長 hash
- `POST /web/DeckCode/publish` → 4 碼代碼
- **代碼 keep-alive**：顯示代碼的畫面每 60 秒重打一次 publish 續期，畫面關閉即停止；
  UI 要顯示剩餘時間，讓使用者知道要盡快輸入
- 同時提供「複製分享連結」（用長 hash 組 `https://shadowverse-wb.com/cht/deck/detail/?hash=...`），
  這個沒有效期，是給使用者長期保存與分享用的
- 此時 J-2（版本歷史）值得重新評估——能編輯就會產生版本

**驗收**：在 Analyzer 改兩張卡，發代碼，在遊戲裡輸入後得到同一副牌。

---

## 合規要求

依 Cygames [內容規範](https://shadowverse-wb.com/cht/guideline/)（2026-08-31 讀取）與
`ASSETS_POLICY.md`。**注意規範管的是官方釋出的「粉絲素材（Fan kit）」，卡圖不在其中，
等於完全沒有授權**——這是卡圖與純文字資料的關鍵差別。

### 本專案散布的是什麼

需要講精確，因為這決定了風險的量級：**本專案不散布任何 Cygames 素材**。installer 與 repo 裡
一張卡圖都沒有，一行卡片文字都沒有。使用者執行 app 之後，是**他自己的機器**向 Cygames 自己的
伺服器請求，存在**他自己的磁碟**上。重製行為發生在使用者端、為個人使用，與瀏覽器快取官網圖片
的性質相同。

我們與單純的瀏覽器仍有一個差別：**是 app 主動發起這些請求，並把結果呈現在自己的 UI 裡**。
所以這不是「零涉入」，但它離「散布未授權重製物」很遠——後者才是真正的紅線，而我們不在那條線上。

### 絕對不可

- 把卡圖或卡片文字打包進 repo 或 installer（這才會變成散布）
- 修改卡圖——規範 1.1 只允許**等比縮小**，不得裁切、加濾鏡、合成
- 把卡表或卡圖做成自己的 API / CDN 供他人取用
- 顯示官方尚未公開的卡片

### 收費與贊助

規範 1.2 寫的是：「只要沒有獲得 Cygames 的明文許可，**粉絲網站**不得讓顧客或用戶進行任何種類
的支付或付費」。這句話的位置很重要——它是**使用粉絲素材（Fan kit）的條件**，不是一條普遍禁令。

因此要分開看：

| 情境 | 判讀 |
|---|---|
| 付費解鎖任何功能、付費版 / 免費版分級 | 🔴 明確衝突。不要做 |
| 贊助可換取任何回饋（去廣告、搶先體驗、專屬功能、名字上榜） | 🔴 實質上就是付費，同上 |
| 純粹自願贊助，**零回饋、零解鎖、與 app 內容完全脫鉤** | 🟡 灰色，但明顯較輕 |

若要做贊助，把風險壓到最低的具體做法：

- 贊助入口放在 About / README，**不要出現在任何顯示卡圖或卡片文字的畫面上**
- 文案寫「支持開發者」，不要寫「支持這個工具」或任何暗示在販售此 app 的說法
- **不提供任何回饋**——一有回饋就從捐贈變成交易
- 專案本身維持完全免費、功能不分級

同時要誠實面對：規範用字是「任何種類的支付或付費」，範圍寫得很寬，Cygames 若要從嚴解讀是
解讀得過去的；規範 2 也載明它得隨時撤銷許可。實務上社群工具接受贊助很普遍、風險不高，但
「風險不高」不等於「條款允許」。這是可以承受的風險，不是沒有風險——**這個判斷是你的，不是我的**。

### 必做（規範 1.1 明文要求）

- 顯示這些素材的**畫面上**（不是只有 About 底部）要有可讀的聲明：
  「本網站／應用程式與 Cygames 並無合作、推薦、贊助或個別承認關係……」
- `© Cygames, Inc.` 與「《Shadowverse: Worlds Beyond》及其標誌均為 Cygames 的商標」

規範 2 載明 Cygames 得隨時撤銷許可，因此架構上要能**一鍵關閉卡圖顯示而不影響核心功能**
（D-6 的 protocol handler 設計就是為此）。職業圖示走同一個 scheme、同一個開關，關掉之後
職業回到純色色塊，沒有任何功能因此消失。

對 API 本身：規範未涉及。基本禮貌——timeout、快取、不輪詢、不批次爬全站牌組。唯一的常態
輪詢是階段 D 的代碼 keep-alive，那是官方頁面自己的行為，且僅在使用者開著該畫面時進行。

> 以上是依條文的判讀，非法律意見。商業化前應取得專業意見。

---

## 明確不做的事

- **不做卡片層級的勝率分析。** 本計畫只負責把資料正確地存進來。
- **不做公開的卡查頁面。** 卡池只在編輯器情境下出現，不是獨立功能。
- **不逆向長 hash 的編碼。**
- **不做離線可用。** 匯入、卡池同步、回寫都需要網路。
- **不做帳號登入。** 「保存到我的牌組」是官方站的功能，我們只用免登入的部分。

---

## 測試

| 層 | 方式 |
|---|---|
| `shared/deckImport.ts` | 純單元測試：各種輸入格式、全形空白、失敗案例、fingerprint 穩定性 |
| `main/data/svwbApi.ts` | fixture 驅動，不打網路；含 `10200`、`1021`、缺欄位、非預期結構 |
| `getDeckHash` 參數組裝 | 純函式（卡表 → 扁平 body），用已知牌組的 fixture 釘住輸出 |
| IPC | 沿用 `tests/main/` 的 in-memory DB 慣例（`tests/helpers/db.ts`），測判重與 transaction |
| protocol handler | 快取命中 / 未命中 / 開關關閉三種路徑 |
| UI | 渲染層測試 infra 尚未建立，本計畫不引入 |

`class_id` 與 `type` 的對照表要有測試釘住——它們是反推來的，不是官方文件，
是最容易在改版後悄悄壞掉的地方。

**手動煙霧測試**（已實作）：`pnpm smoke:portal`（`tools/svwb-api-smoke.mjs`）。

刻意不進 CI：單元測試全部 fixture 驅動，所以離線與 CI 都會綠，也因此**整個測試套件
都不會察覺官方改版**。這支腳本就是察覺的那個東西。它檢查語系 header 是否仍生效、
`card_details[].common` 的巢狀是否還在、兩條卡圖路徑是否仍解析、以及
`getDeckHash` 是否仍還原成同一個 hash。

它**不呼叫 `DeckCode/publish`**——那會在 Cygames 的伺服器上產生真實代碼，一支可以隨手
重跑的腳本不該做這種事。要驗證短碼路徑就傳 `--code <剛產生的代碼>`。
