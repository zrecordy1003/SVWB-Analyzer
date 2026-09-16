/**
 * 把 `/v1/meta` 的格子換成畫面上的兩種列，以及一份分析器看得懂的資料。
 *
 * 全部是純函式，沒有 I/O，也不碰 React - 這頁真正會出錯的地方不是版面，是
 * 「佔比的分母是什麼」「勝率是誰的勝率」這種算術，而那種錯誤只有在能單獨餵
 * 數字進去比對時才驗得掉。和 `shared/stats.ts` 同一個理由。
 *
 * # 兩個方向，不要混在一起
 *
 * 文件裡的每一格都是「記錄者那一側」的：`myClass` 是裝了這個工具的人打的職業，
 * `oppoClass` 是他對面那個人的。於是同一份資料可以回答兩個不同的問題：
 *
 * - **環境佔比**看的是 `oppoClass` - 你在天梯上會遇到誰。對面那些人絕大多數
 *   沒有裝這個工具，所以這一側最接近「整個環境」。
 * - **職業勝率**看的是 `myClass` - 用這個職業的人打出什麼成績。這一側只有
 *   使用者，樣本偏差最大，`caveats` 第一條講的就是它。
 *
 * 把兩者對調（拿 `myClass` 當佔比）會得到「這個工具的使用者愛用什麼」，那是
 * 另一個問題的答案，而且看起來一模一樣。
 */
import { classes, classesMap } from '@renderer/map/classMap'
import { wilsonInterval, type Interval } from '@renderer/components/Analyzer/confidence'

import type { MetaDocument } from '@shared/meta'
import type { ClassName } from '@shared/domain'
import type { RankedWinrateByOpponent, SideStats, Stat } from '@shared/types'

const CLASS_ORDER = classes.map((c) => String(c.id))
const CLASS_ORDER_INDEX = new Map(CLASS_ORDER.map((id, i) => [id, i]))

const emptyStat = (): Stat => ({ wins: 0, total: 0, winRate: 0 })
const emptySide = (): SideStats => ({ first: emptyStat(), second: emptyStat(), all: emptyStat() })

/** 0 場不是 0%，所以比率是在最後一步由累加出來的分子分母算的，不是逐格平均。 */
function settle(stat: Stat): Stat {
  return { ...stat, winRate: stat.total > 0 ? +((stat.wins / stat.total) * 100).toFixed(2) : 0 }
}

function add(stat: Stat, wins: number, total: number): void {
  stat.wins += wins
  stat.total += total
}

/**
 * 一側（先攻或後攻）的戰績，帶著它自己的分母。
 *
 * 分母跟在數字旁邊而不是沿用列上的 `total`，因為它不是同一個數：見
 * `metaClassRows` 說明裡「兩個分母」那段。
 */
export type MetaSideSplit = {
  wins: number
  total: number
  /** `total` 為 0 時是 null - 沒有這一側的資料不是這一側勝率零。 */
  rate: number | null
}

export type MetaClassRow = {
  id: string
  label: string
  color: string
  /** 遇到這個職業的場次 - 分母是所有格子的總場次。 */
  encounters: number
  /** 佔比，0-100。 */
  share: number
  /** 用這個職業的人自己打出來的戰績，來自 `byClass`。 */
  wins: number
  total: number
  /** `total` 為 0 時是 null，而不是 0% - 沒人用過不是勝率零。 */
  rate: number | null
  interval: Interval
  /** 這個職業至少有幾個安裝撐著（伺服器給的是各格的最大值，見文件）。 */
  installs: number
  /** 先攻與後攻各自的戰績，由格子加總而來 - 分母是格子的，不是 `byClass` 的。 */
  first: MetaSideSplit
  second: MetaSideSplit
  /**
   * `total` 減掉兩側格子加起來的場次：`byClass` 有、格子裡沒有的那些。
   *
   * 正數表示有對位因為人數不足而沒被公開，兩側勝率的分母因此比總勝率的小；
   * 0 表示兩邊對得起來。畫面靠它決定要不要在 hover 裡多說一行。
   */
  withheld: number
  /**
   * 先攻勝率減後攻勝率，百分點；任一側沒資料就是 null，不拿 0% 去減。
   * 和 `MatchupRow.swing` 是同一個量，門檻也沿用那邊的 `SWING_THRESHOLD`。
   */
  swing: number | null
}

const emptySplit = (): MetaSideSplit => ({ wins: 0, total: 0, rate: null })
const settleSplit = (split: MetaSideSplit): MetaSideSplit => ({
  ...split,
  rate: split.total > 0 ? +((split.wins / split.total) * 100).toFixed(2) : null
})

