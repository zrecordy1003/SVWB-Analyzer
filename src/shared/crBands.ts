/**
 * CR 的邊界與分段。
 *
 * 段位切點是遊戲定的，不是某個畫面的設定，所以放在 `shared`：main、renderer、
 * `server/telemetry` 三邊讀的是同一份。原本這份常數住在
 * `renderer/components/Common/filters/crBounds.ts`，那個檔案現在只是往這裡的
 * re-export——搬上來的理由跟它原本被建立的理由是同一個：兩個地方各存一份的時候，
 * 「1850 – 1999」在一邊改了另一邊不會跟著改。
 *
 * 加上 telemetry 之後這件事變得更嚴格：伺服器驗證的白名單直接 import 這裡
 * （跟 `telemetry.ts` 其他列舉值一樣），所以 app 寫得出來的段位、伺服器就收得下。
 * 改動任何一個切點都會讓新舊安裝送出不同的段位鍵，而舊資料不會被重算——所以切點
 * 一旦上線就別再動；真要改，改的是**新增**一段，不是移動既有的邊界。
 */

export const CR_MIN_BOUND = 0
export const CR_MAX_BOUND = 3000
export const CR_STEP = 1

export type CrBand = { key: string; label: string; min: number; max: number }

export const CR_BANDS: CrBand[] = [
  { key: 'lt1650', label: '1650 以下', min: CR_MIN_BOUND, max: 1649 },
  { key: 'b1650', label: '1650 – 1749', min: 1650, max: 1749 },
  { key: 'b1750', label: '1750 – 1849', min: 1750, max: 1849 },
  { key: 'b1850', label: '1850 – 1999', min: 1850, max: 1999 },
  { key: 'gte2000', label: '2000 以上', min: 2000, max: CR_MAX_BOUND }
]

/**
 * 沒有 CR 可讀時的段位鍵。
 *
 * 這一段是**必要的**，不是補漏。CR 只有排位模式的畫面上才有，而且引擎不是每場都
 * 讀得到；`legacy` 的舊資料更是幾乎都沒有。如果把沒有 CR 的對局從桶裡丟掉，
 * 總場數就會跟著變，現有那張不分階級的矩陣會無聲地縮小——那是把一個顯示問題
 * 換成一個資料問題。有了這一段，「不分階級」永遠等於把所有段位加回來。
 */
export const CR_BAND_UNKNOWN = 'unknown'

/** 上傳與伺服器驗證共用的白名單，`unknown` 在最後。 */
export const CR_BAND_KEYS: readonly string[] = [
  ...CR_BANDS.map((band) => band.key),
  CR_BAND_UNKNOWN
]

export function clampCr(value: number): number {
  return Math.min(CR_MAX_BOUND, Math.max(CR_MIN_BOUND, Math.round(value)))
}

/**
 * 一個 CR 值落在哪一段。
 *
 * `null`、非有限數、以及落在所有段之外的值都回 `unknown`——最後那個理由是
 * 邊界是寫死的，而一個超出 0–3000 的值代表讀錯了，不該被算進任何一段。
 */
export function crBandOf(cr: number | null | undefined): string {
  if (typeof cr !== 'number' || !Number.isFinite(cr)) return CR_BAND_UNKNOWN
  const band = CR_BANDS.find((entry) => cr >= entry.min && cr <= entry.max)
  return band ? band.key : CR_BAND_UNKNOWN
}

/** 段位鍵 → 給人看的標籤。未知的鍵原樣回傳，不要在顯示端消失。 */
export function crBandLabel(key: string): string {
  if (key === CR_BAND_UNKNOWN) return '無 CR'
  return CR_BANDS.find((band) => band.key === key)?.label ?? key
}
