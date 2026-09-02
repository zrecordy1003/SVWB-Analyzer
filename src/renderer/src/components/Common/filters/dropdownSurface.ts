/**
 * One surface for every dropdown the analyzer opens - the mode picker and the
 * ＋ 新增條件 menu - so two menus a few pixels apart cannot look like they came
 * from different apps.
 *
 * MUI's default menu is a square, elevation-shaded slab: on this dark theme the
 * elevation overlay paints it a lighter grey than the toolbar it drops out of,
 * and the items run edge to edge with a full-bleed hover. These override both.
 */
import type { SxProps, Theme } from '@mui/material'

export const DROPDOWN_PAPER_SX: SxProps<Theme> = {
  mt: 0.75,
  borderRadius: 2.5,
  border: '1px solid',
  borderColor: 'divider',
  // Kills the theme's elevation overlay: the menu should read as the same
  // material as the toolbar, lifted by its shadow rather than by being paler.
  backgroundImage: 'none',
  backgroundColor: 'background.paper',
  boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
  '& .MuiList-root': { py: 0.5, px: 0.5 }
}

/** Inset, rounded rows - the hover lands on a pill, not on the whole width. */
export const DROPDOWN_ITEM_SX: SxProps<Theme> = {
  borderRadius: 1.5,
  minHeight: 36,
  px: 1,
  gap: 1,
  my: 0.25,
  transition: 'background-color .15s'
}

/**
 * The trigger these dropdowns hang off: a soft filled pill, not a form field.
 *
 * `ClassSelect` and `ModeSelect` each carry this same block inline, and it is
 * what the whole app's controls look like - the search box, the segmented
 * controls, the range buttons. Named here so a new control can look like the
 * existing ones without being a fourth copy of it, and so a form built out of
 * MUI's outlined-with-floating-label defaults (which nothing else in the app
 * uses) is an obvious mismatch rather than a plausible choice.
 *
 * Apply to a `Select` directly, or to a `TextField` as
 * `{ '& .MuiOutlinedInput-root': CONTROL_SX }`.
 */
export const CONTROL_SX = {
  height: 36,
  borderRadius: 2,
  bgcolor: 'action.hover',
  transition: 'background-color .15s',
  '&:hover': { bgcolor: 'action.selected' },
  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'divider' },
  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'text.disabled' },
  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderWidth: 1 },
  '& .MuiSelect-icon': { transition: 'transform .2s', color: 'text.secondary' }
} as const
