/**
 * One deck, as a row.
 *
 * The tile view is for recognising a deck; this one is for comparing decks.
 * Everything that varies between decks therefore lands in a fixed column at a
 * fixed x - the identity block, the art, the play-order split, the record - so
 * the eye can run down a column instead of re-reading each deck's layout.
 *
 * 一列分成四段，由左而右從「這是哪一副牌」走到「它打得怎麼樣」：
 *
 * 1. 身分：職業徽記加牌名，底下一行卡表組成。職業只留徽記 - 徽記自己就有顏色
 *    和形狀，再補一個職業名或一條色帶都只是把同一件事講第三次。
 * 2. 卡圖：和卡牌模式同一張圖，貼在組成那行的右邊。它是這一列唯一認得出「喔是
 *    那副」的東西，但只給它一小塊，不讓它接手整列。
 * 3. 先後攻：兩條共用刻度的長條。這是列表才做得到的事 - 磚塊上塞不下，而先後攻
 *    的差距往往比總勝率更能決定一副牌好不好用。
 * 4. 戰績：幾勝幾敗、幾場，以及總勝率那條長條，位置和磚塊上一樣在最後。
 */
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import { cardImageUrl } from '@shared/deckImport'
import React from 'react'

import ClassIcon from '@renderer/components/Common/ClassIcon'
import { classTone } from '@renderer/components/Common/classTone'
import { rateColor } from '@renderer/components/Analyzer/matchupRows'
import { playOrders } from '@renderer/map/playOrder'
import type { DeckTileData } from './DeckTile'

/** 一半的成績：先攻或後攻。 */
export type SplitRecord = { total: number; wins: number }

export type DeckRowData = DeckTileData & {
  first: SplitRecord
  second: SplitRecord
  /**
   * 版本（docs/deck-versioning-plan.md）。一列是一個家族：`id` 是當前版本，
   * `familyId` 認家族，`versionCount` 是它一路以來有幾個版本，
   * `currentVersion` 是當前版本的序號（以 id 排序推導，不存欄位）。
   */
  familyId: number
  versionCount: number
  currentVersion: number
}

/**
 * 卡圖那一欄的寬度，以及它兩側的淡出。
 *
 * 圖是滿版高度的一條，寬度寫死才有一條可以往下掃的邊；讓它照原圖比例展開會是
 * 五比一的一長條，整列就變成它的背景了。
 *
 * 遮罩是四段而不是兩段，而且刻意不對稱。單一段線性淡出從頭到尾的變化率都一樣，
 * 眼睛會在梯度開始的那一點看到一條邊 - 「遮得很突兀」講的就是那條邊。中間多插
 * 兩個停點把梯度前段壓平（0.15、0.55），淡出才會像光線收掉而不是像一塊有邊界的
 * 貼紙。左側鋪得比右側長：左邊要走進一整段文字裡，右邊只要離開先後攻那兩條就好。
 * 相對地，圖也開得比原本寬 - 淡出吃掉的部分不能是臉。
 */
const ART_WIDTH = 140
const ART_EDGE_FADE = [
  'linear-gradient(90deg',
  'rgba(0,0,0,0) 0%',
  'rgba(0,0,0,0.15) 10%',
  'rgba(0,0,0,0.55) 26%',
  'rgba(0,0,0,1) 45%',
  'rgba(0,0,0,1) 80%',
  'rgba(0,0,0,0.55) 92%',
  'rgba(0,0,0,0) 100%)'
].join(', ')

/** 一列的上下內距。卡圖用負的同一個值把它吃掉，兩邊必須是同一個數字。 */
const ROW_PADDING_Y = 1.25

/**
 * 卡圖、先後攻、戰績三段都是固定寬度，身分那段吃掉剩下的空間 - 反過來（身分
 * 固定、其餘彈性）會讓同一種數字在不同視窗寬度下落在不同位置，那正是列表要
 * 解決的問題。
 */
const PLAY_ORDER_WIDTH = 156
const RECORD_COLUMN_WIDTH = 132
/** 勝率：數字加一條共用刻度的長條，兩者一起才看得出「多好」而不只是「幾趴」。 */
const RATE_COLUMN_WIDTH = 168

/** 先攻用 primary、後攻用 secondary - 和分析器長條圖同一組顏色，兩張圖看的是同一件事。 */
const PLAY_ORDER_BAR_COLOR: Record<'first' | 'second', string> = {
  first: 'primary.main',
  second: 'secondary.main'
}

/**
 * 先攻或後攻的一條，樣式對齊分析器的對局長條圖（見 `Analyzer/component/MatchupBars.tsx`
 * 的 `SideBar`）：標籤是中性色，長條和數字才帶出「這一邊打得怎麼樣」- 長條用
 * 先／後攻各自的主題色分邊，數字則照離 50% 的距離上色，兩張圖用同一套規則。
 * 軌道中間那條 50% 虛線也是同一個錨點：只看長度分不出優勢還是劣勢。
 * 沒打過的那一邊畫成空槽加一個破折號：那不是 0%。
 */
