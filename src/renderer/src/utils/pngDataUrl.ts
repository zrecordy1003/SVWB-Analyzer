/**
 * 把資料庫裡的 PNG bytes 變成 `<img src>` 用的 data URL。
 *
 * 目前只有對手名牌（`Match.oppo_name_crop`）走這條路。它是引擎從 versus 畫面裁下
 * 來的一小張圖，最大 1.5 KB，跨 IPC 過來時是 structured clone 保留下來的
 * `Uint8Array`。
 *
 * 用 data URL 而不是 `URL.createObjectURL`：後者要配一個 revoke，而列表是虛擬捲動
 * 的——卡片會反覆掛載卸載，漏掉一次 revoke 就是一條慢慢長大的洩漏。這些圖小到
 * base64 的三分之一膨脹無關緊要，字串又能直接被 React 當成不可變的 prop。
 */
export function toPngDataUrl(bytes: Uint8Array): string {
  // 逐塊處理而不是 `String.fromCharCode(...bytes)`：後者把每個 byte 展開成一個
  // 引數，長一點的輸入就會炸掉呼叫堆疊。名牌遠遠不到那個量，但這個函式沒有任何
  // 地方寫著「只能餵小圖」。
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:image/png;base64,${btoa(binary)}`
}
