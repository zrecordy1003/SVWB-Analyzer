/**
 * 這一場打的四張起手，貼在對局列的右邊。
 *
 * 它是清單列上最不重要的東西：這張卡片的工作是讓人往下掃結果與對局組合，手牌
 * 只是「這一場是怎麼開的」的補充。所以它不放標題、不放數字，需要細節的人才把
 * 滑鼠移過去。完整的兩排八格版本（換前一排、換後一排、辨識狀態、補認說明）留在
 * 編輯抽屜的 `OpeningHand`，這裡不重做一份。
 *
 * 畫的是 **`post`**——真正打下去的那四張。換牌面板上被換掉的卡是**位移**到上排、
 * 欄位不變（見 `docs/opening-hand-plan.md` 的 Q2／Q3），所以 `pre[i]` 與 `post[i]`
 * 說的是同一個位置：`pre[i].swapped` 為真時，`post[i]` 是補進來的、`pre[i]` 是
 * 丟掉的。這個對應讓「看換之前的牌」可以做成**每一格自己的**動作——右上角一枚
 * 交換徽章，滑過那一格提示框就把換前、換後兩張並排給你看——而不是整手牌換前／
 * 換後的切換。切換版本試想過：多一顆要按的東西，而且一次翻四格，看不出是哪一格
 * 換了哪一張。
 *
 * 四個位置永遠都畫。`cardId` 為 null 的格子畫成同尺寸的空格而不是跳過：一手牌
 * 就是四張，少一張本身就是資訊（引擎讀到那一格有卡，只是候選集裡沒有相符的）。
 * 跳過的話三張並排會讀成「這場只抽了三張」。
 *
 * ## 畫的是插畫，不是整張卡，也不是橫幅
 *
 * 第一版用 `list` 橫幅縮到 60×34。橫幅是從卡片中段裁出來的寬條，在清單列那種
 * 尺寸下它就是一條顏色：認得這副牌的人看得出來，冷讀不出來，四格並排在每一列
 * 右邊變成一塊紋理。這一版改用 `card` 全圖，但**只畫插畫那一窗**——引擎認卡用
 * 的同一塊矩形（`ART_WINDOW`）。整張卡直接縮進 88px 高也考慮過：卡框、費用寶石
 * 和文字框佔掉四成的面積，在這個尺寸下全是看不清的雜訊，而人認卡靠的是臉，臉
 * 只剩五十幾 px 高。裁到插畫，同樣 88px 高全部是畫，臉大一半；而且窗口接近正
 * 方，每格比整張卡的直式比例還省寬。
 */
import { Box, Tooltip, Typography } from '@mui/material'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import { cardImageUrl, cardKindFromType } from '@shared/deckImport'
import type { OpeningHandSlot, OpeningHandView } from '@shared/ipc'
import React from 'react'

import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import { ART_WINDOW_RATIO, artWindowImageSx } from '@renderer/components/Common/cardArtWindow'
import { CardTooltipBody, type CardTooltipCard } from '@renderer/components/DeckCards/CardTooltip'

/**
 * 插畫窗與它的算式都在 `Common/cardArtWindow.ts`。
 *
 * 那幾個小數必須和 `tools/engine/src/fingerprint.rs` 的 `PORTAL_ART_FRACTION`
 * 保持一致，而它一度被抄到三個檔案裡——所以搬進共用檔，這裡只剩引用。
 */

/**
 * 一格的尺寸。
 *
 * **改這一個數字就好**，寬度和整條帶子的寬度都是從它算出來的。
 *
 * 64 而不是 88。112px 的列高扣掉上下留白最多能放到 88，第一版也真的放到 88 了，
 * 但排出來之後它變成整列對比最強、細節最多的東西——比 WIN/LOSS 和職業名還搶眼，
 * 而那兩者才是這個清單真正要被掃視的內容。手牌是脈絡，不是主角。
 *
 * 可讀性的功勞本來就不在尺寸，在裁切：換成插畫窗之後整格都是圖，臉在 64px 下
 * 一樣看得出來，而 88 多出來的那 24px 買到的是「更搶眼」，不是「更認得出」。
 *
 * 寬度跟著窗口比例走（64 × 0.889 ≈ 57），四格帶 4px 間距約 240px——和第一版
 * 縮圖的 252px 幾乎一樣，所以對手那一欄不用為了這次改動再讓出任何寬度。
 */
