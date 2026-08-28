import { useCallback, useEffect, useRef } from 'react'

/**
 * Everything the user is meant to be able to hit. The rest of the HUD is
 * reading material, and reading material sitting on top of a game should not be
 * intercepting clicks aimed at it.
 *
 * `data-hud-interactive` covers the parts built out of plain boxes rather than
 * real controls - the title row, the day chips - which no element selector can
 * recognise.
 */
const INTERACTIVE_SELECTOR = [
  '[data-hud-interactive]',
  'a',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="slider"]',
  '.MuiSlider-root',
  '.MuiSwitch-root'
].join(',')

/**
 * Windows only repaints the cursor on the next pointer movement, so the frame
 * in which the events are handed back still shows whatever the game was
 * drawing. Claiming the pointer a few pixels early means that repaint happens
 * before it reaches the control, rather than on top of it.
 */
const HIT_SLOP = 8

function isOverControl(x: number, y: number): boolean {
  // An open popover or select menu owns the whole viewport through an invisible
  // backdrop. Without this the click that is supposed to dismiss it would land
  // in the game instead, leaving the panel open with no way to close it.
  if (document.querySelector('.MuiModal-root') !== null) return true

  for (const node of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    const rect = node.getBoundingClientRect()
    // Anything currently unrendered - a collapsed panel, a control behind a
    // layout switch - measures zero and is not on screen to be hit.
    if (rect.width === 0 || rect.height === 0) continue
    if (
      x >= rect.left - HIT_SLOP &&
      x <= rect.right + HIT_SLOP &&
      y >= rect.top - HIT_SLOP &&
      y <= rect.bottom + HIT_SLOP
    ) {
      return true
    }
  }
  return false
}

/**
 * Make the HUD click-through everywhere except over its own controls.
 *
 * The window ignores mouse events but is asked to keep forwarding moves, so
 * this can watch where the pointer is and hand the events back for exactly as
 * long as it sits on something clickable.
 */
export function usePointerPassthrough(): void {
  // What main was last told. Every pointer move would otherwise be an IPC call.
  const ignoringRef = useRef<boolean | null>(null)

  const apply = useCallback((ignore: boolean): void => {
    if (ignoringRef.current === ignore) return
    ignoringRef.current = ignore
    void window.hud?.setIgnoreMouse?.(ignore)?.catch((error) => {
      // Leave the cache cleared so the next move retries rather than assuming a
      // state main never reached.
      ignoringRef.current = null
      console.warn('[HUD] failed to update pointer passthrough:', error)
    })
  }, [])

  useEffect(() => {
    // Forwarded moves carry no meaningful target, so the hit test has to work
    // from coordinates rather than `event.target`.
    const onMove = (event: MouseEvent): void => apply(!isOverControl(event.clientX, event.clientY))
    // Once the pointer is gone there is nothing to hold the events for, and no
    // further moves will arrive to work that out.
    const release = (): void => apply(true)

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseleave', release)
    window.addEventListener('blur', release)
    apply(true)

    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseleave', release)
      window.removeEventListener('blur', release)
    }
  }, [apply])
}
