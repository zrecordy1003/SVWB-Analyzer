/**
 * A class emblem, as the game draws it.
 *
 * The picture comes from `svwb-card://class/<id>.svg`, which means the main
 * process fetches it from the portal on first use and caches it on this
 * machine - see `src/main/data/classIcons.ts`. Nothing here knows that. To this
 * component it is an ordinary image that may or may not turn up.
 *
 * # Three rules it exists to keep
 *
 * **The artwork is never modified.** Cygames' guidelines permit proportional
 * scaling and nothing else - no recolouring, no cropping, no filters. So there
 * is no mask, no `filter`, no tinting here, and the box only ever scales the
 * emblem inside it.
 *
 * **It sits directly on the surface.** An earlier version put every emblem on a
 * light plate, because the fills are drawn for the portal's light pages and
 * nightmare's #8d1e41 is barely 2:1 against this app's near-black. A plate does
 * fix that, and forty of them down a match list looks like spilt confetti. The
 * app is dark and stays dark: the dimmer two are accepted, and the class NAME
 * next to the emblem is what actually has to be legible. If an emblem ever has
 * to carry meaning with no name beside it, that is the moment to reconsider.
 *
 * **It degrades to the swatch.** The emblem is absent whenever card images are
 * switched off, the portal is unreachable, or it simply has not been fetched
 * yet, and in all three cases the handler answers with a 1x1 transparent pixel
 * rather than an error. So `onLoad` fires either way and `onError` never does;
 * what tells the two apart is the size. Until a real one arrives this draws the
 * small coloured square the app used before emblems existed - deliberately
 * small rather than a `size`-filling block, so that switching images off leaves
 * a UI that looks like the old one instead of a grid of colour chips.
 *
 * **`onLoad` alone is not enough to know it arrived.** The handler serves the
 * emblems with `max-age=86400`, so the second and later `<img>` for a class in
 * a session are answered from Chromium's cache - and an image that is already
 * complete when React attaches the handler has had its `load` event and will
 * not fire another. That is why the ref below checks `complete` as well: a
 * class the user had already looked at (the dropdown's own selected value, the
 * emblem repeated down a list) would otherwise sit at opacity 0 forever behind
 * the fallback square, which is exactly the bug this pairing fixes.
 */
import { Box } from '@mui/material'
import React from 'react'

import { classTone } from './classTone'

/** Real emblems are 270-444px on their long edge; the blank fallback is 1x1. */
const isRealEmblem = (img: HTMLImageElement): boolean => img.naturalWidth > 2

/** How much of the box the fallback square takes. Tuned to land near 8px at the list size. */
const SWATCH_FRACTION = 0.42

export default function ClassIcon({
  id,
  size = 20,
  tone,
  dim = false
}: {
  /** A `classMap` id - `elf`, `royal`, … `neutral` also has an emblem. */
  id: string | null | undefined
  size?: number
  /** Overrides the fallback swatch colour, for rows that are not really a class. */
  tone?: string
  /** Held back, the way the heatmap holds back a matchup with no games. */
  dim?: boolean
}): React.JSX.Element {
  const colour = tone ?? classTone(id)

  // A null id is "all classes" or "unclassified" - there is no emblem to ask
  // for, and asking would spend a protocol round trip to be told so.
  const name = id ? String(id) : null

  /**
   * Which class's real emblem is on screen, rather than a bare boolean.
   *
   * Keyed by name so a change of class cannot leave the previous emblem
   * showing for a frame: `loaded` goes false the moment `name` changes,
   * during the same render, with no effect needed to reset it.
   */
  const [shown, setShown] = React.useState<string | null>(null)
  const loaded = name !== null && shown === name

  const settle = React.useCallback(
    (img: HTMLImageElement | null): void => {
      // Ref callbacks run after the props - `src` included - are on the node,
      // and re-run on every `name` change because this identity depends on it.
      // A fresh fetch is not complete yet and is left to `onLoad`; a cached one
      // already is, and this is its only chance to be noticed.
      if (!img || !img.complete) return
      setShown(isRealEmblem(img) ? name : null)
    },
    [name]
  )

  const swatch = Math.max(6, Math.round(size * SWATCH_FRACTION))

  return (
    <Box
      sx={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: dim ? 0.3 : 1
      }}
    >
      {!loaded && (
        <Box
          sx={{ width: swatch, height: swatch, borderRadius: '2px', bgcolor: colour }}
          // Square, not a circle: the charts mark classes with squares, and
          // this is the same mark those legends have always used.
        />
      )}
      {name && (
        <Box
          component="img"
          ref={settle}
          src={`svwb-card://class/${name}.svg`}
          alt=""
          // Decoration: the class NAME is beside it everywhere this is used, so
          // a screen reader reading this out would only repeat itself.
          aria-hidden
          draggable={false}
          onLoad={(e: React.SyntheticEvent<HTMLImageElement>) =>
            setShown(isRealEmblem(e.currentTarget) ? name : null)
          }
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            // The emblems' aspect ratios run from 4:3 to 2:3, so a square box
            // has to contain rather than fill - stretching one is a
            // modification, and the guidelines allow scaling only in proportion.
            objectFit: 'contain',
            opacity: loaded ? 1 : 0
          }}
        />
      )}
    </Box>
  )
}