const SLOT_H = 64
const SLOT_W = Math.round(SLOT_H * ART_WINDOW_RATIO)
const SLOT_GAP = 4
const SLOTS = 4

/** 整條的寬度，給列的版面預留位置用；沒有手牌的列也佔這麼寬，其他欄位才不會左右跳。 */
export const OPENING_HAND_STRIP_WIDTH = SLOTS * SLOT_W + (SLOTS - 1) * SLOT_GAP

/**
 * 提示框裡並排的兩張卡（換前、換後）各自的尺寸。跟格子同一個裁法、放大到 2.25
 * 倍：兩張要讀成「同一種東西的前後兩張」，就得同尺寸、同裁法，只是大到看得清楚。
 *
 * 第一版提示框只放被換掉那一張，補進來的那張留在格子裡靠人自己對照——一張 144
 * 高、一張 64 高，隔著提示框的邊，讀的人要先記住格子裡是哪張再看提示框，「換了
 * 什麼」要拼兩次才成立。再早一版用的是編輯抽屜的 92×52 橫幅，跟格子裡的直式插
 * 畫是兩種裁法，擺在一起像兩張不同的圖。現在兩張都在提示框裡、都是這個尺寸。
 */
const REVEAL_H = 144
const REVEAL_W = Math.round(REVEAL_H * ART_WINDOW_RATIO)

/**
 * 兩張之間那支箭頭佔的寬。箭頭而不是「→ 換成」一類的字：字要讀，箭頭掃一眼就
 * 知道方向，而這裡整個提示框就只想說一件事——左邊那張走了，右邊那張來了。
 */
const ARROW_W = 28

/**
 * 每一側圖上方標籤列的固定高度（含它和圖之間的間距）。固定而不是讓字自然撐：
 * 箭頭要對齊**圖**的正中，而箭頭在自己的欄裡量不到旁邊標籤有多高，只能靠兩邊
 * 都用同一個數字。
 */
const LABEL_H = 22

/**
 * 圖（或那一對圖）和右邊卡片文字之間的間距。文字欄本身的寬度由 `CardTooltipBody`
 * 定（300px），這裡不再另外指定——牌組頁上的卡片文字就是這個寬，兩處要一樣。
 */
const TEXT_GAP = 12

/**
 * 提示框開啟前的延遲。MUI 預設 100ms；這裡拉到和 `CardTooltip` 一樣的量級。
 *
 * 第一版沒換的格子只跳一行字，掃過去跳一下無妨。現在每一格 hover 都是一塊帶
 * 卡圖和整段文字的面板，滑鼠只是經過這條帶子去點別的東西時，四塊面板連跳會
 * 讀成畫面在閃。三百毫秒是「停下來看」和「路過」的分界，同一顆滑鼠停在一格
 * 上超過這個時間，多半真的是要看。
 */
const ENTER_DELAY_MS = 300

/**
 * 交換徽章。第一版是 34px 高的格子上放 12px，會被畫吃掉。
 *
 * 16px 是「在插畫上看得到、又只蓋住一個角」的折衷——再大就開始遮臉，而角落正是
 * 這個窗口裡最不會有臉的地方。跟著 [[SLOT_H]] 走：格子如果改回 88，這裡要一起
 * 放大，否則徽章會相對縮成一個雜點。
 */
const BADGE_SIZE = 16
const BADGE_ICON = 11
const BADGE_INSET = 3

/**
 * 退到 `list` 橫幅時的裁切位置。橫幅插畫偏右（起手統計頁的 `BannerArt` 用的也是
 * 85%），置中裁會切到一半的臉。
 */
