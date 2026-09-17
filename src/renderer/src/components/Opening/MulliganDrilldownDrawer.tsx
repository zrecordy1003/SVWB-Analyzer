/**
 * One card, opened from the 換牌建議 table.
 *
 * The top is the row in full: keep rate, the two arms, the adjusted
 * difference, and the basis pill at title size. The bottom is the thing the
 * table has no room for and the reason the drawer exists: the per-band arms
 * behind a `'stratified'` estimate.
 *
 * # Why the bands are shown as three separate comparisons
 *
 * The summary number is one difference. It could have been produced by three
 * bands that agree, or by one band with a large gap and two that say nothing -
 * and the second case is the one a reader should distrust, because a
 * difference that lives in one slice of the data is usually noise wearing a
 * pattern. So each band gets its own line with both arms drawn and its own
 * crude gap printed, and a band the estimate could not use (one arm empty) is
 * still listed and marked, because "you never swapped it when the rest of the
 * hand was cheap" is itself a fact about the player's habit and about how
 * little of the comparison is really there.
 *
 * Below `'stratified'` there are no bands; the section says what the row
 * pooled instead of drawing an empty box, following the 起手 drawer's rule
 * that a reader who comes looking for a split should learn why it is not
 * there rather than conclude they missed it.
 */
import { Box, Drawer, IconButton, Stack, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import React from 'react'

import type { KeepAdvice, KeepBand, Rate } from '@shared/openingStats'
import { cardImageUrl } from '@shared/deckImport'
import InfoHint from '@renderer/components/Common/InfoHint'
import { CostBadge } from '@renderer/components/Cards/CardsTable'
import {
  BACKDROP_SX,
  BAR_SX,
  DRAWER_SURFACE_SX,
  HAIRLINE_BOTTOM
} from '@renderer/components/Common/surfaces'

import { Hint, IntervalBar, MissingPill, RateCell, SampleOnly } from './cells'
import { BasisMark, KeepDiffCell } from './MulliganTable'
import {
  armsRemaining,
  armsSample,
  BAND_CAVEAT,
  BAND_LABEL,
  basisSpec,
  keepRemaining,
  keepSample,
  type MulliganRow,
  type Pins
} from './mulliganState'
import { fmtDelta, fmtN, fmtPct, NUMERIC } from './openingFormat'

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
        {info && <InfoHint label={`${title}的說明`} title={<Hint>{info}</Hint>} />}
      </Stack>
      {children}
    </Box>
  )
}

/** One arm inside a band: label, whisker, rate and n - or the reason there is none. */
function Arm({ label, rate, muted }: { label: string; rate: Rate | null; muted?: boolean }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        sx={{ width: 40, flexShrink: 0, color: 'text.secondary', fontWeight: 700 }}
      >
        {label}
      </Typography>
      {rate ? (
        <>
          <IntervalBar rate={rate} height={5} muted={muted} />
          <Typography
            component="span"
            sx={{ ...NUMERIC, fontSize: 12, fontWeight: 800, width: 44, textAlign: 'right' }}
          >
            {fmtPct(rate.rate)}
          </Typography>
          <Typography
            component="span"
            variant="caption"
            sx={{ ...NUMERIC, color: 'text.disabled', width: 40 }}
          >
            {fmtN(rate.total)}
          </Typography>
        </>
      ) : (
        <Typography variant="caption" sx={{ color: 'text.disabled', flex: 1 }}>
          沒有這樣做過
        </Typography>
      )}
    </Stack>
  )
}

/**
 * One rest-of-hand band: both arms, and the band's own crude gap.
 *
 * The gap is the raw difference of the two arms, unshrunk and without an
 * interval: this is a diagnostic view, and the question it answers is
 * "do the bands point the same way", which the sign and the size settle. A
 * band with one arm has no gap and says so; it is still drawn because a
 * band the estimate left out is exactly what a suspicious reader opened the
 * drawer to find.
 */
