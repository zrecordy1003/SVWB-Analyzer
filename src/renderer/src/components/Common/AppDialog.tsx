/**
 * The shell every modal in the app is built from.
 *
 * Before this existed each dialog dressed itself. Some were bare MUI - grey
 * `#121212` paper, a plain `DialogTitle`, square-ish corners - and some had
 * bespoke gradients and radii, so opening two of them in one session looked
 * like using two different applications. Consistency is not something you can
 * ask nine files to remember; it has to be the only easy way to build one.
 *
 * So the chrome lives here and nothing else styles a `Dialog`: the surface, the
 * corner radius, the header, the separators, the footer, and where the close
 * button goes. Callers supply content and actions. Anything a caller genuinely
 * needs to vary - the accent on the update dialog, a chips row under a deck's
 * name - is a prop rather than a reason to hand-roll another one.
 */
import {
  Box,
  Dialog,
  DialogActions,
  DialogContent,
  IconButton,
  Stack,
  Typography,
  type DialogProps
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import React from 'react'

import { HAIRLINE_BOTTOM, SURFACE_SX } from './surfaces'

/**
 * The padding every dialog shares, in theme spacing units.
 *
 * One number rather than a per-dialog choice: header, body and footer have to
 * line up on the same left edge, and they only do that by accident when three
 * different files pick their own.
 */
const GUTTER = 2.5

/**
 * The accent for a dialog whose affirmative button destroys something.
 *
 * Named and shared rather than picked per dialog: "am I about to lose data"
 * is the one question a modal has to answer before it is read, and it cannot
 * answer it if delete confirmations are three slightly different reds.
 */
export const DANGER_ACCENT = '#f2545b'

export type AppDialogProps = {
  open: boolean
  /** Called for the close button, the backdrop and Escape alike. */
  onClose: () => void
  /**
   * Omit for a dialog that needs no heading - one whose content already labels
   * itself. The close button then floats over the content instead of sitting in
   * a header row of its own.
   */
  title?: React.ReactNode
  /** A quieter second line under the title: which deck, which version. */
  subtitle?: React.ReactNode
  /**
   * A leading square tile, for dialogs whose whole point is a state: an update
   * that failed, a deck about to be deleted. Skipped when a heading alone says
   * enough - an icon on every dialog is decoration, not information.
   */
  icon?: React.ReactNode
  /** Tints the icon tile and the header wash. Left alone, the header is neutral. */
  accent?: string
  /** Sits under the title inside the header - a chips row, a status line. */
  headerExtra?: React.ReactNode
  /** Footer buttons. The footer is not drawn at all when there are none. */
  actions?: React.ReactNode
  /**
   * While true, the dialog cannot be dismissed and the close button is
   * disabled. For work that would be left half-done - a save, a publish.
   */
  busy?: boolean
  /**
   * Ignores the backdrop and Escape, leaving the close button and the footer as
   * the only ways out. For a form with unsaved edits in it, where a stray click
   * beside the dialog would throw the work away.
   */
  disableBackdropClose?: boolean
  maxWidth?: DialogProps['maxWidth']
  /**
   * Raises the whole dialog above something that already floats - a Drawer the
   * dialog was opened from, which otherwise paints over it.
   */
  zIndex?: number
  /** Escape hatch for the body only; the chrome is not negotiable. */
  contentSx?: DialogProps['sx']
  children?: React.ReactNode
}

export default function AppDialog({
  open,
  onClose,
  title,
  subtitle,
  icon,
  accent,
  headerExtra,
  actions,
  busy = false,
  disableBackdropClose = false,
  maxWidth = 'sm',
  zIndex,
  contentSx,
  children
}: AppDialogProps): React.JSX.Element {
  const closeButton = (
    <IconButton
      onClick={onClose}
      disabled={busy}
      size="small"
      aria-label="關閉"
      sx={{
        color: 'text.secondary',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' }
      }}
    >
      <CloseIcon fontSize="small" />
    </IconButton>
  )

  return (
    <Dialog
      open={open}
      onClose={busy || disableBackdropClose ? undefined : onClose}
      maxWidth={maxWidth}
      fullWidth
      sx={zIndex === undefined ? undefined : { zIndex }}
      slotProps={{
        paper: {
          elevation: 0,
          sx: {
            ...SURFACE_SX,
            // An accent belongs to the dialog's whole surface, not to a band
            // across its top: a tinted strip reads as a banner inside the
            // dialog rather than as the mood of the dialog itself.
            ...(accent
              ? {
                  backgroundImage: `linear-gradient(160deg, ${accent}1f 0%, rgba(255,255,255,0.03) 32%, rgba(255,255,255,0) 60%)`
                }
              : null)
          }
        }
      }}
    >
      {title === undefined ? (
        // Titleless: the close control floats so it costs no vertical space,
        // and the body keeps the same top padding a header would have left.
        <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 1 }}>{closeButton}</Box>
      ) : (
        <Box sx={{ ...HAIRLINE_BOTTOM, px: GUTTER, pt: GUTTER, pb: 1.75, flexShrink: 0 }}>
          <Stack direction="row" alignItems="flex-start" spacing={1.5}>
            {icon && (
              <Box
                sx={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 2,
                  flexShrink: 0,
                  color: accent ?? 'text.secondary',
                  bgcolor: accent ? `${accent}24` : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${accent ? `${accent}3d` : 'rgba(255,255,255,0.08)'}`
                }}
              >
                {icon}
              </Box>
            )}

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="h6"
                component="div"
                sx={{ fontWeight: 800, lineHeight: 1.3, fontSize: 17 }}
                noWrap
              >
                {title}
              </Typography>
              {subtitle && (
                <Typography
                  variant="caption"
                  sx={{ display: 'block', color: 'text.secondary', mt: 0.25 }}
                  noWrap
                >
                  {subtitle}
                </Typography>
              )}
              {headerExtra && <Box sx={{ mt: 1 }}>{headerExtra}</Box>}
            </Box>

            {closeButton}
          </Stack>
        </Box>
      )}

      <DialogContent
        sx={{
          px: GUTTER,
          // A titleless dialog has no header to sit under, so it supplies the
          // space itself - and leaves room for the floating close button.
          pt: title === undefined ? 3 : 2,
          pb: actions ? 2 : GUTTER,
          ...contentSx
        }}
      >
        {children}
      </DialogContent>

      {actions && (
        <DialogActions
          sx={{
            px: GUTTER,
            py: 1.75,
            gap: 1,
            flexShrink: 0,
            // Same hairline as the header, mirrored: the two frame the body
            // instead of MUI's full-strength `dividers` rules, which on this
            // dark surface read as bright lines drawn across the dialog.
            position: 'relative',
            '&::before': {
              content: '""',
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              height: '1px',
              pointerEvents: 'none',
              background:
                'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.11) 10%, rgba(255,255,255,0.11) 90%, transparent 100%)'
            },
            // MUI indents the first button by default, which pulls the footer
            // out of line with the gutter every other row uses.
            '& > :not(style) ~ :not(style)': { ml: 0 }
          }}
        >
          {actions}
        </DialogActions>
      )}
    </Dialog>
  )
}