const BANNER_POSITION = '85% center'

/** 有卡就是卡名，沒認出來就說沒認出來；費用跟在後面，因為換牌要看的多半就是它。 */
const describe = (slot: OpeningHandSlot): string => {
  if (slot.cardId == null) return '沒有認出這一格的卡'
  const name = slot.name ?? `卡號 ${slot.cardId}`
  return slot.cost != null ? `${name}（${slot.cost} 費）` : name
}

/**
 * 把一格轉成 `CardTooltip` 讀的形狀。差別只有兩處：`type` 是入口網站的數字種類，
 * 在這裡換成字串；卡池沒有這張卡的名字時給卡號，因為那邊的 `name` 不可為空。
 * 其餘欄位（稀有度、攻防、文字）直接過。呼叫端要先確認 `cardId` 不是 null。
 */
const toTooltipCard = (slot: OpeningHandSlot): CardTooltipCard => ({
  name: slot.name ?? `卡號 ${slot.cardId}`,
  cost: slot.cost,
  kind: cardKindFromType(slot.type),
  rarity: slot.rarity,
  atk: slot.atk,
  life: slot.life,
  skillText: slot.skillText
})

/**
 * 一張卡的插畫，或它的替身。依序試三樣：
 *
 * 1. `card` 全圖裁到 `ART_WINDOW`。圖以絕對定位放進 `overflow: hidden` 的框裡，
 *    寬高是框的 `1 / 窗口比例` 倍、再往左上偏掉窗口前面那一截——四個數字全是百
 *    分比，所以不用知道圖的實際像素，入口網站換過圖的尺寸也一樣對。用
 *    `object-position` 也做得到，但 `cover` 只能挑「圖的哪一段對齊框」，挑不了
 *    「圖放大幾倍」，裁不出比例不同於框的一窗。
 * 2. `list` 橫幅 `cover`。`imageHash` 是 null 表示卡池從來沒抓過這張卡的全圖，
 *    但橫幅可能有（舊版卡池只抓橫幅）：裁得差的圖還是比沒有圖好。
 * 3. 卡名文字。兩張圖都沒有或都載不到（快取被清、離線）。
 *
 * 完全沒有卡就留空底。不用 `Skeleton`：那會讀成「還在載入」，而這裡沒有在載入。
 */
const Art: React.FC<{ slot: OpeningHandSlot; width: number; height: number }> = ({
  slot,
  width,
  height
}) => {
  const sources = React.useMemo(
    () =>
      [
        { kind: 'art' as const, src: cardImageUrl('card', slot.imageHash) },
        { kind: 'banner' as const, src: cardImageUrl('list', slot.bannerHash) }
      ].filter((s): s is { kind: 'art' | 'banner'; src: string } => s.src != null),
    [slot.imageHash, slot.bannerHash]
  )
  const [attempt, setAttempt] = React.useState(0)
  // 同一格在補認之後會換成另一張卡；從第一個來源重試，別把上一張的失敗帶過去。
  React.useEffect(() => setAttempt(0), [sources])

  const current = sources[attempt]
  if (current) {
    const frame = { width, height, position: 'relative' as const, overflow: 'hidden' }
    if (current.kind === 'art') {
      return (
        <Box sx={frame}>
          <Box
            component="img"
            src={current.src}
            alt=""
            loading="lazy"
            onError={() => setAttempt((n) => n + 1)}
            sx={artWindowImageSx}
          />
        </Box>
      )
    }
    return (
      <Box
        component="img"
        src={current.src}
        alt=""
        loading="lazy"
        onError={() => setAttempt((n) => n + 1)}
        sx={{ ...frame, objectFit: 'cover', objectPosition: BANNER_POSITION, display: 'block' }}
      />
    )
  }
  if (slot.cardId == null) return null
  return (
    <Typography
      variant="caption"
      sx={{
        px: 0.5,
        width,
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        fontSize: 11,
        lineHeight: 1.25,
        color: 'text.secondary',
        overflow: 'hidden'
      }}
    >
      {slot.name ?? slot.cardId}
    </Typography>
  )
}

