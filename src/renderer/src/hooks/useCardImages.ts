import { useEffect, useState } from 'react'

/**
 * `settings.cardImages`, kept live.
 *
 * Every consumer used to read the setting once on mount. That held while pages
 * unmounted on every switch, but visited pages now stay mounted, so turning
 * card art on from a deck drawer left the other pages showing text rows until
 * the app restarted. Writes go through `setCardImages`, which tells every
 * mounted reader in this window.
 */
const CHANGED_EVENT = 'svwb:card-images-changed'

export async function setCardImages(on: boolean): Promise<void> {
  await window.settings.set('settings.cardImages', on)
  window.dispatchEvent(new CustomEvent<boolean>(CHANGED_EVENT, { detail: on }))
}

export function useCardImages(): boolean {
  const [on, setOn] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.settings
      .get('settings')
      .then((settings) => {
        if (!cancelled) setOn(Boolean(settings?.cardImages))
      })
      .catch(() => {})
    const onChanged = (event: Event): void => setOn(Boolean((event as CustomEvent).detail))
    window.addEventListener(CHANGED_EVENT, onChanged)
    return () => {
      cancelled = true
      window.removeEventListener(CHANGED_EVENT, onChanged)
    }
  }, [])

  return on
}
