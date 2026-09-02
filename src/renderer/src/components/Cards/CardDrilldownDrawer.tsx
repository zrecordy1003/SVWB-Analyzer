/**
 * One card, opened from the table: what it is, and which decks carried it.
 *
 * The top half is the card itself - art, cost, type, text - in the same
 * presentation the deck builder's tooltip uses, because a player reads a card
 * the same way everywhere. The bottom half is the actual answer this page
 * exists to give: every family that ran the card, each version of it that did,
 * with that version's record, and the same class's decks WITHOUT the card as
 * the line to compare against.
 *
 * Same drawer chrome as `NewDeckDrawer` / `MatchFormDrawer`: one right-hand
 * sheet for everything that opens on the side of a page.
 */
import { Box, Chip, Drawer, IconButton, Stack, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import React from 'react'

import { CARD_STATS_LOW_SAMPLE, type CardDeckStat } from '@shared/cardStats'
import { cardImageUrl } from '@shared/deckImport'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import { classesMap } from '@renderer/map/classMap'
import { CardTextBlocks } from '@renderer/components/DeckCards/CardTooltip'
import { formatWithInterval } from '@renderer/components/Analyzer/confidence'
import {
  BACKDROP_SX,
  BAR_SX,
  DRAWER_SURFACE_SX,
  HAIRLINE_BOTTOM
} from '@renderer/components/Common/surfaces'

import type { CardRow } from './cardsFilterState'
import { CostBadge } from './CardsTable'
import { cardMetaLine, fmtDelta, fmtRate } from './cardsFormat'

const NUMERIC = { fontVariantNumeric: 'tabular-nums' } as const
const GUTTER = 2.5

type FamilyGroup = {
  familyId: number
  name: string
  archived: boolean
  total: number
  wins: number
  versions: CardDeckStat[]
}

/** Decks -> families, most played first; versions inside by id (= version order). */
function groupFamilies(decks: CardDeckStat[]): FamilyGroup[] {
  const map = new Map<number, FamilyGroup>()
  for (const deck of decks) {
    let group = map.get(deck.familyId)
    if (!group) {
      group = {
        familyId: deck.familyId,
        name: deck.name,
        archived: true,
        total: 0,
        wins: 0,
        versions: []
      }
      map.set(deck.familyId, group)
    }
    group.total += deck.total
    group.wins += deck.wins
    // A family is archived only if every version of it that carried the card is.
    if (deck.archivedAt === null) group.archived = false
    group.versions.push(deck)
  }
  return [...map.values()]
    .map((g) => ({ ...g, versions: [...g.versions].sort((a, b) => a.deckId - b.deckId) }))
    .sort((a, b) => b.total - a.total || a.familyId - b.familyId)
}

function CardArt({ hash, name }: { hash: string | null; name: string }) {
  const src = cardImageUrl('card', hash)
  const [failed, setFailed] = React.useState(false)
  if (!src || failed) return null
  return (
    <Box
      component="img"
      src={src}
      alt={name}
      onError={() => setFailed(true)}
      sx={{
        width: 132,
        flexShrink: 0,
        borderRadius: 1.5,
        display: 'block',
        boxShadow: '0 10px 28px -8px rgba(0,0,0,0.8)'
      }}
    />
  )
}

function RecordLine({
  wins,
  total,
  muted,
  emphasis
}: {
  wins: number
  total: number
  muted?: boolean
  emphasis?: boolean
}) {
  const rate = total > 0 ? (wins / total) * 100 : null
  return (
    <Tooltip title={formatWithInterval(wins, total)} placement="top" disableInteractive>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ width: 190, flexShrink: 0 }}>
        <Typography
          variant="caption"
          noWrap
          sx={{ ...NUMERIC, width: 84, textAlign: 'right', color: 'text.secondary' }}
        >
          {total > 0 ? `${wins}勝 ${total - wins}敗` : '—'}
        </Typography>
        <Box
          sx={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            bgcolor: 'action.hover',
            overflow: 'hidden'
          }}
        >
          {rate !== null && (
            <Box
              sx={{
                width: `${Math.min(100, rate)}%`,
                height: '100%',
                bgcolor: muted ? 'text.disabled' : rate >= 50 ? 'success.main' : 'error.main'
              }}
            />
          )}
        </Box>
        <Typography
          sx={{
            ...NUMERIC,
            width: 46,
            textAlign: 'right',
            fontSize: emphasis ? 14 : 12,
            fontWeight: 800,
            color:
              rate === null
                ? 'text.disabled'
                : muted
                  ? 'text.secondary'
                  : rate >= 50
                    ? 'success.light'
                    : 'error.light'
          }}
        >
          {fmtRate(rate)}
        </Typography>
      </Stack>
    </Tooltip>
  )
}

