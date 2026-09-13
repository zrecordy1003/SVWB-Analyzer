/**
 * 這一場的起手手牌：換前四張、換後四張。
 *
 * 這個區塊存在的理由是「辨識到底有沒有成功」在資料庫裡看得出來、在畫面上卻看不
 * 出來。所以它刻意把三種結果分開講，因為它們要採取的行動完全不同：
 *
 *   面板沒讀到      整場沒有任何列 → 引擎沒看到換牌畫面（或這是舊紀錄）
 *   讀到但認不出來  有列、`cardId` 是 null → 候選集裡沒有這張卡
 *   認出來了        有卡名與卡圖
 *
 * 「認不出來」多半不是 bug，而是**卡圖還沒建好索引**：候選集是你這個職業的整個卡池，
 * 而卡圖要一張一張從官方抓下來（一個職業約 175 張）。剛開始打某個職業的頭幾分鐘會是
 * 這個狀態，之後就不會了——區塊底下那行字就是在講這件事。
 */
import { Box, Chip, Skeleton, Stack, Tooltip, Typography } from '@mui/material'
import AutorenewIcon from '@mui/icons-material/Autorenew'
import { cardImageUrl } from '@shared/deckImport'
import type { OpeningHandSlot, OpeningHandView } from '@shared/ipc'
import React from 'react'

import { invokeIpc } from '@renderer/ipc'

const CARD_W = 92
const CARD_H = 52

/** 一格：有卡圖就貼卡圖，只有卡號就寫卡號，什麼都沒有就留白。 */
const Slot: React.FC<{ slot: OpeningHandSlot; dimmed?: boolean }> = ({ slot, dimmed }) => {
  const src = cardImageUrl('list', slot.bannerHash)
  const [failed, setFailed] = React.useState(false)

  const label = slot.name ?? (slot.cardId != null ? `卡號 ${slot.cardId}` : '未辨識')
  const known = slot.cardId != null

  return (
    <Tooltip
      title={
        known
          ? `${label}${slot.cost != null ? `（${slot.cost} 費）` : ''}`
          : '這一格有卡片，但候選集裡沒有相符的卡'
      }
    >
      <Box
        sx={{
          position: 'relative',
          width: CARD_W,
          height: CARD_H,
          borderRadius: 1,
          overflow: 'hidden',
          border: '1px solid',
          borderColor: known ? 'divider' : 'action.disabledBackground',
          bgcolor: 'action.hover',
          opacity: dimmed ? 0.55 : 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {src && !failed ? (
          <Box
            component="img"
            src={src}
            alt={label}
            loading="lazy"
            onError={() => setFailed(true)}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <Typography
            variant="caption"
            sx={{
              px: 0.5,
              textAlign: 'center',
              lineHeight: 1.2,
              color: known ? 'text.secondary' : 'text.disabled'
            }}
          >
            {label}
          </Typography>
        )}

        {slot.swapped === true && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'rgba(0,0,0,0.45)'
            }}
          >
            <AutorenewIcon fontSize="small" sx={{ color: 'common.white' }} />
          </Box>
        )}
      </Box>
    </Tooltip>
  )
}

const Row: React.FC<{ title: string; note?: string; slots: OpeningHandSlot[] }> = ({
  title,
  note,
  slots
}) => (
  <Stack spacing={0.5}>
    <Stack direction="row" spacing={1} alignItems="baseline">
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      {note && (
        <Typography variant="caption" color="text.disabled">
          {note}
        </Typography>
      )}
    </Stack>
    <Stack direction="row" spacing={0.75}>
      {slots.map((slot) => (
        <Slot key={slot.slot} slot={slot} dimmed={slot.swapped === true} />
      ))}
    </Stack>
  </Stack>
)

export type OpeningHandProps = { matchId?: number | null }

const OpeningHand: React.FC<OpeningHandProps> = ({ matchId }) => {
  const [hand, setHand] = React.useState<OpeningHandView | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (matchId == null) {
      setHand(null)
      return
    }
    setLoading(true)
    setHand(null)
    invokeIpc('matches:openingHand', matchId)
      .then(setHand)
      .finally(() => setLoading(false))
  }, [matchId])

  if (matchId == null) return null
  if (loading) return <Skeleton variant="rounded" height={CARD_H * 2 + 44} />

  // 沒有任何列 = 引擎沒讀到那個畫面。和「讀到但認不出來」是兩件事，不能混在一起
  // 講：前者要看的是辨識有沒有在跑，後者要看的是牌組有沒有匯入。
  if (!hand) {
    return (
      <Typography variant="caption" color="text.disabled">
        沒有起手手牌紀錄——這一場的換牌畫面沒有被讀到（1.3.5 之前的紀錄都是這樣）。
      </Typography>
    )
  }

  const swapped = hand.pre.filter((s) => s.swapped === true).length
  const named = [...hand.pre, ...hand.post].filter((s) => s.cardId != null).length

  return (
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Chip
          size="small"
          label={swapped === 0 ? '沒有換牌' : `換了 ${swapped} 張`}
          variant="outlined"
        />
        <Chip
          size="small"
          color={named === 0 ? 'default' : 'success'}
          variant="outlined"
          label={named === 0 ? '沒有認出任何卡片' : `認出 ${named} / 8 格`}
        />
      </Stack>

      <Row title="換前" note={swapped > 0 ? '有標記的是被換掉的' : undefined} slots={hand.pre} />
      <Row title="換後" slots={hand.post} />

      {named === 0 && (
        <Typography variant="caption" color="text.secondary">
          位置讀到了、卡片還沒認出來。卡圖索引是開啟 app 之後在背景建的，一個職業約 175
          張；這一場的畫面已經留著了，索引建完之後會自動補上——重開 app
          或稍後再回來看這一頁就會有。
        </Typography>
      )}
    </Stack>
  )
}

export default OpeningHand
