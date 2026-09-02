# 調研：成熟工具怎麼處理「牌組 ↔ 卡片」與卡片層級統計

Last updated: 2026-09-02

背景：`docs/deck-versioning-plan.md` 階段 3 做出來的家族內卡片統計，實際畫面上一副三版本的牌組
17 張卡有 11 張顯示同一個數字（= 牌組勝率）。這份調研是在重新設計之前，先看 Hearthstone /
MTG Arena / Marvel Snap 生態裡成熟的工具怎麼做，避免自己發明一套業界已經證明沒訊號的東西。

---

## 一、牌組與版本的關係

| 工具 | 模型 | 對我們的意義 |
|---|---|---|
| **Hearthstone Deck Tracker（HDT）** | 一副牌一個固定 `DeckId`（Guid），底下 `Versions: List<Deck>`；版本號是使用者存檔時**自己挑**的 `Major.Minor`（小改 1.1、大改 2.0）。對局綁在**特定版本**上（`BelongsToDeckVersion`）；統計範圍用 `DisplayedStats` 切換：全部版本／最新／選定版本／最新大版本。另有 `Archived` 旗標 | 跟我們的 `familyId` + 不可變列 + `groupBy: family/deck` **同構**——方向被驗證。差別是 HDT 讓使用者存檔時選版本號，issue #777 顯示這會產生重複版本與混亂；我們「打過就凍結、自動 fork」省掉這個決定 |
| **Untapped.gg（MTGA）** | 「Track Deck Versions」列為付費的個人統計功能；版本由追蹤器看到的實際卡表自動判定 | 版本追蹤被視為**進階付費價值**，值得做好 |
| **SnapComplete（Marvel Snap）** | 牌組以**精確的 12 張組合**識別，每個不同組合是獨立一筆；社群統計有「最少場次／最少玩家數」門檻篩選；社群勝率做混合平滑（往全局先驗收縮），**個人統計不平滑**、直接顯示原始值 | 「一列 = 一份確定卡表」與我們相同。門檻篩選與「個人資料不平滑、但要標樣本」是可直接借用的呈現規則 |
| **HSReplay** | 全球資料用聚類把相近卡表歸成 archetype | 個人工具用不到聚類；家族就是我們的 archetype |

**結論**：我們的資料模型不需要改。可借用的是 HDT 的「統計範圍切換」（我們已有）與
SnapComplete 的樣本門檻篩選。

---

## 二、卡片層級統計：業界的共識

### 2.1 有事件資料的工具，全部用「抽到／在手／打出」，不用「在牌組裡」

| 工具 | 每張卡的指標 |
|---|---|
| **HSReplay**（牌組頁的卡片表，付費） | Mulligan Winrate（在起手時的勝率）、Kept %（起手留下率）、Winrate When Drawn（任一時點抽到的勝率）、Avg. Turns Held、Avg. Turn Played |
| **17Lands**（MTGA 限制賽） | GIH WR（在手勝率，首選）、OH WR（起手勝率）、GD WR（後抽勝率）、GNS/GND WR（沒抽到勝率）、**IWD = GIH − GND**（抽到帶來的改善）、GP WR（**牌組帶著它**的勝率）|
| **Firestone** | 同 HSReplay，並有「show impact」切換：把 Mulligan／Drawn 勝率顯示成**相對牌組整體勝率的差值** |
| **snap.fan / Marvel Snap Zone / SnapComplete** | Win rate **when drawn**、Cube rate **when drawn**、Inclusion（play）rate；個人頁面同樣是「抽到時」|

**17Lands 對 GP WR（卡在牌組裡的勝率）的評價是「最沒用的指標，反映的是牌組強度不是卡片強度」**
——因為一半的對局根本沒抽到那張卡。這正是我們階段 3 做的東西：`有帶勝率` 就是 GP WR。
「11 張卡同一個數字」不是排版問題，是這個指標在單一家族內**數學上必然**等於牌組勝率。

### 2.2 呈現規則

- **永遠相對於基準線**，不是絕對值：Firestone 的 impact、17Lands 的 IWD、SnapComplete 的
  「社群 54% vs 你 46%」。使用者要看的是「這張卡讓我比平常好還是差」。
- **樣本門檻是一等公民**：SnapComplete 有 10/25/50/100/250 場的最少場次篩選；17Lands 說 IWD
  「只有極端值可信」。個人資料尤其如此。
- **卡片統計是獨立頁面**：HSReplay Cards 頁、17Lands card data、snap.fan card leaderboard、
  SnapComplete `/matches/cards` 都是跨牌組的獨立入口；牌組頁裡只放該牌組範圍內的卡片表。
