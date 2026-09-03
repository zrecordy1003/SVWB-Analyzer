/**
 * 「新增牌組」這件事的全部：先問「匯入還是自己建」，然後進建構器。
 *
 * # 為什麼這是一個元件
 *
 * 牌組戰績和牌組管理各自把這條路接了一遍，而兩份接線並不一樣：匯入落地之後，
 * 牌組戰績把那副牌交給建構器，牌組管理只是把清單捲到那張卡上就結束了。同一顆
 * 「新增牌組」在兩頁做兩件事，而那個差異沒有任何理由——只是兩個 call site 沒有
 * 一起被維護。把路本身收成一個元件，兩頁就不可能再走偏。
 *
 * 匯入之後直接進建構器，是因為匯進來的牌是「別人的牌」：名字是自動編的、分類
 * 是空的、卡表也還沒看過。建構器就是這三件事都在同一個畫面上的地方。
 *
 * # 為什麼對局表單的牌組欄不用這個元件
 *
 * 那裡按「新增」的人正在填一張表單，匯進來的牌要回到欄位裡被選起來，而不是把
 * 一個全螢幕的建構器蓋到他填到一半的表單上。那是不同的終點，不是同一條路的
 * 參數，所以 `DeckPicker` 留著它自己的接線（旁邊寫著這個理由）。
 */
import React from 'react'

import DeckBuilder from './DeckBuilder'
import NewDeckDrawer from './NewDeckDrawer'
import type { ClassName } from '@shared/domain'

/**
 * 建構器要疊在問路的抽屜之上。
 *
 * 呼叫端給的是這條路的底層；抽屜坐在那裡，建構器再高一階。兩個數字由這裡決定
 * 而不是由呼叫端各給一個，理由和整個元件存在的理由一樣。
 */
const BUILDER_OFFSET = 10

export default function AddDeckFlow({
  open,
  onClose,
  categories,
  klass,
  zIndex,
  onSaved
}: {
  open: boolean
  /** 使用者關掉了「匯入還是自己建」那道門。建構器關掉不會呼叫這個。 */
  onClose: () => void
  categories: { id: string; name: string }[]
  /**
   * 從某個職業的脈絡進來時的預設職業。牌組戰績看「全部職業」時沒有答案，就不傳，
   * 讓建構器自己的下拉去問。
   */
  klass?: ClassName
  /** 疊在已經浮著的東西上面時的底層，例如從牌組管理那個 1500 的抽屜裡開。 */
  zIndex?: number
  /**
   * 這副牌落地了：匯入寫進資料庫的那一刻，以及之後每一次建構器存檔。
   *
   * 帶著 deckId，呼叫端要的話可以把畫面帶到它身上；只想重讀清單的呼叫端忽略
   * 這個參數就好。
   */
  onSaved: (deckId: number) => void
}): React.JSX.Element {
  /** 建構器要開在哪一副牌上；`deckId: null` 是「自己建一副新的」。 */
  const [building, setBuilding] = React.useState<{ deckId: number | null } | null>(null)

  return (
    <>
      <NewDeckDrawer
        open={open}
        klass={klass}
        zIndex={zIndex}
        onClose={onClose}
        // 這道門會自己關上再呼叫這兩個，所以這裡不必再 `onClose()`。
        onOpenDeck={(deckId) => {
          // 牌已經在資料庫裡了——先讓呼叫端的清單看得到它，使用者關掉建構器時
          // 背後才不是一份還沒有這副牌的清單。
          onSaved(deckId)
          setBuilding({ deckId })
        }}
        onBuildManually={() => setBuilding({ deckId: null })}
      />

      {/* 用到才掛：建構器有一個不看 `open` 的 `cards:poolBootstrap` 訂閱，會在
          卡池補完的過程中重讀卡池。常駐掛著就等於每次進度事件多一次白做的查詢。 */}
      {building !== null && (
        <DeckBuilder
          open
          deckId={building.deckId}
          categories={categories}
          initialClass={klass}
          zIndex={zIndex === undefined ? undefined : zIndex + BUILDER_OFFSET}
          onClose={() => setBuilding(null)}
          onSaved={(saved) => onSaved(saved.id)}
        />
      )}
    </>
  )
}
