# 2pick-1920-fullscreen-lose

Frames from a 1083s 1920x1080 fullscreen 2Pick recording, a loss. The first
2Pick material the project has had — every 2Pick constant before it was carried
over from the old pipeline untested and marked UNVERIFIED, and both of the ones
this recording could check turned out to be wrong.

| file | what it is |
| --- | --- |
| `01-result-2pick-label.png` | result screen with 2Pick階級 settled at (783,268), score 0.840 |
| `02-result-carousel-other-reward.png` | same screen ~2s earlier: banner readable, 2Pick panel not yet rotated in |
| `03-battle.png` | mid-battle, a negative for every probe |

## What the recording established

**The reward strip is a carousel.** 對戰通行證 and the other rewards rotate
through first; 2Pick階級 arrives last, measured at 5.5s after the result banner,
and then holds. Sampled at 4fps the label is absent for 17 frames and present
for the following 22, pinned at (783,268).

Two defects followed from that, both fixed:

- `MODES_2PICK` was `(780,295,180,50)`, entirely below the label — 0.052 on
  frames where it is plainly on screen. `two_pick` therefore never fired and
  `resolve_mode` fell through to the score-system branch, so a 2Pick loss
  replayed as `mode: ranked`.
- `NUMBERS_GRACE` was 5s and was also, incidentally, the whole window in which
  the mode could be established. The label needs 5.5s. Hence
  `timing::MODE_SETTLE`.

## What it could not establish

**The per-match BP gain.** The 2Pick result screen carries two BP figures and
they are not interchangeable: 「獲得BP +N」 is the gain (what the `bp` column
stores), label starting at x1010, y265-292; 「BP N」 below right, around
(1178,303), is the career cumulative. In this recording the user's own HUD sits
directly over the gain, so it cannot be read here. That is a live condition
rather than a recording artefact — the app is running while the user plays.

So there is deliberately no `BP_LAYOUT_2PICK`. A 2Pick match is recorded with
its mode right and its `bp` empty. A recording with the HUD moved off that
corner would finish the job.

## An unrelated finding

The score-system anchor false-positived on the app's own HUD — the 階級對戰
badge — at 0.759 against a 0.7 threshold, on 2 of 85 frames. Two frames were
enough to brand the match, since the signal was taken on a single frame. It is
debounced now; see `Machine::ranked`.

An earlier version of this note claimed the real 「BP 0」 went unmatched because
the `bp` template carries a colon the 2Pick layout does not. That is wrong, and
`2pick-1920-fullscreen-win` disproves it: the 2Pick screen's own 「BP 100」
scores 0.757–0.787 against that template, well over threshold and on nine
consecutive frames. The score-system anchor cannot tell a 2Pick result screen
from a ranked one at all, which is why the ranked signal is only `Strong` and
why the mode is settled on the versus screen instead.
