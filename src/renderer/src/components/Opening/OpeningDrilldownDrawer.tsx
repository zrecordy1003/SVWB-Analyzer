/**
 * One card, opened from the 起手 table.
 *
 * The top is the card and its row, in full - the same numbers the table shows,
 * with room for their sentences. The bottom is the split the table has no room
 * for: keep rate by opponent class, and by turn order.
 *
 * # Where the split comes from
 *
 * The contract has no per-card split. What it has is the filter: the payload
 * accepts `oppoClassIds`, so the drawer asks the same channel seven more times,
 * once per opponent class, and picks this card's row out of each answer. It is
 * seven local IPC round trips through the shared cache, fired only while the
 * drawer is open, and re-opening on the same card costs nothing. The other
 * option - a dedicated per-card channel - is the right one eventually and
 * would be a main-process change; this page's scope stopped at the renderer.
 *
 * Turn order has no filter at all in `QueryPayload`, so that split cannot be
 * asked for today. The section is drawn anyway, saying exactly that, because
 * a player who comes looking for it should learn it is not there yet rather
 * than conclude they missed it.
 *
 * # What the split may say
 *
 * Almost nothing, and that is expected. One player's keep rate for one card
 * against one class is a handful of observations, so every line here defaults
 * to `樣本不足 (n=…)` and becomes a number only when it clears the same
 * `keepRate` threshold the table uses. The split is shown so the user can see
 * their data accumulate; it is not shown so they can read seven noisy numbers.
 */
import { Box, Drawer, IconButton, Skeleton, Stack, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import React from 'react'

import type { ClassName } from '@shared/domain'
import {
  OPENING_THRESHOLDS,
  type OpeningCardStat,
  type OpeningStatsPayload
} from '@shared/openingStats'
import { cardImageUrl } from '@shared/deckImport'
import ClassIcon from '@renderer/components/Common/ClassIcon'
import InfoHint from '@renderer/components/Common/InfoHint'
import { classes } from '@renderer/map/classMap'
import { CostBadge } from '@renderer/components/Cards/CardsTable'
import { wilsonInterval } from '@renderer/components/Analyzer/confidence'
import {
  BACKDROP_SX,
  BAR_SX,
  DRAWER_SURFACE_SX,
  HAIRLINE_BOTTOM
} from '@renderer/components/Common/surfaces'

import { IntervalBar, MissingPill, RateCell, SampleOnly } from './cells'
import { demoOpponentSplit } from './demoData'
import type { OpeningRow } from './openingFilterState'
import {
  fmtN,
  fmtPct,
  missingFor,
  NUMERIC,
  RARITY_LABEL,
  remainingFor,
  sampleFor
} from './openingFormat'
import { openingStatsResource } from './useOpeningStats'

const GUTTER = 2.5

function CardArt({ hash, name }: { hash: string | null; name: string }): React.JSX.Element | null {
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

/** A labelled block with a heading and an optional ⓘ (`InfoHint`, the app's one). */
function Section({
  title,
  info,
  children
}: {
  title: string
  info?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={800}>
          {title}
        </Typography>
        {info && (
          <InfoHint
            label={`${title}的說明`}
            title={
              <Typography variant="caption" component="div" sx={{ maxWidth: 300, lineHeight: 1.6 }}>
                {info}
              </Typography>
            }
          />
        )}
      </Stack>
      {children}
    </Box>
  )
}

/** A keep-rate line: label, then either the rate with its whisker or the sample size. */
function KeepLine({
  icon,
  label,
  dealt,
  kept,
  loading
}: {
  icon: React.ReactNode
  label: string
  dealt: number | null
  kept: number | null
  loading?: boolean
}): React.JSX.Element {
  const ok = dealt !== null && kept !== null && dealt >= OPENING_THRESHOLDS.keepRate
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.25}
      sx={{ px: 1.5, py: 0.75, borderTop: '1px solid', borderColor: 'divider' }}
    >
      {icon}
      <Typography variant="body2" fontWeight={700} sx={{ width: 84, flexShrink: 0 }} noWrap>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {loading ? (
          <Skeleton variant="text" width={120} />
        ) : dealt === null ? (
          <Typography variant="caption" color="text.disabled">
            查不到
          </Typography>
        ) : ok ? (
          (() => {
            const { low, high } = wilsonInterval(kept, dealt)
            const rate = { total: dealt, wins: kept, rate: (kept / dealt) * 100, lo: low, hi: high }
            return (
              <Stack direction="row" alignItems="center" spacing={1.5}>
                <Typography
                  component="span"
                  sx={{ ...NUMERIC, fontSize: 14, fontWeight: 800, width: 52, textAlign: 'right' }}
                >
                  {fmtPct(rate.rate)}
                </Typography>
                <IntervalBar rate={rate} anchor={null} height={5} />
                <Typography
                  component="span"
                  variant="caption"
                  sx={{ ...NUMERIC, color: 'text.secondary', width: 44 }}
                >
                  {fmtN(dealt)}
                </Typography>
              </Stack>
            )
          })()
        ) : (
          <Typography variant="caption" sx={{ color: 'text.disabled', ...NUMERIC }}>
            樣本不足 ({fmtN(dealt)})
            {dealt > 0 && (
              <Box component="span" sx={{ ml: 0.75, color: 'text.disabled' }}>
                · 還差 {OPENING_THRESHOLDS.keepRate - dealt} 次
              </Box>
            )}
          </Typography>
        )}
      </Box>
    </Stack>
  )
}

