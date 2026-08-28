# 2pick-1920-fullscreen-win

Frames from a 1052s 1920x1080 fullscreen 2Pick recording, a win. The second
2Pick recording, and the one that moved the mode decision off the result screen
entirely.

| file | what it is |
| --- | --- |
| `01-versus-2pick-label.png` | versus screen: 「2Pick階級」 on both players' rows, play-order overlay up |
| `02-result-rank-up-bp-only.png` | result screen 5s in: no 2Pick label yet, and 「BP 100」 reads as the ranked label |
| `03-result-2pick-label-late.png` | the 2Pick label finally lands, 15s after the banner |

## What it proved wrong

`2pick-1920-fullscreen-lose` established that the reward carousel takes 5.5s to
show 2Pick階級, and `timing::MODE_SETTLE` was set to 12s to cover it. This
recording is a **win**, and a win runs a RANK UP animation first:

| moment | t |
| --- | --- |
| WIN banner crosses threshold | 1033s |
| RANK UP animation | 1035–1039s |
| 2Pick階級 finally readable (0.82) | **1048s — 15s later** |

Fifteen seconds is past every grace the machine has, and stretching one to fit
would only invite a third recording to break it.

Worse, the gap is not empty. Through it the screen shows its own 「BP 100」,
which matches the ranked 「BP :」 template at **0.757–0.787 across nine
consecutive frames**. So the result screen does not merely fail to say 2Pick —
it says *ranked*, confidently, repeatedly, and for long enough to defeat any
debounce. This recording originally replayed as `mode: ranked`, with
`MODES_2PICK` and `MODE_SETTLE` already fixed.

## What replaced it

The versus screen carries 「2Pick階級」 on **both** players' rows, on the frame
that opens the match — see `TWO_PICK_VERSUS_OWN`. Measured over 16 frames of the
versus sequence: own row 0.962–1.000, enemy row 0.851–0.870, present on every
frame including all of them that complete a `versus` reading. Against the 37
pre-existing fixtures the same probe peaks at 0.398.

Two consequences followed:

- The mode is now settled as the battle opens rather than inferred ten minutes
  later, so it no longer depends on how long an animation runs.
- The score-system anchor's ranked signal dropped from `Authoritative` to
  `Strong`. It cannot tell a 2Pick result screen from a ranked one, so it must
  not be able to overrule something that can.

`MODES_2PICK` is kept as corroboration, not as the evidence the mode rests on.

## What it also unblocked

The per-match BP gain. In the lose recording the user's HUD sat over
「獲得BP +N」; here it does not, so `BP_LAYOUT_2PICK` could be measured at last:
value at x1117-1163, y274-290. The line is left-aligned at a fixed position —
「獲」, 「得」 and "B" land on identical columns in both recordings despite one
showing +0 and the other +100 — so the window's slack goes to the right, where a
longer number grows, stopping short of the ⓘ badge at x1182.
