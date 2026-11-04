/**
 * The header's recognition status: one pill, toolbar height.
 *
 * It used to be a red 「偵測暫停中」 whenever no frame was arriving - with the
 * game simply closed too, which is the normal state - a forever-pulsing ring
 * for 「偵測中」, and in battle two 150×50 slanted class slabs taller than the
 * toolbar with a 先攻 chip pinned on by pixel offsets. Now:
 *
 * - Outside a battle: a dot in the state's tone and a short label. The reason
 *   and the next step are in the tooltip. The state comes from
 *   `captureStateOf`, the same function behind the sidebar badge, so the two
 *   can no longer disagree.
 * - In a battle: the matchup itself - both class emblems, 先攻 or 後攻, and the
 *   mode once it is known - at the same height as everything else in the bar.
 */
import React, { useEffect, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'

import ClassIcon from '@renderer/components/Common/ClassIcon'
import { TOOLTIP_SURFACE_SX } from '@renderer/components/Common/tooltipSurface'
import { captureStateOf, type CaptureTone } from '@renderer/components/captureState'
import { useSvwbStatus } from '@renderer/hooks/useSvwbStatus'
import { invokeIpc } from '@renderer/ipc'
import { classesMap, modesMap } from '@renderer/map/classMap'
import type { BattleStatus as BattleState } from '@shared/types'

const TONE_COLOR: Record<CaptureTone, string> = {
  idle: 'rgba(255,255,255,0.38)',
  ok: '#5cc98a',
  warn: '#f0b450',
  error: '#f2545b'
}

const IDLE_BATTLE: BattleState = {
  inBattle: false,
  ownClass: null,
  enemyClass: null,
  playOrder: null,
  // `null` is the correct resting value and a meaningful one: see the field's
  // own comment in `@shared/types`.
  mode: null
}

const PILL_SX = {
  height: 36,
  px: 1.5,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 1,
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.08)',
  bgcolor: 'rgba(255,255,255,0.04)',
  whiteSpace: 'nowrap'
} as const

/**
 * The state dot. Only 偵測中 breathes - it is the one state where something is
 * actively happening - and it stops for anyone who asked for less motion.
 */
const Dot: React.FC<{ tone: CaptureTone }> = ({ tone }) => (
  <Box
    component="span"
    sx={{
      width: 8,
      height: 8,
      borderRadius: '50%',
      flexShrink: 0,
      bgcolor: TONE_COLOR[tone],
      ...(tone === 'ok'
        ? {
            animation: 'svwbStatusBreathe 2.4s ease-in-out infinite',
            '@keyframes svwbStatusBreathe': {
              '0%, 100%': { boxShadow: '0 0 0 0 rgba(92,201,138,0.45)' },
              '50%': { boxShadow: '0 0 0 4px rgba(92,201,138,0)' }
            },
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' }
          }
        : null)
    }}
  />
)

const Side: React.FC<{ id: BattleState['ownClass'] }> = ({ id }) => (
  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
    <ClassIcon id={id} size={22} />
    <Typography component="span" sx={{ fontSize: 14, fontWeight: 600 }}>
      {id ? (classesMap[id]?.label ?? '—') : '辨識中'}
    </Typography>
  </Box>
)

const BattleStatus = (): React.JSX.Element => {
  const status = useSvwbStatus()
  const capture = captureStateOf(status)
  const capturing = capture.kind === 'watching' || capture.kind === 'badResolution'
  const [battle, setBattle] = useState<BattleState>(IDLE_BATTLE)

  useEffect(() => {
    return window.electron?.ipcRenderer.on('battle:status', (_e, msg: BattleState) =>
      setBattle(msg)
    )
  }, [])

  // `battle:status` only fires on a change, so a header that mounts mid-battle
  // (a reload) asks once instead of waiting for the next one.
  useEffect(() => {
    if (!capturing) return
    void invokeIpc('battle:getStatus')
      .then((state) => {
        // `undefined` when the analyzer has not started: nothing to describe.
        if (state) setBattle(state)
      })
      .catch(() => {})
  }, [capturing])

  const inBattle = capturing && battle.inBattle
  const mode = battle.mode ? modesMap[battle.mode]?.label : null
  const order =
    battle.playOrder === 'first' ? '先攻' : battle.playOrder === 'second' ? '後攻' : null

  const tooltip = inBattle ? (
    <Box sx={{ maxWidth: 280 }}>
      <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
        對戰中
      </Typography>
      <Typography variant="body2" color="text.secondary">
        對戰結束後會自動記錄這場對局
        {battle.mode ? '' : '；階級對戰的模式要到結算畫面才會確定'}。
      </Typography>
    </Box>
  ) : (
    <Box sx={{ maxWidth: 300 }}>
      <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
        {capture.label}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {capture.detail}
      </Typography>
    </Box>
  )

  return (
    <Tooltip
      title={tooltip}
      placement="bottom-end"
      slotProps={{ tooltip: { sx: TOOLTIP_SURFACE_SX } }}
    >
      <Box role="status" aria-live="polite" sx={PILL_SX}>
        <Dot tone={inBattle ? 'ok' : capture.tone} />
        {inBattle ? (
          <>
            <Side id={battle.ownClass} />
            <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
              vs
            </Typography>
            <Side id={battle.enemyClass} />
            {(order || mode) && (
              <Typography
                component="span"
                sx={{
                  fontSize: 12,
                  color: 'text.secondary',
                  pl: 1,
                  ml: 0.25,
                  borderLeft: '1px solid rgba(255,255,255,0.12)'
                }}
              >
                {[order, mode].filter(Boolean).join(' · ')}
              </Typography>
            )}
          </>
        ) : (
          <Typography component="span" sx={{ fontSize: 13, fontWeight: 600 }}>
            {capture.label}
          </Typography>
        )}
      </Box>
    </Tooltip>
  )
}

export default React.memo(BattleStatus)