/**
 * One opponent class: its own query through the shared cache. A component per
 * class, rather than seven hooks in a loop, so each subscription is a stable
 * hook call and the rules of hooks hold without a comment explaining why not.
 */
function OpponentLine({
  klass,
  label,
  stat,
  baseQuery,
  demo
}: {
  klass: ClassName
  label: string
  stat: OpeningCardStat
  baseQuery: OpeningStatsPayload | null
  demo: boolean
}): React.JSX.Element {
  const query = React.useMemo<OpeningStatsPayload | null>(
    () => (demo || !baseQuery ? null : { ...baseQuery, oppoClassIds: [klass] }),
    [baseQuery, demo, klass]
  )
  const { data, loading } = openingStatsResource.use(query ? [query] : null)
  const split = demo
    ? demoOpponentSplit(stat, klass)
    : (() => {
        if (!data) return null
        const row = data.cards.find((c) => c.cardId === stat.cardId)
        return row ? { dealt: row.dealt, kept: row.kept } : { dealt: 0, kept: 0 }
      })()
  return (
    <KeepLine
      icon={<ClassIcon id={klass} size={18} />}
      label={label}
      dealt={split?.dealt ?? null}
      kept={split?.kept ?? null}
      loading={!demo && loading && !data}
    />
  )
}