/**
 * 提示框裡並排比較的其中一側：標籤、圖、卡名。
 *
 * 兩側的差別靠**畫法**而不只靠標籤：被換掉的那張整格去色、壓暗，補進來的那張
 * 原色、框亮一階。把標籤遮起來也要分得出哪張是走掉的——去色是「已經不在了」
 * 最通用的講法（停用的按鈕、下架的商品都是這麼畫）。試想過的另兩種都不要：
 * 紅／綠框，因為換牌不是對錯、而且色弱的人看不出差；斜線劃掉，因為線會蓋到臉，
 * 而人認卡靠的就是臉。
 *
 * `slot` 為 null（那一側沒認出來）時畫同尺寸的虛線空框、底下寫沒認出來：兩側
 * 一樣大，這一對才還是一對。不把空框縮掉或跳過——那會讓「換前 → 換後」剩一半，
 * 讀成沒有換。
 */
const ComparedCard: React.FC<{
  slot: OpeningHandSlot | null
  label: string
  discarded: boolean
}> = ({ slot, label, discarded }) => {
  const known = slot?.cardId != null
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: REVEAL_W }}>
      <Typography
        variant="caption"
        sx={{
          height: LABEL_H,
          display: 'flex',
          alignItems: 'flex-start',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: discarded ? 'text.disabled' : 'text.secondary'
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          width: REVEAL_W,
          height: REVEAL_H,
          borderRadius: 1,
          overflow: 'hidden',
          border: '1px solid',
          borderStyle: known ? 'solid' : 'dashed',
          borderColor: discarded ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.28)',
          bgcolor: known ? 'action.hover' : 'transparent',
          flexShrink: 0,
          // 去色加壓暗放在框上而不是圖上：橫幅與文字替身也一起變灰，退到哪一層都
          // 還是「走掉的那張」。
          filter: discarded ? 'grayscale(1) brightness(0.62)' : 'none'
        }}
      >
        {slot && <Art slot={slot} width={REVEAL_W} height={REVEAL_H} />}
      </Box>
      <Typography
        variant="caption"
        sx={{
          mt: 0.5,
          width: REVEAL_W,
          textAlign: 'center',
          lineHeight: 1.3,
          color: discarded ? 'text.secondary' : 'text.primary',
          // 卡名可以換行，但不能把整欄撐寬——欄寬是圖的寬，兩側才會對齊。
          overflowWrap: 'anywhere'
        }}
      >
        {slot ? describe(slot) : '沒有認出這一格的卡'}
      </Typography>
    </Box>
  )
}

/**
 * 提示框裡右側那欄：打下去那張卡的完整資訊。
 *
 * 直接用牌組頁 `CardTooltip` 的本體，不在這裡再排一份。「完整的卡片資訊」在這個
 * app 裡已經有一種寫法——關鍵字上色、進化／超進化掛標、模式選項縮排，全由
 * `shared/cardText.ts` 解析、有測試——手牌這邊自己排一塊，就是同一張卡在兩頁有
 * 兩種長相，而且改了那邊這邊不會跟。
 *
 * 用它的本體而不是整個 `CardTooltip` 包住格子：那個包法的提示框裡只有文字，沒地
 * 方放放大的卡圖，也放不進換前／換後那一對。這裡要的是「圖在左、字在右」。
 */
const PlayedText: React.FC<{ slot: OpeningHandSlot }> = ({ slot }) => (
  <Box sx={{ ml: `${TEXT_GAP}px`, flexShrink: 0 }}>
    <CardTooltipBody card={toTooltipCard(slot)} />
  </Box>
)