function PlayOrderBar({
  order,
  record
}: {
  order: 'first' | 'second'
  record: SplitRecord
}): React.JSX.Element {
  const tone = playOrders[order]
  const played = record.total > 0
  const rate = played ? (record.wins / record.total) * 100 : null

  return (
    <Tooltip
      title={
        played
          ? `${tone.label} ${record.wins}勝 ${record.total - record.wins}敗（${record.total} 場）`
          : `${tone.label}還沒有對局紀錄`
      }
      placement="top"
      disableInteractive
    >
      <Stack direction="row" alignItems="center" spacing={0.75}>
        <Typography
          component="span"
          sx={{
            fontSize: 11,
            fontWeight: 700,
            color: 'text.secondary',
            width: 28,
            flexShrink: 0,
            whiteSpace: 'nowrap'
          }}
        >
          {tone.label}
        </Typography>
        <Box
          sx={{
            position: 'relative',
            flex: 1,
            height: 6,
            borderRadius: 3,
            bgcolor: 'rgba(255,255,255,0.05)',
            overflow: 'hidden'
          }}
        >
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              top: -1,
              bottom: -1,
              left: '50%',
              borderLeft: '1px dashed',
              borderColor: 'rgba(255,255,255,0.3)'
            }}
          />
          {played && (
            <Box
              sx={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: `max(2px, ${Math.min(100, rate as number)}%)`,
                borderRadius: 3,
                bgcolor: PLAY_ORDER_BAR_COLOR[order],
                opacity: 0.85
              }}
            />
          )}
        </Box>
        <Typography
          component="span"
          sx={{
            width: 36,
            flexShrink: 0,
            textAlign: 'right',
            fontSize: 11,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: played ? (rateColor(rate) ?? 'text.secondary') : 'text.disabled'
          }}
        >
          {played ? `${(rate as number).toFixed(0)}%` : '—'}
        </Typography>
      </Stack>
    </Tooltip>
  )
}

