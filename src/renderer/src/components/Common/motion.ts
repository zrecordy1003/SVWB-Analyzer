/**
 * The app's motion, in three speeds and one curve.
 *
 * Durations used to be picked per file - 120, 140, 150, 160, 180, 200, 220,
 * 250, 300, 320, 360ms, with three different easings - so two controls that do
 * the same kind of thing moved at visibly different speeds. Pick by what is
 * moving, not by feel:
 *
 *   fast  120ms  colour and opacity on hover, press and focus
 *   base  180ms  a thing appearing or changing state: tooltips, chips, rows
 *   slow  240ms  a thing travelling across the screen: the sidebar selection,
 *                rows re-sorting, panels resizing
 *
 * Longer than 240ms reads as the interface being slow, not as motion.
 * `prefers-reduced-motion` is handled once, globally, in the theme.
 */
export const MOTION = {
  fast: 120,
  base: 180,
  slow: 240
} as const

/** Decelerate: starts quick, settles gently - right for things arriving or reacting. */
export const EASE = 'cubic-bezier(0.2, 0, 0, 1)'

/** `transition` for the given properties at one speed, e.g. `motion(['opacity'], 'fast')`. */
export function motion(properties: readonly string[], speed: keyof typeof MOTION = 'base'): string {
  return properties.map((p) => `${p} ${MOTION[speed]}ms ${EASE}`).join(', ')
}