/**
 * 提示框。三種格子三種內容：
 *
 * - **沒認出來**（`played` 與 `discarded` 都沒有卡）：一行字。沒有卡就沒東西可畫。
 * - **沒換**：左邊放大的插畫、右邊這張卡的完整資訊（費用、名字、攻防、種類、
 *   稀有度、整段卡片文字）。第一版這裡只有一行「名字（N 費）」，理由是多數格子
 *   都沒換、不該每次 hover 都跳一塊；使用者要的是相反——每一格滑過去都看得到
 *   卡。所以現在沒換的格子和換過的格子是同一種面板，只是少了比較的那一半。
 * - **換過**：左邊換前（丟掉的 `pre[i]`）、箭頭、換後（打的 `post[i]`），兩張同尺寸
 *   同裁法並排；再往右是**換後那張**的完整資訊。左到右是閱讀方向，也是真的先後：
 *   面板上是先把留下的往上挪、再補進新的一張。
 *
 * 換過的格子**只給打下去那張**的完整文字，丟掉那張維持圖＋名字＋費用。兩張都
 * 給全文試排過：兩欄各 300px 的文字並排，面板將近 900px 寬、高度跟著最長的那
 * 段走，一個 64px 的格子 hover 出一整面牆，而且兩段文字視線得來回跳才知道哪段
 * 講哪張。把兩段文字改放在各自的圖底下也想過：面板變成兩欄高塔，箭頭對齊的
 * 是圖、文字卻在圖下面延伸，「換了什麼」那一眼還是要先讀完兩段。丟掉的那張是
 * 已經不在手上的卡，這一場的走法跟它的文字無關；它在這裡的工作是「你原本抓到
 * 什麼」，圖和費用就答完了。要看它的全文，牌組頁一直都在。
 */
