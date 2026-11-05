import { useEffect } from 'react'

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

type HitRect = { x: number; y: number; width: number; height: number }

function measureHitRects(): HitRect[] {
  // An open popover or select menu owns the whole viewport through an invisible
  // backdrop. Without this the click that is supposed to dismiss it would land
  // in the game instead, leaving the panel open with no way to close it.
  if (document.querySelector('.MuiModal-root') !== null) {
    return [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }]
  }

  const rects: HitRect[] = []
  for (const node of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    const rect = node.getBoundingClientRect()
    // Anything currently unrendered - a collapsed panel, a control behind a
    // layout switch - measures zero and is not on screen to be hit.
    if (rect.width === 0 || rect.height === 0) continue
    rects.push({
      x: Math.floor(rect.left - HIT_SLOP),
      y: Math.floor(rect.top - HIT_SLOP),
      width: Math.ceil(rect.width + HIT_SLOP * 2),
      height: Math.ceil(rect.height + HIT_SLOP * 2)
    })
  }
  return rects
}

/**
 * Make the HUD click-through everywhere except over its own controls.
 *
 * This reports where the controls are; main reads the cursor and decides (see
 * `updateHudPointerPassthrough` in `windows/hud.ts`). The page cannot decide for
 * itself, because while the window lets the pointer through it receives no
 * pointer events to decide with.
 *
 * Re-measured whenever the layout can have moved - the DOM changed, an element
 * resized, something scrolled - at most once a frame, and sent only when the
 * answer is different.
 */
export function usePointerPassthrough(): void {
  useEffect(() => {
    let last = ''
    let frame = 0

    const report = (): void => {
      frame = 0
      const rects = measureHitRects()
      const key = JSON.stringify(rects)
      if (key === last) return
      last = key
      void window.hud?.setHitRects?.(rects)?.catch((error) => {
        // Forget what was sent, so the next change retries rather than
        // assuming main has areas it never received.
        last = ''
        console.warn('[HUD] failed to report clickable areas:', error)
      })
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(report)
    }

    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
    const sizes = new ResizeObserver(schedule)
    sizes.observe(document.documentElement)
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    // Transitions move things without touching the DOM after they start.
    document.addEventListener('transitionend', schedule, true)
    report()

    return () => {
      if (frame) cancelAnimationFrame(frame)
      mutations.disconnect()
      sizes.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
      document.removeEventListener('transitionend', schedule, true)
    }
  }, [])
}