- **個人頁與社群頁分開**，個人頁不做平滑、排序預設用「出場份額」而非勝率（勝率排序會被小樣本
  極端值霸榜）。

---

> **狀態（2026-09-02）**：第三節的四個結論已全部實作——家族展開區只剩版本時間線、
> 卡片成為獨立頁面（`src/renderer/src/components/Cards/`）、費用曲線與 Analyzer 卡片圖表移除。
> 頁面文案明講「這些是牌組的成績，不是卡片本身的」，欄位設計預留了日後加入抽牌／在手指標的位置。

## 三、我們的處境與結論

**我們沒有事件資料。** `Match` 只有勝負、先後攻、職業、牌組、模式、時間（`001_init.sql`）；
engine 是畫面辨識對局結果，沒有記錄抽牌／出牌。所以 HSReplay／17Lands 那類指標**做不出來**，
能做的只有 GP WR——業界公認最弱的那一個。

這推出三個結論：

1. **家族內的卡片分頁應該拿掉。** 在單一家族裡，GP WR 唯一有訊號的地方是「版本之間換掉的那幾
   張卡」，而那正是版本 diff 已經回答的問題。把 diff 做好（內嵌在版本列、附上前後版本的勝率差）
   就是家族層級對卡片問題的完整答案。
2. **卡片作為獨立頁面是對的，但要重新定義它在回答什麼。** 沒有事件資料時，誠實的問題是
   「這張卡出現在我哪些牌組／版本裡、那些牌組打得怎樣」——一個以卡片為軸的**檢索與下鑽**工具，
   不是「卡片強度排行」。指標命名要如實：「帶入時牌組勝率」而非「卡片勝率」；差值要相對於
   **同職業不帶它的牌組**（相當於 IWD 的牌組版本），且套用樣本門檻。
3. **為將來的事件資料留位置。** 若 engine 日後能辨識起手／抽牌／出牌（它已經在做畫面辨識），
   GIH／Mulligan 一類指標才是真正的卡片統計；頁面欄位設計成可以加欄，不要把現在的 GP WR
   做成不能替換的核心。
4. **費用曲線 vs 勝率**：沒有任何調研到的工具把它當成統計指標（費用曲線只作為牌組結構的描述）。
   拿掉。

---

## 來源

- HSReplay：[Introducing HSReplay.net Statistics](https://hsreplay.net/articles/7/introducing-hsreplaynet-statistics)、
  [New Premium Feature – Card Mulligan Data](https://articles.hsreplay.net/2020/07/23/card-mulligan-data/)、
  [The Art of the Mulligan](https://articles.hsreplay.net/2019/04/15/the-art-of-mulligan/)、
  [HearthPwn：Mulligan WR vs Played WR 的討論](https://www.hearthpwn.com/forums/hearthstone-general/general-discussion/218587-what-does-a-card-having-highest-mulligan-win-rate)
- 17Lands：[Metrics definitions](https://www.17lands.com/metrics_definitions)、
  [Using Win Rate Data](https://blog.17lands.com/posts/using-win-rate-data/)、
  [MTG Arena Zone：17Lands: In Defense of the Data](https://mtgazone.com/17lands-in-defense-of-the-data/)
- HDT：[Deck.cs 原始碼](https://github.com/HearthSim/Hearthstone-Deck-Tracker/blob/master/Hearthstone%20Deck%20Tracker/Hearthstone/Deck.cs)、
  [Issue #777：版本號重複](https://github.com/HearthSim/Hearthstone-Deck-Tracker/issues/777)、
  [CHANGELOG](https://github.com/HearthSim/Hearthstone-Deck-Tracker/blob/master/CHANGELOG.md)
- Firestone：[「show impact」說明](https://x.com/ZerotoHeroes_HS/status/1758131548220748124)、
  [HSGuru Stats Explanation](https://www.hsguru.com/stats/explanation)
- Untapped.gg：[Premium 功能列表（Track Deck Versions）](https://mtga.untapped.gg/premium)、
  [Companion](https://mtga.untapped.gg/companion)
- Marvel Snap：[SnapComplete Deck Stats](https://snapcomplete.com/features/deck-stats)、
  [SnapComplete 個人卡片統計](https://snapcomplete.com/play/matches/cards)、
  [snap.fan Card Stats](https://snap.fan/matches/statistics)、
  [Marvel Snap Zone：Cube Rate or Win Rate?](https://marvelsnapzone.com/cube-rate-or-win-rate/)
- 其他：[MTG Arena Tool](https://mtgatool.com/)、
  [ShadowverseDeckTracker](https://github.com/shadowversedecktracker/ShadowverseDeckTracker)