const SlotTip: React.FC<{ played: OpeningHandSlot | null; discarded: OpeningHandSlot | null }> = ({
  played,
  discarded
}) => {
  const playedKnown = played?.cardId != null
  if (!discarded) {
    if (!played || !playedKnown) {
      return <Typography variant="caption">沒有認出這一格的卡</Typography>
    }
    return (
      <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
        <Box
          sx={{
            width: REVEAL_W,
            height: REVEAL_H,
            borderRadius: 1,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.28)',
            bgcolor: 'action.hover',
            flexShrink: 0
          }}
        >
          <Art slot={played} width={REVEAL_W} height={REVEAL_H} />
        </Box>
        <PlayedText slot={played} />
      </Box>
    )
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
      <ComparedCard slot={discarded} label="換前" discarded />
      <Box
        aria-hidden
        sx={{
          width: ARROW_W,
          // 對齊圖的正中，不是整欄的正中：卡名的高度會隨字數變，圖不會。
          height: REVEAL_H,
          mt: `${LABEL_H}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
          flexShrink: 0
        }}
      >
        <ArrowForwardRoundedIcon sx={{ fontSize: 20 }} />
      </Box>
      <ComparedCard slot={played} label="換後" discarded={false} />
      {/* 換後那張沒認出來就沒有文字可放；左邊那對虛線空框已經把「不知道換成什麼」說完了。 */}
      {played && playedKnown && <PlayedText slot={played} />}
    </Box>
  )
}

/**
 * 一個位置。整格都是 hover 目標而不只是徽章：徽章只有 16px，要人準確滑到上面
 * 才肯說話太苛刻，而這一格本來就要在 hover 時把整張卡攤開，兩件事併成同一個
 * 目標。`tabIndex` 讓鍵盤也走得到（MUI 的 Tooltip 對 focus 也會開）。
 *
 * 提示框沿用清單其他 tooltip 的底（`TOOLTIP_SURFACE_SX`），不借 `CardTooltip` 那塊
 * 更深的：同一列裡 WIN/LOSS、牌組名的 hover 都是這種材質，手牌的面板長得不一
 * 樣會像是別頁的東西飄過來。卡片文字的色調本來就是設計成在任何深底上讀的。
 */
const Slot: React.FC<{ played: OpeningHandSlot | null; discarded: OpeningHandSlot | null }> = ({
  played,
  discarded
}) => {
  const known = played?.cardId != null
  const swapped = discarded != null
  return (
    <Tooltip
      title={<SlotTip played={played} discarded={discarded} />}
      placement="top"
      enterDelay={ENTER_DELAY_MS}
      slotProps={{ tooltip: { sx: { ...TOOLTIP_SURFACE_SX, py: 1.25 } } }}
    >
      <Box
        tabIndex={0}
        aria-label={
          swapped
            ? `${played ? describe(played) : '未辨識'}，換掉了 ${describe(discarded)}`
            : played
              ? describe(played)
              : '未辨識'
        }
        sx={{
          position: 'relative',
          width: SLOT_W,
          height: SLOT_H,
          borderRadius: 1,
          overflow: 'hidden',
          border: '1px solid',
          // 認不出來的格子連框都淡一階：它是「有卡但不知道是哪張」，不該和有卡圖的格子一樣重。
          borderColor: known ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
          bgcolor: known ? 'action.hover' : 'transparent',
          outlineOffset: 1,
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' }
        }}
      >
        {played && <Art slot={played} width={SLOT_W} height={SLOT_H} />}
        {swapped && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              top: BADGE_INSET,
              right: BADGE_INSET,
              width: BADGE_SIZE,
              height: BADGE_SIZE,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // 深底白圖示，落在任何卡圖上都看得到；不用主題色，因為它不是可按的東西。
              // 加一圈細白邊：格子大了之後插畫的暗部也多了，純深底圓點會沉進去。
              bgcolor: 'rgba(0,0,0,0.72)',
              boxShadow: '0 0 0 1px rgba(255,255,255,0.35)',
              color: 'common.white'
            }}
          >
            <AutorenewIcon sx={{ fontSize: BADGE_ICON }} />
          </Box>
        )}
      </Box>
    </Tooltip>
  )
}

export type OpeningHandStripProps = {
  /** 沒有手牌的列傳 undefined；這時整條是空的但寬度照留。 */
  hand: OpeningHandView | undefined
}

const OpeningHandStrip: React.FC<OpeningHandStripProps> = ({ hand }) => {
  // 用 `slot` 欄位對位而不是陣列索引：資料庫給的是 (stage, slot) 一列一張，順序
  // 不該假設，缺一列也不該讓後面的格子往前擠。
  const positions = React.useMemo(() => {
    if (!hand) return null
    return Array.from({ length: SLOTS }, (_, i) => {
      const pre = hand.pre.find((s) => s.slot === i) ?? null
      const post = hand.post.find((s) => s.slot === i) ?? null
      const swapped = pre?.swapped === true
      // 沒有換的格子若 post 那一列沒讀到，打下去的就是原本那張，直接用 pre 補；
      // 換過的格子不能這樣補——那會把丟掉的卡畫成打的卡。
      const played = post ?? (pre && !swapped ? pre : null)
      return { played, discarded: swapped ? pre : null }
    })
  }, [hand])

  return (
    <Box
      aria-hidden={!positions}
      sx={{
        width: OPENING_HAND_STRIP_WIDTH,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: `${SLOT_GAP}px`,
        // 手牌是整列裡最先讓位的東西。分析頁在 720px 收起次要欄位；這一條在
        // 252px 寬的時候 960px 以下就已經把對手那一側擠到只剩截斷的職業名，現在
        // 寬了 72px，斷點跟著往右移同樣的量，收起來時對手側剩的空間才跟以前一樣。
        // 帶子縮回 240px 之後，讓位的門檻也跟著回到原本那個：它佔的寬度和
        // 第一版縮圖差不多，就不該比第一版更早把對手那一欄擠掉。
        '@media (max-width: 960px)': { display: 'none' }
      }}
    >
      {positions?.map((p, i) => (
        <Slot key={i} played={p.played} discarded={p.discarded} />
      ))}
    </Box>
  )
}

export default React.memo(OpeningHandStrip)