export default function DeckRow({
  deck,
  onClick,
  expanded = false,
  onToggleExpand
}: {
  deck: DeckRowData
  onClick: () => void
  /** 版本區展開中。只有列表模式會傳；沒有 `onToggleExpand` 就不畫箭頭。 */
  expanded?: boolean
  onToggleExpand?: () => void
}): React.JSX.Element {
  const tone = classTone(deck.classId)
  const art = cardImageUrl('list', deck.heroBannerHash)
  const played = deck.total > 0
  const [artFailed, setArtFailed] = React.useState(false)

  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      data-testid={`deck-row-${deck.familyId}`}
      data-archived={deck.archived ? 'true' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        // 兩行的身分區與一小塊卡圖決定了列高；比原本高，因為現在一列裝的是
        // 兩層資訊，擠在 44px 裡會讓組成那行貼著牌名。
        minHeight: 76,
        py: ROW_PADDING_Y,
        cursor: 'pointer',
        // 滿版的卡圖靠負外距貼到邊，超出去的部分（圓角、遮罩邊緣）由這裡收掉。
        overflow: 'hidden',
        borderBottom: expanded ? 'none' : '1px solid',
        borderColor: 'divider',
        transition: 'background-color .14s',
        // 封存的牌組灰階：還在清單裡（戰績要看得到），但已經不是一副在打的牌。
        opacity: deck.archived ? 0.6 : 1,
        filter: deck.archived ? 'grayscale(0.7)' : 'none',
        '&:hover': { bgcolor: 'action.hover' },
        '&:last-of-type': { borderBottom: 'none' }
      }}
    >
      {/* 展開版本歷史。stopPropagation：整列點下去是看卡表，這顆只翻開下面那塊。 */}
      {onToggleExpand && (
        <Tooltip title={expanded ? '收起版本' : `看版本（共 ${deck.versionCount} 個）`}>
          <IconButton
            size="small"
            aria-label={expanded ? '收起版本' : '展開版本'}
            aria-expanded={expanded}
            data-testid={`deck-row-expand-${deck.familyId}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleExpand()
            }}
            sx={{
              ml: -1,
              color: 'text.secondary',
              transition: 'transform .18s',
              transform: expanded ? 'rotate(180deg)' : 'none'
            }}
          >
            <ExpandMoreRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      <ClassIcon id={deck.classId} size={26} tone={tone} />

      <Box sx={{ flex: 1, minWidth: 140 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography fontWeight={700} noWrap title={deck.name} sx={{ minWidth: 0 }}>
            {deck.name}
          </Typography>
          {/* 只有 fork 過的牌組才掛版本號：一副只有 v1 的牌，「v1」沒有講出任何事。 */}
          {deck.versionCount > 1 && (
            <Tooltip title={`共 ${deck.versionCount} 個版本，目前是 v${deck.currentVersion}`}>
              <Chip
                size="small"
                label={`v${deck.currentVersion}`}
                data-testid="deck-row-version-badge"
                sx={{
                  height: 20,
                  fontSize: 11,
                  fontWeight: 800,
                  flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums',
                  bgcolor: 'rgba(122,162,247,0.16)'
                }}
              />
            </Tooltip>
          )}
          {deck.archived && (
            <Chip
              size="small"
              variant="outlined"
              label="已刪除"
              data-testid="deck-archived-badge"
              sx={{ height: 20, fontSize: 11, flexShrink: 0, color: 'text.secondary' }}
            />
          )}
          {deck.categoryName && (
            <Chip
              size="small"
              label={deck.categoryName}
              sx={{
                height: 20,
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
                bgcolor: 'rgba(255,255,255,0.08)'
              }}
            />
          )}
        </Stack>

        {/* 沒有卡表就整行不畫，不要用三個 0 假裝知道。 */}
        {deck.composition && (
          <Stack direction="row" spacing={1} sx={{ mt: 0.25 }}>
            {(
              [
                ['從者', deck.composition.follower],
                ['法術', deck.composition.spell],
                ['護符', deck.composition.amulet]
              ] as const
            ).map(([label, n]) => (
              <Typography
                key={label}
                variant="caption"
                sx={{
                  color: 'text.secondary',
                  fontVariantNumeric: 'tabular-nums',
                  opacity: n === 0 ? 0.45 : 1
                }}
              >
                {label}
                <Box component="span" sx={{ fontWeight: 800, ml: 0.4 }}>
                  {n}
                </Box>
              </Typography>
            ))}
          </Stack>
        )}
      </Box>

      {/* 卡圖，滿版貼齊這一列的上下邊：`alignSelf: stretch` 撐高，負的上下外距
          再把這一列的內距吃掉，所以圖的高度就是列高，不是列高減去 20px。滿版就
          不留圓角 - 貼著上下邊的圓角只會在分隔線旁邊留下兩個缺口。
          沒有圖就整塊不畫；右邊那幾欄是固定寬度且排在最後，少了這一塊不會跟著
          位移，只有牌名那段變寬。窄視窗先犧牲它 - 它最好認，也最不影響判斷。 */}
      {art && !artFailed && (
        <Box
          component="img"
          src={art}
          alt=""
          loading="lazy"
          onError={() => setArtFailed(true)}
          sx={{
            alignSelf: 'stretch',
            width: ART_WIDTH,
            height: 'auto',
            my: -ROW_PADDING_Y,
            flexShrink: 0,
            objectFit: 'cover',
            // 這種橫幅是 800x160、給遊戲拿來墊卡名用的：左半邊刻意淡成一片空白，
            // 角色壓在右邊。預設的置中裁切因此正好切在那片空白上——看起來像圖沒
            // 載到。往右取才會切到臉；留 15% 不取滿，人物右側的背景要留一點，
            // 貼著邊的臉比空白更難看。
            objectPosition: '85% center',
            // 兩側淡出，讓這塊圖融進列裡而不是擺一個硬邊的方塊在中間。梯度的
            // 形狀見 `ART_EDGE_FADE`。
            maskImage: ART_EDGE_FADE,
            WebkitMaskImage: ART_EDGE_FADE,
            display: { xs: 'none', md: 'block' }
          }}
        />
      )}

      {played ? (
        <>
          <Stack spacing={0.5} sx={{ width: PLAY_ORDER_WIDTH, flexShrink: 0 }}>
            <PlayOrderBar order="first" record={deck.first} />
            <PlayOrderBar order="second" record={deck.second} />
          </Stack>

          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{
              width: RECORD_COLUMN_WIDTH,
              flexShrink: 0,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {`${deck.wins}勝 ${deck.total - deck.wins}敗 ・ ${deck.total} 場`}
          </Typography>

          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ width: RATE_COLUMN_WIDTH, flexShrink: 0 }}
          >
            <Typography
              sx={{
                width: 56,
                textAlign: 'right',
                fontSize: 15,
                fontWeight: 900,
                fontVariantNumeric: 'tabular-nums',
                color: deck.winRate >= 50 ? 'success.light' : 'error.light'
              }}
            >
              {`${deck.winRate.toFixed(1)}%`}
            </Typography>
            <Box
              sx={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                bgcolor: 'rgba(255,255,255,0.09)',
                overflow: 'hidden'
              }}
            >
              <Box
                sx={{
                  width: `${Math.min(100, deck.winRate)}%`,
                  height: '100%',
                  bgcolor: deck.winRate >= 50 ? 'success.main' : 'error.main'
                }}
              />
            </Box>
          </Stack>
        </>
      ) : (
        // 沒打過的牌沒有先後攻可比、沒有勝率可畫 - 空長條和一排破折號只是把「沒有
        // 資料」拆成三次講。這裡合成一句提示，同時占掉三段原本的寬度，右側欄位
        // 才不會因為這一列變短而跟著移位。沒有數據本身就是這一列唯一的重點，
        // 所以放大、置中，而不是縮在原本靠右對齊的小字裡。
        <Typography
          noWrap
          sx={{
            width: PLAY_ORDER_WIDTH + RECORD_COLUMN_WIDTH + RATE_COLUMN_WIDTH,
            flexShrink: 0,
            textAlign: 'center',
            fontSize: 15,
            fontWeight: 700,
            color: 'text.disabled'
          }}
        >
          還沒有對局紀錄
        </Typography>
      )}
    </Box>
  )
}