/**
 * 一個職業一列：環境佔比 + 使用者側勝率（總的，以及先攻／後攻分開的）。
 *
 * 佔比和勝率的分母不同，而且刻意不同 - 佔比問「這職業有多常見」，勝率問「它有
 * 多強」。一個職業可以很常見又很爛，這頁的價值有一半在這裡。
 *
 * 佔比的分母是「有被公開的格子」的總和，不是伺服器記到的全部：低於 k-匿名
 * 門檻的格子根本不在文件裡（`sampling.suppressedMatches` 才知道有多少）。所以
 * 這是「公開資料中的佔比」，樣本少的時候和真實環境會有差距 - 頁面上那塊
 * 說明就是為了這件事存在的。
 *
 * # 勝率有兩個來源，而且兩個分母可以不一樣
 *
 * **總勝率**用 `byClass`。伺服器已經在同一份門檻下替每個職業算過一次分子分母，
 * 這裡若自己把格子加起來，兩邊各算各的遲早會對不起來，而對不起來的那天沒有
 * 人會發現 - 所以總的那個數字照抄伺服器的。
 *
 * **先攻／後攻**沒有這條路可走：`byClass` 不分先後手，只有 `cells` 有
 * `playOrder`。所以兩側的數字只能由格子加總，這正是上一段不想做的事，差別是
 * 這裡沒有第二個來源可以照抄。
 *
 * 於是兩邊的分母可以不一樣，而且不是 bug：低於 k-匿名門檻的格子整個不在文件裡，
 * 但 `byClass` 是以職業為單位過門檻的，那些被壓掉的對位仍然算在職業總數裡。
 * 樣本薄的時候，先攻分母加後攻分母會小於 `total`。今天 `suppressedCells` 是 0、
 * 兩邊剛好相等，那是資料現況，不是保證。
 *
 * 處理方式：**各報各的分母，不互相修正。**兩側的 n 是格子加總，總勝率的 n 是
 * `byClass` 的，差額放在 `withheld` 讓畫面在 hover 裡說「有對位因人數不足未公開」。
 * 拒絕掉的做法有兩個：拿格子加總覆寫 `total`，會讓總勝率跟伺服器（以及日後任何
 * 第三方讀同一份文件的人）對不起來；反過來把差額按比例攤進兩側，是在編造先後手
 * 分佈。兩個都比「兩個 n 不一樣、並且說明為什麼」糟。
 */
export function metaClassRows(doc: MetaDocument | null | undefined): MetaClassRow[] {
  const encounters = new Map<string, number>()
  const played = new Map<string, { wins: number; total: number }>()
  const installs = new Map<string, number>()
  const sides = new Map<string, { first: MetaSideSplit; second: MetaSideSplit }>()
  let grand = 0

  for (const cell of doc?.cells ?? []) {
    const total = Number(cell.total) || 0
    if (total <= 0) continue
    encounters.set(cell.oppoClass, (encounters.get(cell.oppoClass) ?? 0) + total)
    grand += total

    // 先後手那一側是記錄者的：`myClass` 用這個職業、`playOrder` 是他先還是後。
    // 分子夾在 [0, total]，和 `metaMatchup` 同一個防呆 - 文件是別人給的。
    const wins = Math.min(Math.max(Number(cell.wins) || 0, 0), total)
    const bucket = sides.get(cell.myClass) ?? { first: emptySplit(), second: emptySplit() }
    const side = cell.playOrder === 'first' ? bucket.first : bucket.second
    side.wins += wins
    side.total += total
    sides.set(cell.myClass, bucket)
  }

  // 總勝率照抄 `byClass`，理由見上方說明 - 這裡不把格子加起來當總數。
  for (const row of doc?.byClass ?? []) {
    played.set(row.myClass, { wins: Number(row.wins) || 0, total: Number(row.total) || 0 })
    installs.set(row.myClass, Number(row.installs) || 0)
  }

  const ids = new Set<string>([...CLASS_ORDER, ...encounters.keys(), ...played.keys()])

  return [...ids]
    .map((id) => {
      const record = played.get(id) ?? { wins: 0, total: 0 }
      const seen = encounters.get(id) ?? 0
      const bucket = sides.get(id) ?? { first: emptySplit(), second: emptySplit() }
      const first = settleSplit(bucket.first)
      const second = settleSplit(bucket.second)
      return {
        id,
        label: classesMap[id as keyof typeof classesMap]?.label ?? id,
        color: classesMap[id as keyof typeof classesMap]?.color ?? '#9e9e9e',
        encounters: seen,
        share: grand > 0 ? +((seen / grand) * 100).toFixed(2) : 0,
        wins: record.wins,
        total: record.total,
        rate: record.total > 0 ? +((record.wins / record.total) * 100).toFixed(2) : null,
        interval: wilsonInterval(record.wins, record.total),
        installs: installs.get(id) ?? 0,
        first,
        second,
        withheld: record.total - (first.total + second.total),
        swing:
          first.rate !== null && second.rate !== null
            ? +(first.rate - second.rate).toFixed(2)
            : null
      }
    })
    .sort(
      (a, b) =>
        b.share - a.share ||
        (CLASS_ORDER_INDEX.get(a.id) ?? 99) - (CLASS_ORDER_INDEX.get(b.id) ?? 99)
    )
}