export default function CardDrilldownDrawer({
  row,
  open,
  onClose
}: {
  /** The last selected row stays mounted while the drawer slides out. */
  row: CardRow | null
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const families = React.useMemo(() => (row ? groupFamilies(row.card.decks) : []), [row])
  const card = row?.card ?? null
  const classLabel = row ? (classesMap[row.myClass]?.label ?? row.myClass) : ''

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      // The app bar sits at `zIndex.drawer + 1`; the same level DeckBuilder's
      // drawer uses keeps this one's header from disappearing under it.
      sx={{ zIndex: 1300 }}
      slotProps={{
        backdrop: { sx: BACKDROP_SX },
        paper: {
          elevation: 0,
          sx: { ...DRAWER_SURFACE_SX, width: 'min(520px, calc(100vw - 32px))' }
        }
      }}
    >
      {card && row && (
        <Box
          data-testid="cards-drilldown"
          data-card-id={card.cardId}
          sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* ---------- 標題列：卡片本身 ---------- */}
          <Box sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: GUTTER, pt: GUTTER, pb: 2, flexShrink: 0 }}>
            <Stack direction="row" alignItems="flex-start" spacing={2}>
              <CardArt hash={card.imageHash} name={card.name} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <CostBadge cost={card.cost} size={28} />
                  <Typography
                    variant="h6"
                    component="h2"
                    sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.3, minWidth: 0 }}
                  >
                    {card.name}
                  </Typography>
                </Stack>
                <Typography
                  variant="caption"
                  sx={{
                    display: 'block',
                    mt: 0.5,
                    color: 'text.secondary',
                    letterSpacing: '0.05em'
                  }}
                >
                  {cardMetaLine(card)}
                </Typography>
                {card.skillText && (
                  <Box sx={{ mt: 1.25, fontSize: 13, color: 'text.primary' }}>
                    <CardTextBlocks skillText={card.skillText} />
                  </Box>
                )}
              </Box>
              <IconButton
                size="small"
                onClick={onClose}
                aria-label="關閉卡片"
                sx={{ color: 'text.secondary', '&:hover': { bgcolor: 'action.hover' } }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Box>

          {/* ---------- 內容：帶這張卡的牌組 ---------- */}
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: GUTTER, py: 2 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.25 }}>
              <Typography variant="subtitle2" fontWeight={800}>
                帶這張卡的牌組
              </Typography>
              <Tooltip
                title="這些是牌組的成績，不是卡片本身的：沒有抽牌／出牌資料，看不出這張卡在手上時打得怎樣。"
                placement="top"
              >
                <Box
                  component="span"
                  aria-label="這些數字的意思"
                  sx={{ display: 'inline-flex', color: 'text.disabled', cursor: 'help' }}
                >
                  <InfoOutlinedIcon sx={{ fontSize: 15 }} />
                </Box>
              </Tooltip>
              <Typography variant="caption" color="text.secondary" sx={NUMERIC}>
                {classLabel} ・ {families.length} 副 ・ {card.decks.length} 版 ・ {card.total} 場
              </Typography>
            </Stack>

            <Stack spacing={1}>
              {families.map((family) => (
                <Box
                  key={family.familyId}
                  data-testid={`cards-drilldown-family-${family.familyId}`}
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 2,
                    overflow: 'hidden',
                    opacity: family.archived ? 0.6 : 1
                  }}
                >
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    sx={{ px: 1.5, py: 1, bgcolor: 'action.hover' }}
                  >
                    <ClassIcon id={row.myClass} size={20} />
                    <Typography
                      fontWeight={700}
                      noWrap
                      title={family.name}
                      sx={{ flex: 1, minWidth: 0 }}
                    >
                      {family.name}
                    </Typography>
                    {family.archived && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label="已刪除"
                        sx={{ height: 20, fontSize: 11, color: 'text.secondary', flexShrink: 0 }}
                      />
                    )}
                    <Typography
                      variant="caption"
                      sx={{ ...NUMERIC, color: 'text.secondary', flexShrink: 0 }}
                    >
                      {family.total} 場
                    </Typography>
                    <RecordLine wins={family.wins} total={family.total} emphasis />
                  </Stack>

                  {/* 每個版本一行：哪一版、帶幾張、打了幾場。testid 掛在版本上 -
                      deckId 才是對局真正指向的那份卡表。 */}
                  {family.versions.map((version) => (
                    <Stack
                      key={version.deckId}
                      direction="row"
                      alignItems="center"
                      spacing={1}
                      data-testid={`cards-drilldown-deck-${version.deckId}`}
                      data-archived={version.archivedAt !== null ? 'true' : undefined}
                      sx={{
                        px: 1.5,
                        py: 0.6,
                        borderTop: '1px solid',
                        borderColor: 'divider',
                        opacity: version.archivedAt !== null ? 0.65 : 1
                      }}
                    >
                      <Chip
                        size="small"
                        label={version.versionLabel}
                        sx={{
                          height: 20,
                          fontSize: 11,
                          fontWeight: 800,
                          ...NUMERIC,
                          bgcolor: 'rgba(122,162,247,0.16)',
                          flexShrink: 0
                        }}
                      />
                      <Typography
                        variant="caption"
                        sx={{ ...NUMERIC, color: 'text.secondary', width: 36 }}
                      >
                        ×{version.copies}
                      </Typography>
                      <Box sx={{ flex: 1 }} />
                      <Typography
                        variant="caption"
                        sx={{ ...NUMERIC, color: 'text.secondary', flexShrink: 0 }}
                      >
                        {version.total} 場
                      </Typography>
                      <RecordLine
                        wins={version.wins}
                        total={version.total}
                        muted={version.total < CARD_STATS_LOW_SAMPLE}
                      />
                    </Stack>
                  ))}
                </Box>
              ))}
            </Stack>

            {/* 對照：同職業、同範圍、沒帶它的牌組。這是差值的分母那一邊。 */}
            <Box
              data-testid="cards-drilldown-without"
              sx={{
                mt: 1.5,
                px: 1.5,
                py: 1,
                borderRadius: 2,
                border: '1px dashed',
                borderColor: 'divider'
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={700} noWrap>
                    同職業不帶它的牌組
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div" sx={NUMERIC}>
                    {card.without.total > 0
                      ? `${card.without.total} 場 ・ 差值 ${fmtDelta(row.delta)}${
                          row.deltaLowSample ? `（對照組不足 ${CARD_STATS_LOW_SAMPLE} 場）` : ''
                        }`
                      : '這個範圍內沒有這樣的對局'}
                  </Typography>
                </Box>
                <RecordLine
                  wins={card.without.wins}
                  total={card.without.total}
                  muted={row.deltaLowSample}
                  emphasis
                />
              </Stack>
            </Box>
          </Box>
        </Box>
      )}
    </Drawer>
  )
}
