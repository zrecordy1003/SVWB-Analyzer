/**
 * Whether the header is being dragged.
 *
 * The release has to end the drag exactly once whichever way it arrives -
 * pointer up, pointer cancel, or the capture being taken away without either.
 * A drag main never hears the end of leaves it holding the pointer and stops
 * the HUD following the game's focus, so every exit path calls `endHudDrag`
 * and this keeps the second and third calls harmless.
 */
let dragging = false

export function isHudDragging(): boolean {
  return dragging
}

export function beginHudDrag(): void {
  dragging = true
  void window.hud?.dragStart?.()
}

export function endHudDrag(): void {
  if (!dragging) return
  dragging = false
  void window.hud?.dragEnd?.()
}
