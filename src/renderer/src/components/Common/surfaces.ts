/**
 * The app's surface ramp: page, dialog, panel, bar, separator.
 *
 * MUI's dark palette builds every raised surface out of `rgba(255,255,255,…)`
 * over `#121212`, which is neutral grey by construction - correct, and flat and
 * lifeless next to card art. These replace that with a slightly blue-cool ramp
 * plus a hairline top highlight, so panels read as lit from above rather than as
 * translucent white laid over black.
 *
 * Defined as plain `sx` objects rather than a theme override: the rest of the
 * app already looks the way it looks, and quietly restyling every Paper in it
 * from here would be a much bigger change than the one that was asked for.
 * `AppDialog` is what applies them consistently to every modal.
 */
import type { CSSObject } from '@mui/material'

// A plain style object, not `SxProps`: that type is a union which also admits
// arrays and callbacks, so spreading one into another sx object does not
// typecheck. Everything here is meant to be spread.
type Surface = CSSObject

/** The page itself - the deepest layer, behind everything. */
export const CANVAS_BG =
  'radial-gradient(120% 100% at 50% 0%, #1a2030 0%, #10141d 55%, #0b0e15 100%)'

/**
 * A dialog or full-screen sheet sitting on the canvas.
 *
 * Lighter than the page behind it, not darker. At `#141926` it sat within a
 * few percent of the canvas and read as part of the background rather than as
 * something on top of it; a dialog has to look like it is nearer the viewer.
 */
export const SURFACE_SX: Surface = {
  backgroundColor: '#1b2233',
  backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0) 120px)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 3,
  boxShadow: '0 28px 72px -12px rgba(0,0,0,0.85)'
}

/** A panel inside a surface: one step lighter, with the same top highlight. */
export const PANEL_SX: Surface = {
  backgroundColor: 'rgba(255,255,255,0.028)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 2
}

/** A bar that frames content - a header or footer - one step darker than the surface. */
export const BAR_SX: Surface = {
  backgroundColor: 'rgba(9,12,18,0.72)',
  backdropFilter: 'blur(8px)'
}

/**
 * A separator, as a gradient that fades out at both ends.
 *
 * A plain `borderBottom` runs edge to edge at full strength, which on a dark
 * surface reads as a bright rule drawn across the window - it is the line, not
 * the content, that catches the eye. Fading the ends lets it separate two areas
 * without announcing itself.
 *
 * Drawn as a pseudo-element rather than a border so it does not take part in
 * layout: swapping a border for this one does not shift anything by a pixel.
 */
const hairline = (direction: 'bottom' | 'right'): Surface => {
  const vertical = direction === 'right'
  return {
    position: 'relative',
    '&::after': {
      content: '""',
      position: 'absolute',
      pointerEvents: 'none',
      ...(vertical
        ? { top: 0, bottom: 0, right: 0, width: '1px' }
        : { left: 0, right: 0, bottom: 0, height: '1px' }),
      background: `linear-gradient(${vertical ? '180deg' : '90deg'}, transparent 0%, rgba(255,255,255,0.11) 10%, rgba(255,255,255,0.11) 90%, transparent 100%)`
    }
  }
}

export const HAIRLINE_BOTTOM = hairline('bottom')
export const HAIRLINE_RIGHT = hairline('right')

/**
 * A card cell in the pool grid.
 *
 * Nearly black so the artwork is the brightest thing in the cell, which is the
 * point of the grid; the border is what carries state.
 */
export const CARD_CELL_SX: Surface = {
  backgroundColor: 'rgba(0,0,0,0.35)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 1.5
}
