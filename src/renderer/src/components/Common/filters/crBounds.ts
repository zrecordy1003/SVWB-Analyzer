/**
 * CR 的邊界與分段，兩個頁面的 CR 篩選共用同一組。
 *
 * 實際的定義搬到 `src/shared/crBands.ts` 了——telemetry 的上傳與伺服器驗證也要用
 * 同一組切點，而 renderer 底下的東西 main 與 `server/telemetry` 讀不到。這個檔案
 * 留著只是為了不用去改三個 import 路徑；新的程式碼請直接從 `@shared/crBands` 拿。
 */
export {
  CR_BANDS,
  CR_MAX_BOUND,
  CR_MIN_BOUND,
  CR_STEP,
  clampCr,
  type CrBand
} from '@shared/crBands'
