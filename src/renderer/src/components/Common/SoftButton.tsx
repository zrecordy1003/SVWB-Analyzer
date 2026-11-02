import { Button, type ButtonProps } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import React from 'react'

/**
 * The app's button, in the restrained style of current desktop software: a
 * small rounded rectangle with a hairline border and a quiet fill. Hover only
 * brightens the fill - no glow, no movement - and keyboard focus gets a clear
 * ring, because a visible focus state is what actually separates a crafted
 * control from a decorated one.
 *
 *   tone      what the action is about. `danger` and `warning` colour the
 *             label, not the whole button, so a page with several actions
 *             stays calm until one of them needs to say "careful".
 *   emphasis  `soft` for ordinary actions; `solid` for the one action in a
 *             dialog that commits, so there is never doubt which button acts.
 *
 * Everything else is a normal MUI `Button` prop.
 */
export type SoftTone = 'neutral' | 'primary' | 'danger' | 'warning'

type Props = Omit<ButtonProps, 'variant' | 'color'> & {
  tone?: SoftTone
  emphasis?: 'soft' | 'solid'
}

function accent(t: Theme, tone: SoftTone): { main: string; text: string } {
  if (tone === 'danger') return { main: t.palette.error.main, text: t.palette.error.light }
  if (tone === 'warning') return { main: t.palette.warning.main, text: t.palette.warning.light }
  if (tone === 'primary') return { main: t.palette.primary.main, text: t.palette.primary.light }
  return { main: t.palette.common.white, text: t.palette.text.primary }
}

const SoftButton = React.forwardRef<HTMLButtonElement, Props>(function SoftButton(
  { tone = 'neutral', emphasis = 'soft', sx, ...rest },
  ref
) {
  return (
    <Button
      ref={ref}
      disableElevation
      disableRipple
      {...rest}
      sx={[
        (t) => {
          const a = accent(t, tone)
          const white = t.palette.common.white
          const solid = emphasis === 'solid'
          const base = solid
            ? {
                color: t.palette.getContrastText(a.main),
                bgcolor: a.main,
                borderColor: 'transparent',
                '&:hover': { bgcolor: alpha(a.main, 0.86) },
                '&:active': { bgcolor: alpha(a.main, 0.78) }
              }
            : tone === 'primary'
              ? {
                  color: a.text,
                  bgcolor: alpha(a.main, 0.14),
                  borderColor: alpha(a.main, 0.22),
                  '&:hover': { bgcolor: alpha(a.main, 0.2) },
                  '&:active': { bgcolor: alpha(a.main, 0.16) }
                }
              : {
                  // Neutral, danger and warning share the quiet surface; only
                  // the label (and, on hover, a hint of the tone) differs.
                  color: a.text,
                  bgcolor: alpha(white, 0.06),
                  borderColor: alpha(white, 0.1),
                  '&:hover': {
                    bgcolor: tone === 'neutral' ? alpha(white, 0.1) : alpha(a.main, 0.12),
                    borderColor: tone === 'neutral' ? alpha(white, 0.14) : alpha(a.main, 0.28)
                  },
                  '&:active': {
                    bgcolor: tone === 'neutral' ? alpha(white, 0.08) : alpha(a.main, 0.09)
                  }
                }
          return {
            minWidth: 0,
            height: 32,
            px: 1.5,
            borderRadius: '8px',
            border: '1px solid',
            textTransform: 'none',
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: 0,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            transition: t.transitions.create(['background-color', 'border-color', 'color'], {
              duration: 120
            }),
            ...base,
            '&.Mui-focusVisible': {
              outline: `2px solid ${alpha(t.palette.primary.main, 0.7)}`,
              outlineOffset: 2
            },
            '&.Mui-disabled': {
              color: t.palette.text.disabled,
              bgcolor: alpha(white, 0.03),
              borderColor: alpha(white, 0.06)
            },
            // The icon keeps its slot, so swapping a glyph for a spinner does
            // not nudge the label sideways.
            '& .MuiButton-startIcon': { ml: -0.25, mr: 0.75, width: 16, justifyContent: 'center' },
            '& .MuiButton-startIcon > *:nth-of-type(1)': { fontSize: 16 }
          }
        },
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
    />
  )
})

export default SoftButton
