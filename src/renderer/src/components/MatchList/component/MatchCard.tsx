import React from 'react'
import { Box, Card, CardContent, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import NotesIcon from '@mui/icons-material/Notes'

import { classesMap, isDecklessMode } from '@renderer/map/classMap'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import ModeLabel from '@renderer/components/Common/ModeLabel'
import PlayOrderMark from '@renderer/components/Common/PlayOrderMark'
import PlayedAtLabel from '@renderer/components/Common/PlayedAtLabel'
import MatchScoreBlock from '@renderer/components/Common/MatchScoreBlock'
import InlineDeckSelect, { type InlineDeckOption } from './InlineDeckSelect'
import type { MatchRow } from '../types'

/**
 * A compact play-order header, matchup block (class over deck), and one meta row, so every card is this
 * tall no matter what it carries.
 */
export const MATCH_CARD_CONTENT_HEIGHT = 112

/** Past this, tags collapse into a "+n" so they never crowd out the note. */
const VISIBLE_TAGS = 2

/**
 * The centre column is a fixed width so the VS lands on the same x on every
 * row, which is what makes a list of matchups scannable down the column rather
 * than word by word. Only as wide as the word itself: the matchup reads as one
 * unit, so the two sides sit close and the VS separates them by contrast rather
 * than by distance.
 */
const VS_COLUMN_WIDTH = 28

/**
 * 模式那一格的固定寬度。
 *
 * 撐得下最長的模式名（「週末廣場賽」，13px／850 字重約 68px）再留一點餘裕。
 * 這是「不讓後面的東西跳」而不是「把模式排整齊」——模式自己靠左，多出來的
 * 空白落在它和時間之間。
 */
const MODE_COLUMN_WIDTH = 74

/**
 * 牌組名一律截在這個寬度：12.5px 的中文字約五個字。牌組名長短差很多，放任它們
 * 各自佔滿就沒有一條可以往下掃的邊界；截斷後完整名稱仍留在 title 上。
 */
const DECK_NAME_MAX_WIDTH = 68

/**
 * 沒有牌組時那一行放的是「未設定」加一個下拉箭頭，而它比截斷後的牌組名還寬。
 *
 * 這個數字曾經被算進 `MY_SIDE_WIDTH` 卻算得太緊：三個 12.5px 的中文字、16px 的
 * 箭頭、加上觸發區自己的左右內距，實測會超過牌組名那 68px，於是「未設定」被
 * 截成「未設…」——一個固定的三字標籤被省略號吃掉，是這裡最沒有意義的截斷，
 * 因為省略號本身就佔掉省下來的寬度，還讓人以為後面另有內容。
 *
 * 所以改成獨立的常數，並且取兩者較大的那個當欄寬。多出來的空白只會出現在
 * 已經填了牌組的那幾列（它們的名字仍截在 68px），代價比截字小得多。
 */
const DECK_PLACEHOLDER_WIDTH = 80

/** 牌組欄的實際寬度：要同時容得下截斷的牌組名與「未設定」下拉。 */
const DECK_COLUMN_WIDTH = Math.max(DECK_NAME_MAX_WIDTH, DECK_PLACEHOLDER_WIDTH)

/**
 * The class emblem, and the gap between it and the two lines of text.
 *
 * It leads the whole block rather than sitting inline before the class name,
 * because the deck name underneath then keeps its full width - putting a 20px
 * mark on the name line alone would have pushed `MY_SIDE_WIDTH` out by the same
 * amount while leaving the second line short of it.
 */
const CLASS_MARK = 20
const CLASS_MARK_GAP = 8

/**
 * Our half is a fixed width rather than a share of the row: text starts at the
 * left edge and the VS still lands on the same x every time. A short name
 * therefore leaves a gap before the VS - the deliberate cost of keeping both
 * the left edge and the VS column fixed. Sized to just clear the widest thing
 * either line can hold - a truncated deck name, the deck placeholder with its
 * caret, and the longest class name - so the gap stays as small as it can be,
 * plus the emblem that now leads both lines.
 */
const MY_SIDE_WIDTH = DECK_COLUMN_WIDTH + CLASS_MARK + CLASS_MARK_GAP

type Props = {
  match: MatchRow
  deckOptions: InlineDeckOption[]
  onEdit: (id: number) => void
  onDelete: (id: number) => void
  onSetDeck: (id: number, side: 'my' | 'oppo', deckId: number) => void
}

/**
 * One side of the matchup as a stacked pair: the class carries the colour and
 * the weight, the deck sits underneath it as context. Keeping the deck out of
 * the meta row stops it competing with the mode and the timings for the same
 * horizontal space.
 *
 * Both sides read left to right from their own left edge. Ours is pinned to a
 * fixed width so the VS column that follows it never moves; the opponent's
 * takes whatever is left. Either one ellipsises rather than pushing the layout
 * around.
 *
 * With no deck recorded the line becomes a picker rather than dead text: that
 * is the one edit worth making straight from the list.
 */
const Side: React.FC<{
  className: string
  deckName?: string | null
  side: 'my' | 'oppo'
  deckless: boolean
  deckOptions: InlineDeckOption[]
  onSelectDeck: (deckId: number) => void
}> = ({ className, deckName, side, deckless, deckOptions, onSelectDeck }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: `${CLASS_MARK_GAP}px`,
      ...(side === 'my' ? { width: MY_SIDE_WIDTH, flexShrink: 0 } : { flex: 1 }),
      minWidth: 0,
      overflow: 'hidden'
    }}
  >
    <ClassIcon id={className} size={CLASS_MARK} />
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        minWidth: 0,
        overflow: 'hidden'
      }}
    >
      <Typography
        fontWeight={800}
        noWrap
        sx={{
          fontSize: 15,
          lineHeight: 1.35,
          color: classesMap[className]?.color,
          maxWidth: '100%'
        }}
      >
        {classesMap[className]?.label ?? className}
      </Typography>
      {/* 沒有牌組欄的模式連空行都不留：留著只是把卡片撐得更空。職業那列本來就垂直
        置中，少一行只是這一側整體置中，不會歪掉 */}
      {deckless ? null : deckName ? (
        <Typography
          variant="body2"
          noWrap
          sx={{
            fontSize: 12.5,
            lineHeight: 1.35,
            maxWidth: DECK_NAME_MAX_WIDTH,
            color: 'text.secondary'
          }}
          title={deckName}
        >
          {deckName}
        </Typography>
      ) : (
        <InlineDeckSelect klass={className} options={deckOptions} onSelect={onSelectDeck} />
      )}
    </Box>
  </Box>
)