function BandLine({ band }: { band: KeepBand }): React.JSX.Element {
  const both = band.keptWr !== null && band.swappedWr !== null
  const gap = both ? band.keptWr!.rate - band.swappedWr!.rate : null
  const thin = both && Math.min(band.keptWr!.total, band.swappedWr!.total) < 5
  return (
    <Box
      data-testid="mulligan-band"
      data-band={band.band}
      data-contributing={both}
      sx={{ px: 1.5, py: 1, borderTop: '1px solid', borderColor: 'divider' }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
        <Typography variant="body2" fontWeight={700} sx={{ flex: 1, minWidth: 0 }} noWrap>
          {BAND_LABEL[band.band] ?? `第 ${band.band + 1} 段`}
        </Typography>
        {gap === null ? (
          <Typography variant="caption" sx={{ color: 'text.disabled' }}>
            只有一邊，未納入估計
          </Typography>
        ) : (
          <Typography
            component="span"
            sx={{
              ...NUMERIC,
              fontSize: 12,
              fontWeight: 800,
              color: thin ? 'text.disabled' : gap >= 0 ? 'success.light' : 'error.light'
            }}
          >
            差 {fmtDelta(gap)}
            {thin && (
              <Box component="span" sx={{ ml: 0.5, fontWeight: 500, color: 'text.disabled' }}>
                （一邊不到 5 次）
              </Box>
            )}
          </Typography>
        )}
      </Stack>
      <Stack spacing={0.5}>
        <Arm label="留下" rate={band.keptWr} />
        <Arm label="換掉" rate={band.swappedWr} muted />
      </Stack>
    </Box>
  )
}

/**
 * What the band section says when there are no bands: the row's numbers came
 * from a pooled rung, and this is the sentence that says which.
 */
function NoBands({ advice, pins }: { advice: KeepAdvice; pins: Pins }): React.JSX.Element {
  const spec = basisSpec(advice.basis, pins)
  return (
    <Box
      sx={{
        border: '1px dashed',
        borderColor: 'divider',
        borderRadius: 2,
        px: 1.5,
        py: 1.25
      }}
    >
      <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.6 }}>
        {advice.confidence === 'hidden'
          ? '這張卡連放寬到所有對手都不夠比，所以沒有分段可看。上面的 n 是它在你選的條件裡留與換各幾次。'
          : spec.explain}
      </Typography>
    </Box>
  )
}

export default function MulliganDrilldownDrawer({
  row,
  pins,
  open,
  onClose
}: {
  /** The last selected row stays mounted while the drawer slides out. */
  row: MulliganRow | null
  pins: Pins
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const advice = row?.advice ?? null

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
      {advice && row && (
        <Box
          data-testid="mulligan-drilldown"
          data-card-id={advice.cardId}
          sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          <Box sx={{ ...BAR_SX, ...HAIRLINE_BOTTOM, px: GUTTER, pt: GUTTER, pb: 2, flexShrink: 0 }}>
            <Stack direction="row" alignItems="flex-start" spacing={2}>
              <CardArt hash={advice.bannerHash} name={advice.name} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <CostBadge cost={advice.cost} size={28} />
                  <Typography
                    variant="h6"
                    component="h2"
                    sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.3, minWidth: 0 }}
                  >
                    {advice.name}
                  </Typography>
                </Stack>
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{ mt: 1.25 }}
                  flexWrap="wrap"
                >
                  <BasisMark advice={advice} pins={pins} size="title" />
                  {advice.missing && advice.missing !== 'low-sample' && (
                    <MissingPill kind={advice.missing} />
                  )}
                </Stack>
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
                    {advice.keepRate ? (
                      <RateCell rate={advice.keepRate} label="保留率" anchor={null} emphasis />
                    ) : advice.dealt === 0 ? (
                      <MissingPill kind={advice.missing ?? 'unidentified'} />
                    ) : (
                      <SampleOnly
                        sample={keepSample(advice)}
                        what="保留率"
                        remaining={keepRemaining(advice)}
                      />
                    )}
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.disabled"
                    component="div"
                    sx={{ mt: 0.5, ...NUMERIC }}
                  >
                    發到 {advice.dealt} · 留 {advice.kept} · 換 {advice.dealt - advice.kept}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary" component="div">
                    留 vs 換
                  </Typography>
                  <Box sx={{ mt: 0.5 }}>
                    {advice.confidence !== 'hidden' && advice.keptWr && advice.swappedWr ? (
                      <Stack spacing={0.75}>
                        <RateCell rate={advice.keptWr} label="留下時的勝率" />
                        <RateCell rate={advice.swappedWr} label="換掉時的勝率" muted />
                      </Stack>
                    ) : advice.dealt === 0 ? (
                      <MissingPill kind={advice.missing ?? 'unidentified'} />
                    ) : (
                      <SampleOnly
                        sample={armsSample(advice)}
                        what="留 vs 換"
                        remaining={armsRemaining(advice)}
                      />
                    )}
                  </Box>
                  {advice.confidence !== 'hidden' && advice.diff !== null && (
                    <Box sx={{ mt: 0.75 }}>
                      <KeepDiffCell advice={advice} sortable={row.sortable} pins={pins} />
                    </Box>
                  )}
                </Box>
              </Box>
            </Section>

            <Section
              title="依其餘三張的費用"
              info={`${BAND_CAVEAT} 三段各自比、再合成一個數；一段裡只有留或只有換的，列在這裡但沒進估計。三段方向不一致的差，多半是雜訊。`}
            >
              {advice.bands.length > 0 ? (
                <Box
                  data-testid="mulligan-bands"
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 2,
                    overflow: 'hidden',
                    '& > :first-of-type': { borderTop: 'none' }
                  }}
                >
                  {advice.bands.map((band) => (
                    <BandLine key={band.band} band={band} />
                  ))}
                </Box>
              ) : (
                <NoBands advice={advice} pins={pins} />
              )}
            </Section>
          </Box>
        </Box>
      )}
    </Drawer>
  )
}
