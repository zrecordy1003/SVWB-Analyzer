/**
 * 卡圖裡「插畫」佔的那一窗，以及把它裁進一個格子所需要的算式。
 *
 * 來源是 `tools/engine/src/fingerprint.rs` 的 `PORTAL_ART_FRACTION`：引擎拿卡圖跟
 * 換牌畫面比對時就是裁這一塊，那裡記了它怎麼校出來的。這裡照抄而不是自己挑一個
 * 好看的框，理由有兩個：它已經被驗證過是「去掉卡框、費用、名條與文字框之後剩下
 * 的畫」；而且畫面上的一格和引擎比對用的參考圖是同一個裁法，出了問題對照
 * `engine.log` 時不用再心算兩種框。
 *
 * **兩邊要一起改。** 這裡動了引擎沒動，只是畫面跟引擎看的不一樣，不會壞；反過來
 * 引擎重校了這裡沒跟，畫面就會偷偷帶進一截名條。
 *
 * 會有這個檔案，是因為同一組四個小數已經被抄到第三個地方了（對局列表的手牌帶、
 * 換牌建議的卡列）。一個「必須和 Rust 那邊保持一致」的常數散成三份，是那種
 * 改對兩份、漏掉第三份，然後只有某一頁悄悄歪掉的錯——而且歪得很輕微，沒有人會
 * 因為它報 bug。
 */
export const ART_WINDOW = { left: 0.14, top: 0.218, right: 0.853, bottom: 0.837 } as const

/** 窗口佔整張卡的寬高比例。 */
export const ART_WINDOW_W = ART_WINDOW.right - ART_WINDOW.left
export const ART_WINDOW_H = ART_WINDOW.bottom - ART_WINDOW.top

/** 入口網站卡圖的原尺寸（和 `DeckCardBoard` 的 `CARD_RATIO` 同一組）；只拿來算比例。 */
export const CARD_W = 530
export const CARD_H = 687

/**
 * 窗口自己的長寬比（寬 ÷ 高），用來由高度算出格子該多寬。
 *
 * 約 0.889——接近正方形，這正是它比完整直式卡片省寬度的原因。
 */
export const ART_WINDOW_RATIO = (CARD_W * ART_WINDOW_W) / (CARD_H * ART_WINDOW_H)

/**
 * 把一張完整卡圖裁成只剩插畫窗的 CSS。
 *
 * 用絕對定位的 `<img>` 撐大再位移，而不是 `object-fit: cover` 加 `object-position`：
 * cover 能決定圖對齊在哪，**不能決定縮放多少**，所以切不出一個長寬比和外框不同的
 * 窗。回傳的尺寸全是百分比，因此官方哪天換了卡圖的像素大小也不用跟著改。
 *
 * 呼叫端負責外層那個 `overflow: hidden` 的框。
 */
export const artWindowImageSx = {
  position: 'absolute' as const,
  width: `${100 / ART_WINDOW_W}%`,
  height: `${100 / ART_WINDOW_H}%`,
  left: `${(-ART_WINDOW.left / ART_WINDOW_W) * 100}%`,
  top: `${(-ART_WINDOW.top / ART_WINDOW_H) * 100}%`,
  maxWidth: 'none',
  display: 'block'
}
