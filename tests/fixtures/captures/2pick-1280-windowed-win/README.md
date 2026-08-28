# 2pick-1280-windowed-win

Frames from a 1063s **1282x752 windowed** 2Pick recording, a win. The first
2Pick material at anything other than 1920x1080 fullscreen, so it is what makes
the versus probe's evidence cross-scale rather than single-capture.

| file | what it is |
| --- | --- |
| `01-versus-2pick-label.png` | versus screen: 「2Pick階級」 on both rows, bishop vs witch, first |
| `02-result-anchor-says-ranked.png` | result screen 2s in: banner up, 2Pick label absent, anchor reads `bp` |
| `03-result-2pick-label-late.png` | 9s in: the label has finally rotated in |

1282x752 is a real window — 2px of border and 32px of title bar — so these
exercise the chrome crop as well as the scale.

## What it confirmed

The versus probe needed no adjustment at this scale. Measured over a 12s sample
at 2fps: own 0.110–0.908, enemy −0.062–0.899, and the hits form **one contiguous
run of 15 frames** with sharp edges — nothing between 0.4 and 0.85, so the
transition is a screen appearing, not a signal degrading. Fifteen frames is 7.5
seconds, against a debounce that asks for two.

Peak scores are lower than fullscreen's 0.962–1.000, which is expected: the
template was cut from a fullscreen canvas and the windowed capture resamples
differently. 0.908 against a 0.7 threshold is ample margin, and cutting a second
per-scale template would buy nothing.

The BP window carried over cleanly too, reading 「+130」 — a different value from
the fullscreen recording's 「+100」, so the layout agreement is real and not a
coincidence of one number's width.

## What it repeated

The result screen's trap, in a second independent capture:

| moment | t |
| --- | --- |
| WIN banner crosses threshold | ~1044.5s |
| score-system anchor reads `bp` (0.72–0.75) | 1044.5–1046.5s |
| 2Pick階級 readable (0.94) | **~1053.5s, 9s later** |

Nine seconds, where the fullscreen win took fifteen. Both are delays that
`timing::MODE_SETTLE` was guessed at rather than derived, and this one would have
squeaked inside it — which is precisely why the mode is not decided there.

## An incidental observation

The WIN banner is not continuously above threshold on this screen; it dips below
for several seconds around 1053–1060s and comes back. The machine already
records the outcome on first sight, so this costs nothing, but a future probe
that assumes the banner is stable while the screen is up would be wrong.