const MatchCard: React.FC<Props> = ({ match: m, deckOptions, onEdit, onDelete, onSetDeck }) => {
  const deckless = isDecklessMode(m.mode)
  const isWin = m.result === true
  const resultLabel = m.result == null ? '未定' : isWin ? '勝利' : '敗北'
  const resultColor = m.result == null ? '#7d8490' : isWin ? '#69d8a8' : '#f0829a'
  const resultBackground =
    m.result == null
      ? 'rgba(125, 132, 144, 0.16)'
      : isWin
        ? 'rgba(105, 216, 168, 0.16)'
        : 'rgba(240, 130, 154, 0.16)'

  const visibleTags = m.tags.slice(0, VISIBLE_TAGS)
  const hiddenTagCount = m.tags.length - visibleTags.length
  const hasExtras = m.tags.length > 0 || !!m.note

  // 標籤與備註只佔一行，收起來與截斷掉的部分由 tooltip 補完整內容
  const extrasTooltip = hasExtras ? (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.5 }}>
      {m.tags.length > 0 && (
        <Typography variant="caption">標籤：{m.tags.map((t) => t.name).join('、')}</Typography>
      )}
      {m.note && (
        <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {m.note}
        </Typography>
      )}
    </Box>
  ) : (
    ''
  )

  return (
    <Card
      variant="outlined"
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderColor: 'rgba(255,255,255,0.1)',
        transition: 'background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
        '&:hover': {
          borderColor: resultColor,
          boxShadow: '0 10px 24px rgba(0,0,0,0.2)'
        },
        // Editing and deleting are deliberate acts, not things to scan for, so
        // they stay out of the card until the pointer or the keyboard arrives.
        '&:hover .match-card-actions, &:focus-within .match-card-actions': {
          opacity: 1,
          pointerEvents: 'auto'
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onEdit(m.id)
      }}
    >
      {/* 動作放卡片右上角，浮在內容之上，不佔版面高度 */}
      <Stack
        className="match-card-actions"
        direction="row"
        spacing={0.25}
        sx={{
          position: 'absolute',
          top: 2,
          right: 2,
          zIndex: 2,
          opacity: 0,
          pointerEvents: 'none',
          transition: 'opacity 160ms ease-out',
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
        }}
      >
        <Tooltip title="編輯">
          <IconButton
            size="small"
            sx={{ p: 0.5 }}
            onClick={(e) => {
              e.stopPropagation()
              onEdit(m.id)
            }}
          >
            <EditIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="刪除">
          <IconButton
            size="small"
            color="error"
            sx={{ p: 0.5 }}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(m.id)
            }}
          >
            <DeleteOutlineIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Stack>

      <CardContent sx={{ p: 0, height: MATCH_CARD_CONTENT_HEIGHT, '&:last-child': { pb: 0 } }}>
        <Box display="flex" height="100%">
          <Box
            sx={{
              width: 88,
              flexShrink: 0,
              bgcolor: resultBackground,
              color: resultColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Typography variant="h5" fontWeight={800} lineHeight={1}>
              {resultLabel}
            </Typography>
          </Box>

          <Box
            flex={1}
            minWidth={0}
            pl={2}
            pr={1}
            py={1.25}
            display="flex"
            flexDirection="column"
            justifyContent="center"
            gap={0.5}
          >
            {/* 先後攻放在卡片資訊區最上方，掃讀對局時不必再從 VS 欄尋找。 */}
            <Box display="flex" alignItems="center" height={18}>
              <PlayOrderMark order={m.play_order} dense />
            </Box>

            {/* 職業在上、牌組在下；兩側往中間對齊，VS 欄固定寬讓每列的 VS 對齊 */}
            <Box display="flex" alignItems="center" gap={0.25} minWidth={0} height={42}>
              <Side
                className={m.my_class}
                deckName={m.my_deck?.name}
                side="my"
                deckless={deckless}
                deckOptions={deckOptions}
                onSelectDeck={(deckId) => onSetDeck(m.id, 'my', deckId)}
              />

              <Box
                sx={{
                  width: VS_COLUMN_WIDTH,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Typography
                  variant="caption"
                  color="text.disabled"
                  sx={{ fontWeight: 700, lineHeight: 1.35, letterSpacing: '0.06em' }}
                >
                  VS
                </Typography>
              </Box>

              <Side
                className={m.oppo_class}
                deckName={m.oppo_deck?.name}
                side="oppo"
                deckless={deckless}
                deckOptions={deckOptions}
                onSelectDeck={(deckId) => onSetDeck(m.id, 'oppo', deckId)}
              />
            </Box>

            <Box display="flex" alignItems="center" gap={1.25} minWidth={0} height={22}>
              {/* 模式佔固定寬度，時間才會每一列都從同一個 x 開始。模式名長度差
                  很多（「2Pick」對「週末廣場賽」），跟著內容走的話後面整條 meta
                  列會隨每一列左右跳，而這條列是拿來往下掃的。 */}
              <Box sx={{ width: MODE_COLUMN_WIDTH, flexShrink: 0 }}>
                <ModeLabel mode={m.mode} />
              </Box>
              <PlayedAtLabel playedAt={m.playedAt} />
              <Box
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.4,
                  flexShrink: 0,
                  color: 'text.secondary'
                }}
              >
                <AccessTimeIcon sx={{ fontSize: 15 }} />
                <Typography
                  component="span"
                  variant="body2"
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {m.durationTime != null
                    ? `${Math.floor(m.durationTime / 60)}:${String(m.durationTime % 60).padStart(2, '0')}`
                    : '—'}
                </Typography>
              </Box>

              {/* 標籤 / 備註接在時長後面，有才出現，不預留空位 */}
              {hasExtras && (
                <Tooltip title={extrasTooltip} placement="bottom-start">
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.75,
                      minWidth: 0,
                      overflow: 'hidden',
                      pl: 1.25,
                      borderLeft: '1px solid',
                      borderColor: 'rgba(255,255,255,0.12)'
                    }}
                  >
                    {visibleTags.length > 0 && (
                      <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                        {visibleTags.map((t) => (
                          <Chip
                            key={t.id}
                            size="small"
                            variant="outlined"
                            label={t.name}
                            sx={{
                              height: 20,
                              fontSize: '0.72rem',
                              maxWidth: 110,
                              flexShrink: 0
                            }}
                          />
                        ))}
                        {hiddenTagCount > 0 && (
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`+${hiddenTagCount}`}
                            sx={{
                              height: 20,
                              fontSize: '0.72rem',
                              flexShrink: 0,
                              fontWeight: 700,
                              color: 'text.secondary'
                            }}
                          />
                        )}
                      </Box>
                    )}
                    {m.note && (
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.4,
                          color: 'text.secondary',
                          minWidth: 0,
                          // 備註再長也只佔這麼寬，超出以 … 收尾，
                          // 不讓它把整條資訊列吃掉
                          maxWidth: 260
                        }}
                      >
                        <NotesIcon sx={{ fontSize: 15, flexShrink: 0, opacity: 0.7 }} />
                        <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
                          {m.note}
                        </Typography>
                      </Box>
                    )}
                  </Box>
                </Tooltip>
              )}
            </Box>
          </Box>

          {/* 分數自成一欄。靠下對齊讓出右上角給動作按鈕，同時和資訊列同高。 */}
          <Box
            sx={{
              flexShrink: 0,
              // 寬到足以容納「MP 12,480 · CR 2,104」這種兩行分數，讓每張卡片的
              // 中間欄寬度一致，牌組名的截斷位置才不會一張一個樣
              minWidth: 136,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'flex-end',
              pr: 2,
              pl: 1,
              pb: 1.25
            }}
          >
            <MatchScoreBlock match={m} />
          </Box>
        </Box>
      </CardContent>
    </Card>
  )
}

export default React.memo(MatchCard)