/**
 * 一個職業的對位表，形狀和分析器的查詢結果一模一樣。
 *
 * 這不是為了省事。`MatchupHeatmap` / `MatchupBars` 已經定義好「五五開是幾趴」
 * 「幾場以下算樣本薄」「先後差多少值得標」，環境頁若自己再畫一張，同一件事
 * 就會有兩套門檻，而讀者會以為那是資料的差別。計畫 P6 寫的也是這件事：呈現端
 * 沿用既有的圖，差別只在資料來源。
 *
 * `start` / `end` 填的是文件的統計窗，所以圖上那行期間講的是伺服器算的區間，
 * 不是這台機器的對局。`limit` 是 null - 「最近 N 場」在這裡沒有意義。
 */
export function metaMatchup(
  doc: MetaDocument | null | undefined,
  myClass: ClassName
): RankedWinrateByOpponent {
  const byOpponent: Record<string, SideStats> = Object.fromEntries(
    CLASS_ORDER.map((id) => [id, emptySide()])
  )
  const overall = emptySide()

  for (const cell of doc?.cells ?? []) {
    if (cell.myClass !== myClass) continue
    const total = Number(cell.total) || 0
    if (total <= 0) continue
    const wins = Math.min(Math.max(Number(cell.wins) || 0, 0), total)
    const side = cell.playOrder === 'first' ? 'first' : 'second'

    byOpponent[cell.oppoClass] ??= emptySide()
    add(byOpponent[cell.oppoClass][side], wins, total)
    add(byOpponent[cell.oppoClass].all, wins, total)
    add(overall[side], wins, total)
    add(overall.all, wins, total)
  }

  for (const stats of Object.values(byOpponent)) {
    stats.first = settle(stats.first)
    stats.second = settle(stats.second)
    stats.all = settle(stats.all)
  }

  const since = doc?.window?.since ? Date.parse(`${doc.window.since}T00:00:00Z`) : NaN
  const until = doc?.generatedAt ? Date.parse(doc.generatedAt) : NaN

  return {
    myClass,
    start: Number.isFinite(since) ? since : null,
    end: Number.isFinite(until) ? until : null,
    byOpponent,
    overall: {
      first: settle(overall.first),
      second: settle(overall.second),
      all: settle(overall.all)
    },
    crMin: null,
    crMax: null,
    limit: null
  }
}

/** 這份文件真的有格子的職業。沒有資料的職業不該在選單裡等人點進去看空表。 */
export function metaClassesWithData(doc: MetaDocument | null | undefined): Set<string> {
  const present = new Set<string>()
  for (const cell of doc?.cells ?? []) {
    if ((Number(cell.total) || 0) > 0) present.add(cell.myClass)
  }
  return present
}

/**
 * 先手優勢，整個環境合起來看，單位是百分點。
 *
 * 兩側都有資料才給得出來；任一側是空的就是 null，而不是拿 0% 去減。
 */
export function metaFirstTurnAdvantage(doc: MetaDocument | null | undefined): number | null {
  let firstWins = 0
  let firstTotal = 0
  let secondWins = 0
  let secondTotal = 0

  for (const cell of doc?.cells ?? []) {
    const total = Number(cell.total) || 0
    if (total <= 0) continue
    const wins = Math.min(Math.max(Number(cell.wins) || 0, 0), total)
    if (cell.playOrder === 'first') {
      firstWins += wins
      firstTotal += total
    } else {
      secondWins += wins
      secondTotal += total
    }
  }

  if (firstTotal === 0 || secondTotal === 0) return null
  return +((firstWins / firstTotal) * 100 - (secondWins / secondTotal) * 100).toFixed(2)
}
