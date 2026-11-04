/**
 * `decks:*` 失敗時回的代碼 → 給人看的一句話。
 *
 * main 端丟的是 `DUPLICATE_NAME`、`NOT_FOUND:Deck` 這種機器字串（見
 * src/main/ipc/decks.ts）；直接畫出來，使用者看到的就是一個代碼。認不得的照
 * 原樣附在後面，至少回報問題時還有線索。
 */
export function deckErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'DUPLICATE_NAME':
      return '同職業、同分類下已經有相同名稱的牌組了。'
    case 'NOT_FOUND:Deck':
      return '找不到這副牌組，可能已經被刪除。'
    case 'NOT_FOUND:Category':
      return '找不到這個分類，可能已經被刪除。'
    case 'INVALID_INPUT:Name is required':
      return '請輸入牌組名稱。'
    case 'INVALID_INPUT:Name too long':
      return '牌組名稱太長了。'
    case 'INVALID_INPUT:Cannot change deck class':
      return '已建立的牌組不能更換職業。'
    case 'INVALID_INPUT:Deck is empty':
      return '牌組裡還沒有卡。'
    default:
      return `操作失敗：${code || '未知錯誤'}`
  }
}