export default function OpeningDrilldownDrawer({
  row,
  open,
  onClose,
  baseQuery,
  demo
}: {
  /** The last selected row stays mounted while the drawer slides out. */
  row: OpeningRow | null
  open: boolean
  onClose: () => void
  /** The page's current query; the split adds one opponent class to it. */
  baseQuery: OpeningStatsPayload | null
  /** 示範資料 is on: the split is derived, not queried. */
  demo: boolean
}): React.JSX.Element {
  const stat = row?.stat ?? null

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      sx={{ zIndex: 1300 }}
      slotProps={{
        backdrop: { sx: BACKDROP_SX },
        paper: {
          elevation: 0,
          sx: { ...DRAWER_SURFACE_SX, width: 'min(540px, calc(100vw - 32px))' }
        }
      }}
    >
      {stat && row && (
        <Box
          data-testid="opening-drilldown"
          data-card-id={stat.cardId}
          sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* ---------- 標題列：卡片本身 ---------- */}
          <Box sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: GUTTER, pt: GUTTER, pb: 2, flexShrink: 0 }}>
            <Stack direction="row" alignItems="flex-start" spacing={2}>
              <CardArt hash={stat.bannerHash} name={stat.name} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <CostBadge cost={stat.cost} size={28} />
                  <Typography
                    variant="h6"
                    component="h2"
                    sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.3, minWidth: 0 }}
                  >
                    {stat.name}
                  </Typography>
                </Stack>
                <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mt: 0.5 }}>
                  <ClassIcon id={stat.className} size={16} />
                  <Typography
                    variant="caption"
                    sx={{ color: 'text.secondary', letterSpacing: '0.05em' }}
                  >
                    {[
                      stat.className === 'neutral'
                        ? '中立'
                        : classes.find((c) => c.id === stat.className)?.label,
                      stat.rarity ? RARITY_LABEL[stat.rarity] : null,
                      stat.copies !== null ? `牌組帶 ${stat.copies.toFixed(1)} 張` : null
                    ]
                      .filter(Boolean)
                      .join(' ・ ')}
                  </Typography>
                </Stack>
                {/* The pill carries its own explanation on hover; the first
                    pass also printed that sentence under it, twice the words
                    for the same fact. */}
                {stat.missing && (
                  <Box sx={{ mt: 1.25 }}>
                    <MissingPill
                      kind={stat.missing}
                      sample={sampleFor(stat, 'compare')}
                      remaining={remainingFor(stat, 'compare')}
                    />
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

          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              px: GUTTER,
              py: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 2.5
            }}
          >
            {/* ---------- 這一列的數字，攤開來 ---------- */}
            <Section title="整體">
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 1.5,
                  '& > *': { p: 1.5, borderRadius: 2, bgcolor: 'action.hover', minWidth: 0 }
                }}
              >
                <Box>
                  <Typography variant="caption" color="text.secondary" component="div">
                    保留率
                  </Typography>
                  <Box sx={{ mt: 0.5 }}>
                    {stat.keepRate ? (
                      <RateCell rate={stat.keepRate} label="保留率" anchor={null} emphasis />
                    ) : (
                      <MissingPill
                        kind={missingFor(stat, 'keep')}
                        sample={sampleFor(stat, 'keep')}
                        remaining={remainingFor(stat, 'keep')}
                      />
                    )}
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.disabled"
                    component="div"
                    sx={{ mt: 0.5, ...NUMERIC }}
                  >
                    發到 {stat.dealt} · 留 {stat.kept}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary" component="div">
                    發到 vs 沒發到
                  </Typography>
                  <Box sx={{ mt: 0.5 }}>
                    {stat.confidence !== 'hidden' && stat.dealtWr && stat.notDealtWr ? (
                      <Stack spacing={0.75}>
                        <RateCell rate={stat.dealtWr} label="發到時的勝率" />
                        <RateCell rate={stat.notDealtWr} label="沒發到時的勝率" muted />
                      </Stack>
                    ) : missingFor(stat, 'compare') === 'low-sample' ? (
                      <SampleOnly
                        sample={sampleFor(stat, 'compare')}
                        what="勝率差"
                        remaining={remainingFor(stat, 'compare')}
                      />
                    ) : (
                      <MissingPill kind={missingFor(stat, 'compare')} />
                    )}
                  </Box>
                </Box>
              </Box>
            </Section>

            {/* ---------- 依對手職業 ---------- */}
            <Section
              title="保留率 · 依對手職業"
              info="同一張卡，對上每個職業時留下來的比例。一個人對一個職業的樣本通常只有幾次，所以這裡預設是「樣本不足」，夠了才變成數字。"
            >
              <Box
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 2,
                  overflow: 'hidden',
                  '& > :first-of-type': { borderTop: 'none' }
                }}
              >
                {classes.map((c) => (
                  <OpponentLine
                    key={c.id}
                    klass={c.id as ClassName}
                    label={c.label}
                    stat={stat}
                    baseQuery={baseQuery}
                    demo={demo}
                  />
                ))}
              </Box>
            </Section>

            {/* ---------- 依先後手 ---------- */}
            <Section
              title="保留率 · 依先後手"
              info="先手和後手的換牌邏輯不一樣，這個切法是有意義的。但這一版的查詢條件還沒有先後手，所以卡片層算不出來；整體的先後手差異先看「換牌張數」的切換。"
            >
              <Box
                sx={{
                  border: '1px dashed',
                  borderColor: 'divider',
                  borderRadius: 2,
                  px: 1.5,
                  py: 1.25,
                  textAlign: 'center'
                }}
              >
                <Typography variant="caption" color="text.disabled">
                  尚未提供
                </Typography>
              </Box>
            </Section>
          </Box>
        </Box>
      )}
    </Drawer>
  )
}
