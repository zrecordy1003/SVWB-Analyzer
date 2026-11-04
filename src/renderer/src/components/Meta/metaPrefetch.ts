/**
 * 環境數據的預先載入：使用者點進這頁之前，資料就先抓好。
 *
 * `App.tsx` 在第一頁畫完、閒下來的時候已經會先抓各頁的程式碼；這支檔案讓它
 * 順便把這頁要的那一份資料也抓了。少了它，第一次點進來一定先看到一整片骨架，
 * 等一趟網路來回 - 而這頁的資料是公開的彙總，十五分鐘才變一次
 * （`src/main/ipc/meta.ts` 的 `CACHE_TTL_MS`），早一點抓沒有新舊的問題。
 *
 * 抓的是**使用者存過的那個區間**，所以要先讀設定：抓預設的 14 天，對選了 30 天
 * 的人來說等於白抓一次、進頁時照樣等。設定的解析因此搬到這裡，頁面與預先載入
 * 共用同一份，兩邊不會對「存的是什麼」有兩種讀法。
 *
 * 這支檔案被 `App.tsx` 靜態引入（主 bundle 的一部分），所以刻意保持很小：
 * 不碰任何元件，只有設定解析與一次 IPC。
 */
import { readSetting } from '@renderer/components/Analyzer/filterState'
import { invokeIpc } from '@renderer/ipc'
import { classes } from '@renderer/map/classMap'

import { META_WINDOW_DAYS, type MetaSnapshot, type MetaWindowDays } from '@shared/meta'
import type { ClassName } from '@shared/domain'

export type ChartKind = 'heatmap' | 'bars'

export const DEFAULT_META_DAYS: MetaWindowDays = 14

export const META_SETTINGS_KEYS = {
  days: 'meta.days',
  myClass: 'meta.myClass',
  chartKind: 'meta.chartKind'
} as const

/**
 * 資料多舊就該重抓。和主程式那層快取同一個數：比它更勤只會拿到同一份，
 * 而且這個端點按來源位址限流。
 */
export const META_STALE_MS = 15 * 60_000

export const isWindowDays = (value: unknown): value is MetaWindowDays =>
  (META_WINDOW_DAYS as readonly number[]).includes(Number(value))

export const isClassName = (value: unknown): value is ClassName =>
  classes.some((klass) => String(klass.id) === value)

/** 這頁存過的偏好。沒存過（或存的值已經不合法）的欄位留空，由頁面用預設值。 */
export type MetaPrefs = { days?: MetaWindowDays; myClass?: ClassName; chartKind?: ChartKind }

export function parseMetaPrefs(raw: Record<string, unknown> | null | undefined): MetaPrefs {
  if (!raw) return {}
  const prefs: MetaPrefs = {}
  const days = readSetting(raw, META_SETTINGS_KEYS.days)
  if (isWindowDays(days)) prefs.days = Number(days) as MetaWindowDays
  const myClass = readSetting(raw, META_SETTINGS_KEYS.myClass)
  if (isClassName(myClass)) prefs.myClass = myClass
  const chartKind = readSetting(raw, META_SETTINGS_KEYS.chartKind)
  if (chartKind === 'heatmap' || chartKind === 'bars') prefs.chartKind = chartKind
  return prefs
}

/** 預先載入的成果：讀到的偏好，與（抓得到的話）那個區間的資料。 */
export type WarmMeta = { prefs: MetaPrefs; days: MetaWindowDays; snapshot: MetaSnapshot | null }

let warm: WarmMeta | null = null
let inflight: Promise<void> | null = null

/**
 * 讀設定、抓那個區間的資料，結果留給頁面第一次掛上時拿。
 *
 * 只做一次：頁面掛上以後就一直留著（`App.tsx` 不卸載去過的頁），之後的新舊由
 * 頁面自己管。失敗不重試、不報錯 - 這只是提早做頁面本來就會做的事，頁面掛上時
 * 拿不到就照原本的路自己抓，錯誤也由它用一句話說。
 */
export function prefetchMeta(): Promise<void> {
  inflight ??= (async () => {
    const raw = await window.settings.getAll().catch(() => null)
    const prefs = parseMetaPrefs(raw as Record<string, unknown> | null)
    const days = prefs.days ?? DEFAULT_META_DAYS
    // 先把偏好放好：資料抓失敗時，頁面至少不用再讀一次設定。
    warm = { prefs, days, snapshot: null }
    const res = await invokeIpc('meta:fetch', { days, refresh: false })
    if (res.ok && warm) warm = { ...warm, snapshot: res.data }
  })().catch(() => {})
  return inflight
}

/**
 * 預先載入**已經完成**的成果，同步拿，只給一次。
 *
 * 同步是重點：頁面用它當 state 的初始值，第一幀就是有資料的版面，而不是先畫
 * 骨架、下一個 tick 才換掉 - 那一下就是使用者會說「抖」的東西。
 */
export function takeWarmMeta(): WarmMeta | null {
  const done = warm?.snapshot ? warm : null
  if (done) warm = null
  return done
}

/** 預先載入還在跑的話等它跑完，免得頁面同時再發一次同樣的請求。 */
export async function settledPrefetch(): Promise<WarmMeta | null> {
  if (inflight) await inflight
  const result = warm
  warm = null
  return result
}
