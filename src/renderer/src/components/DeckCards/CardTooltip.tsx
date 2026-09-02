/**
 * The card tooltip.
 *
 * Card text is the thing a player actually reads while building a deck, so it
 * gets real layout rather than a native `title=""`: one unwrapped line, half a
 * second of delay, and the portal's markup printed verbatim.
 *
 * The parsing lives in `src/shared/cardText.ts`, where it is pure and tested
 * against the whole card pool. What is left here is only the question of how
 * each kind of block should LOOK:
 *
 * - keywords tinted, because that is how the game distinguishes them
 * - evolve and super-evolve labelled, because "【進化時】…" buried in a
 *   paragraph reads as another sentence rather than another mode of the card
 * - mode options indented and numbered, because they are alternatives to choose
 *   between, not steps to perform in order
 */
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import { parseCardText, type CardTextSegment } from '@shared/cardText'
import React from 'react'

/** Warm, so a keyword reads as emphasis rather than as a link. */
const KEYWORD_TONE = '#f2c879'
/** Evolve is the card's second face; the game marks it in cool green-teal. */
const EVOLVE_TONE = '#7fd6c0'
const SUPER_EVOLVE_TONE = '#c9a4ff'
const MODE_TONE = '#8db2ff'

const KIND_LABEL: Record<string, string> = {
  follower: '從者',
  spell: '法術',
  amulet: '護符'
}

const RARITY_LABEL: Record<number, string> = {
  1: '銅',
  2: '銀',
  3: '金',
  4: '虹'
}

const SEGMENT_LABEL: Partial<Record<CardTextSegment['variant'], { text: string; tone: string }>> = {
  evolve: { text: '進化', tone: EVOLVE_TONE },
  superEvolve: { text: '超進化', tone: SUPER_EVOLVE_TONE }
}

function Lines({ segment }: { segment: CardTextSegment }): React.JSX.Element {
  return (
    <>
      {segment.lines.map((line, i) => (
        <Typography key={i} variant="body2" sx={{ lineHeight: 1.75, mt: i === 0 ? 0 : 0.25 }}>
          {line.map((run, j) =>
            run.keyword ? (
              <Box key={j} component="span" sx={{ color: KEYWORD_TONE, fontWeight: 700 }}>
                {run.text}
              </Box>
            ) : (
              <React.Fragment key={j}>{run.text}</React.Fragment>
            )
          )}
        </Typography>
      ))}
    </>
  )
}

function Segment({ segment }: { segment: CardTextSegment }): React.JSX.Element {
  const label = SEGMENT_LABEL[segment.variant]

  return (
    <Box sx={{ mt: segment.divider ? 1.25 : 0.75, '&:first-of-type': { mt: 0 } }}>
      {segment.divider && <Box sx={{ height: 1, bgcolor: 'rgba(255,255,255,0.14)', mb: 1.25 }} />}

      {label && (
        <Box
          sx={{
            display: 'inline-block',
            px: 0.75,
            py: 0.1,
            mb: 0.5,
            borderRadius: 0.75,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.06em',
            color: label.tone,
            border: `1px solid ${label.tone}55`,
            bgcolor: `${label.tone}18`
          }}
        >
          {label.text}
        </Box>
      )}

      {segment.variant === 'mode' ? (
        // Indented with a rule down the side: these are alternatives to pick
        // between, and a flat paragraph makes them look like a sequence.
        <Box sx={{ pl: 1.25, borderLeft: `2px solid ${MODE_TONE}55` }}>
          <Lines segment={segment} />
        </Box>
      ) : (
        <Lines segment={segment} />
      )}
    </Box>
  )
}

/**
 * The card text on its own, for anything that shows a card in full rather than
 * on hover (the 卡片 page's drill-down). Same parsing, same tones, so a card
 * reads identically wherever its text is printed.
 */
export function CardTextBlocks({ skillText }: { skillText: string | null }): React.JSX.Element {
  const segments = React.useMemo(() => parseCardText(skillText), [skillText])
  return (
    <>
      {segments.map((segment, i) => (
        <Segment key={i} segment={segment} />
      ))}
    </>
  )
}

export type CardTooltipCard = {
  name: string
  cost: number | null
  kind: string | null
  rarity: number | null
  atk: number | null
  life: number | null
  skillText: string | null
}

function CardTooltipBody({ card }: { card: CardTooltipCard }): React.JSX.Element {
  const segments = React.useMemo(() => parseCardText(card.skillText), [card.skillText])
  const stats =
    card.kind === 'follower' && card.atk !== null && card.life !== null
      ? `${card.atk} / ${card.life}`
      : null

  return (
    <Box sx={{ width: 300 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Box
          sx={{
            minWidth: 24,
            height: 24,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            fontSize: 12,
            fontWeight: 800,
            bgcolor: 'rgba(255,255,255,0.14)'
          }}
        >
          {card.cost ?? '?'}
        </Box>
        <Typography variant="subtitle2" fontWeight={800} sx={{ flex: 1, lineHeight: 1.35 }}>
          {card.name}
        </Typography>
        {stats && (
          <Typography
            variant="caption"
            sx={{ fontWeight: 800, opacity: 0.9, whiteSpace: 'nowrap' }}
          >
            {stats}
          </Typography>
        )}
      </Stack>

      <Typography
        variant="caption"
        sx={{ display: 'block', mt: 0.5, opacity: 0.55, letterSpacing: '0.05em' }}
      >
        {[card.kind ? KIND_LABEL[card.kind] : null, card.rarity ? RARITY_LABEL[card.rarity] : null]
          .filter(Boolean)
          .join(' ・ ')}
      </Typography>

      {segments.length > 0 && (
        <>
          <Box sx={{ height: 1, bgcolor: 'rgba(255,255,255,0.14)', my: 1.25 }} />
          {segments.map((segment, i) => (
            <Segment key={i} segment={segment} />
          ))}
        </>
      )}
    </Box>
  )
}

export default function CardTooltip({
  card,
  children
}: {
  card: CardTooltipCard
  children: React.ReactElement
}): React.JSX.Element {
  return (
    <Tooltip
      title={<CardTooltipBody card={card} />}
      // Follows the cursor: anchored to its cell it would cover the very cards
      // the user is comparing this one against.
      followCursor
      enterDelay={200}
      leaveDelay={60}
      slotProps={{
        tooltip: {
          sx: {
            backgroundColor: '#171d2b',
            backgroundImage:
              'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 64px)',
            border: '1px solid rgba(255,255,255,0.13)',
            borderRadius: 2,
            boxShadow: '0 18px 44px -10px rgba(0,0,0,0.85)',
            color: 'rgba(255,255,255,0.92)',
            p: 1.5,
            maxWidth: 'none'
          }
        }
      }}
    >
      {children}
    </Tooltip>
  )
}
